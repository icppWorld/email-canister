// The DFINITY SMTP Gateway Protocol handlers.
//
// They return an error instead of trapping: a trap would make the sending
// server retry for days. smtp_request only stores the message; parsing happens
// later, in src/ingest.

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

#include "allowlist.h"
#include "api.h"
#include "db.h"
#include "dev_hooks.h"
#include "ic_api.h"
#include "ingest.h"
#include "ingest_limits.h"
#include "mail_store.h"
#include "queue_store.h"
#include "sha256.h"
#include "smtp_request.h"

namespace {

// DFINITY's SMTP gateways
const char *const k_gateway =
    "ttvgm-eefjs-h2pqz-huxqk-ld2c3-rcwbm-a2tik-35hex-pm2jn-l6glo-oae";

const size_t k_max_recipients = 10;
const size_t k_max_headers = 100;
const size_t k_max_header_value = 8 * 1024;
const size_t k_max_local_part = 64;
const size_t k_max_message = 1996800;

std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return s;
}

std::string trim(const std::string &s) {
  const char *const space = " \t\r\n";
  const size_t begin = s.find_first_not_of(space);
  if (begin == std::string::npos) return "";
  return s.substr(begin, s.find_last_not_of(space) - begin + 1);
}

bool caller_allowed(IC_API &ic_api) {
  CandidTypePrincipal caller = ic_api.get_caller();
  return caller.get_text() == k_gateway || ic_api.is_controller(caller);
}

// The domains this canister serves: its own, and the one an admin set
struct Domains {
  std::string self;
  std::string custom;
};

Domains served_domains(IC_API &ic_api) {
  return Domains{ic_api.get_canister_self().get_text() + ".icp0.io",
                 store::domain()};
}

// The mailbox of a recipient on this domain
store::Lookup recipient_mailbox(const Domains &domains, const SmtpAddress &to,
                                int64_t &mailbox) {
  const std::string domain = lower(to.domain);
  if (to.user.size() > k_max_local_part ||
      (domain != domains.self &&
       (domains.custom.empty() || domain != domains.custom))) {
    return store::Lookup::Missing;
  }
  return store::deliverable_mailbox(lower(to.user), mailbox);
}

std::string header_value(const SmtpRequest &request, const std::string &name) {
  for (const SmtpHeader &header : request.headers) {
    if (lower(header.name) == name) return trim(header.value);
  }
  return "";
}

// The message as it was sent. The gateway keeps each header value's leading
// space and line ending, which is what the MIME parser needs to see.
std::vector<uint8_t> raw_message(const SmtpRequest &request) {
  std::string head;
  for (const SmtpHeader &header : request.headers) {
    head += header.name;
    head += ':';
    head += header.value;
    if (header.value.size() < 2 ||
        header.value.compare(header.value.size() - 2, 2, "\r\n") != 0) {
      head += "\r\n";
    }
  }
  head += "\r\n";
  std::vector<uint8_t> raw(head.begin(), head.end());
  raw.insert(raw.end(), request.body.begin(), request.body.end());
  return raw;
}

// The reply while the canister-wide backlog is full, 450 when it cannot be
// counted, or 0. A mailbox whose file cannot be opened is held back by its
// own cap only.
uint16_t backlog_full() {
  const int64_t backlog = store::backlog(static_cast<int64_t>(IC_API::time()));
  if (backlog < 0) return 450;
  return backlog >= ingest_backlog_cap() ? 451 : 0;
}

} // namespace

void smtp_request_validate() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  if (!caller_allowed(ic_api))
    return smtp_reply_err(ic_api, 530, "unauthorized");

  SmtpRequest request;
  std::string err;
  if (!decode_smtp_request(ic_api, request, err)) {
    return smtp_reply_err(ic_api, 451, "malformed request");
  }
  if (!request.has_envelope || request.to.size() != 1) {
    return smtp_reply_err(ic_api, 501, "missing envelope");
  }
  int64_t mailbox = 0;
  switch (recipient_mailbox(served_domains(ic_api), request.to[0], mailbox)) {
  case store::Lookup::Failed:
    return smtp_reply_err(ic_api, 450, "try again later");
  case store::Lookup::Missing:
    return smtp_reply_err(ic_api, 550, "no such mailbox");
  case store::Lookup::Found:
    break;
  }
  // The gateway asks once per recipient, so a full mailbox defers only the
  // mail for it, while the message's other recipients get theirs. A full
  // backlog defers every recipient before the message is sent.
  const int64_t waiting = store::queued(mailbox);
  if (waiting < 0) return smtp_reply_err(ic_api, 450, "try again later");
  if (waiting >= ingest_mailbox_cap())
    return smtp_reply_err(ic_api, 451, "try again later");
  if (const uint16_t code = backlog_full())
    return smtp_reply_err(ic_api, code, "try again later");
  smtp_reply_ok(ic_api);
}

void smtp_request() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  if (!caller_allowed(ic_api))
    return smtp_reply_err(ic_api, 530, "unauthorized");

  SmtpRequest request;
  std::string err;
  if (!decode_smtp_request(ic_api, request, err)) {
    return smtp_reply_err(ic_api, 451, "malformed request");
  }
  if (!request.has_envelope || !request.has_message ||
      !request.has_message_id || request.to.empty()) {
    return smtp_reply_err(ic_api, 501, "missing field");
  }
  size_t size = request.body.size();
  bool too_large = request.to.size() > k_max_recipients ||
                   request.headers.size() > k_max_headers;
  for (const SmtpHeader &header : request.headers) {
    too_large = too_large || header.value.size() > k_max_header_value;
    size += header.name.size() + header.value.size();
  }
  if (too_large || size > k_max_message) {
    return smtp_reply_err(ic_api, 552, "message too large");
  }
  if (const uint16_t code = backlog_full())
    return smtp_reply_err(ic_api, code, "try again later");

  const std::vector<uint8_t> raw = raw_message(request);
  store::IncomingMessage message;
  message.envelope_from = lower(request.from.user + "@" + request.from.domain);
  message.rfc_message_id = header_value(request, "message-id");
  message.dedupe_key = message.rfc_message_id.empty()
                           ? "sha256:" + sha256_hex(raw.data(), raw.size())
                           : "id:" + message.rfc_message_id;
  message.raw = &raw;
  message.received_ns = static_cast<int64_t>(IC_API::time());
  const int64_t dedupe_since = message.received_ns - dedupe_window_ns();

  const Domains domains = served_domains(ic_api);
  db::Transaction transaction(db::control());
  if (!transaction) return smtp_reply_err(ic_api, 450, "try again later");
  size_t delivered = 0;
  bool stored = false;
  int64_t body_id = 0;
  for (const SmtpAddress &to : request.to) {
    // Each reply stops the loop: SQLite may have rolled the transaction back
    // itself, and a later insert would then be kept on its own. A mailbox
    // that filled up since its recipient was validated defers the whole
    // message rather than losing it silently for that recipient; the retry
    // is safe, because redelivery is deduplicated.
    int64_t mailbox = 0;
    switch (recipient_mailbox(domains, to, mailbox)) {
    case store::Lookup::Failed:
      return smtp_reply_err(ic_api, 450, "try again later");
    case store::Lookup::Missing:
      continue;
    case store::Lookup::Found:
      break;
    }
    switch (store::queue_message(mailbox, message, body_id,
                                 ingest_mailbox_cap(), dedupe_since)) {
    case store::Insert::Failed:
      return smtp_reply_err(ic_api, 450, "try again later");
    case store::Insert::Full:
      return smtp_reply_err(ic_api, 451, "try again later");
    case store::Insert::OverQuota:
      // Expired mail may make room before the sender retries. The mark for
      // the pump comes after the rollback, which would undo it.
      transaction.rollback();
      store::clean_soon(mailbox);
      ingest::arm();
      return smtp_reply_err(ic_api, 452, "mailbox full");
    case store::Insert::Stored:
      stored = true;
      ++delivered;
      break;
    case store::Insert::Duplicate: // also a mailbox named twice
      ++delivered;
      break;
    }
  }
  if (delivered == 0) return smtp_reply_err(ic_api, 550, "no such mailbox");
  if (!transaction.commit())
    return smtp_reply_err(ic_api, 450, "try again later");
  if (stored) ingest::arm();
  dev_record_cost(__func__);
  smtp_reply_ok(ic_api);
}
