// Sending mail. The From address is always the address of the mailbox the
// caller sends from, so the request has no field for it; the message records
// which member sent it.

#include <optional>
#include <string>
#include <vector>

#include "allowlist.h"
#include "api.h"
#include "ic_api.h"
#include "ingest_limits.h"
#include "mail_store.h"
#include "outbox.h"
#include "outbox_store.h"
#include "owner.h"

namespace {

const size_t k_max_recipients = 50;
const size_t k_max_attachments = 20;
const size_t k_max_filename = 255;
const size_t k_max_subject = 998; // RFC 5322 line limit
const size_t k_max_client_id = 64;
// The bridge receives this in one call of at most 2 MiB, with Candid overhead,
// and posts it as JSON in an outcall of at most 2,000,000 bytes, with its keys,
// URL and headers
const size_t k_max_encoded_bytes = 1'950'000;
const uint64_t k_max_page = 100;

bool valid_filename(const std::string &name) {
  return !name.empty() && name.size() <= k_max_filename &&
         !store::has_control_character(name) &&
         name.find_first_of("/\\") == std::string::npos;
}

void require_valid(const store::NewOutbox &m) {
  if (m.client_id.empty() || m.client_id.size() > k_max_client_id) {
    IC_API::trap("invalid client_id");
  }
  const size_t recipients = m.to.size() + m.cc.size() + m.bcc.size();
  if (recipients == 0) IC_API::trap("no recipients");
  if (recipients > k_max_recipients) IC_API::trap("too many recipients");
  for (const auto *list : {&m.to, &m.cc, &m.bcc}) {
    for (const std::string &address : *list) {
      if (!store::valid_address(address))
        IC_API::trap("invalid address: " + address);
    }
  }
  if (m.subject.size() > k_max_subject ||
      store::has_control_character(m.subject)) {
    IC_API::trap("invalid subject");
  }
  if (m.attachments.size() > k_max_attachments)
    IC_API::trap("too many attachments");
  for (const store::OutboxAttachment &a : m.attachments) {
    if (!valid_filename(a.filename)) IC_API::trap("invalid attachment name");
  }
  if (store::outbox_encoded_size(m) > k_max_encoded_bytes) {
    IC_API::trap("this message is too large to send");
  }
}

CandidTypeNat64 nat64(int64_t value) {
  return CandidTypeNat64{static_cast<uint64_t>(value)};
}

CandidType summary_value(const store::OutboxSummary &s) {
  CandidTypeRecord r;
  r.append("id", nat64(s.id));
  r.append("state", nat64(s.state));
  r.append("attempts", nat64(s.attempts));
  r.append("created_ns", nat64(s.created_ns));
  r.append("to", CandidTypeVecText{s.to});
  r.append("cc", CandidTypeVecText{s.cc});
  r.append("bcc", CandidTypeVecText{s.bcc});
  r.append("subject", CandidTypeText{s.subject});
  r.append("attachments", nat64(s.attachments));
  r.append("bytes", nat64(s.bytes));
  r.append("last_error", CandidTypeText{s.last_error});
  r.append("sent_by", CandidTypePrincipal{s.sent_by});
  r.append("sent_by_name", CandidTypeOptText{store::name_of(s.sent_by)});
  return r;
}

CandidType attachment_value(const store::OutboxAttachment &a) {
  CandidTypeRecord r;
  r.append("filename", CandidTypeText{a.filename});
  r.append("content", CandidTypeVecNat8{a.content});
  return r;
}

} // namespace

// Repeating a client_id returns the first message, so a browser that lost the
// reply cannot send twice.
void mail_send() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  store::NewOutbox message;
  store::OutboxAttachment attachment;
  CandidTypeRecord in;
  in.append("client_id", CandidTypeText{&message.client_id});
  in.append("to", CandidTypeVecText{&message.to});
  in.append("cc", CandidTypeVecText{&message.cc});
  in.append("bcc", CandidTypeVecText{&message.bcc});
  in.append("subject", CandidTypeText{&message.subject});
  in.append("html_body", CandidTypeText{&message.html_body});
  in.append("attachments",
            CandidTypeVecOf(
                [&]() -> CandidType {
                  attachment = {};
                  CandidTypeRecord r;
                  r.append("filename", CandidTypeText{&attachment.filename});
                  r.append("content", CandidTypeVecNat8{&attachment.content});
                  return r;
                },
                [&]() { message.attachments.push_back(attachment); }));
  const store::Mailbox box = require_writable_file(read_mailbox(ic_api, {in}));
  message.sent_by = ic_api.get_caller().get_text();

  require_valid(message);
  if (store::bridge().empty()) IC_API::trap("sending is not configured");
  const auto now = static_cast<int64_t>(IC_API::time());
  const int64_t since = now - dedupe_window_ns();
  // A retry is answered with the first message, deleted or not, and refused
  // from another of the sender's mailboxes: the first try may have gone out,
  // and a message cannot be recalled
  int64_t id = 0;
  int64_t sent_in = 0;
  std::string sent_local;
  switch (store::sent_from(message.sent_by, message.client_id, since, sent_in,
                           sent_local, id)) {
  case store::Lookup::Found:
    if (sent_in != box.id) {
      IC_API::trap("already queued from " + sent_local + "@" + store::domain() +
                   ", so it may have gone out: a retry from another mailbox "
                   "could send it twice");
    }
    ic_api.to_wire(nat64(id));
    return;
  case store::Lookup::Failed:
    IC_API::trap("the message could not be stored");
  case store::Lookup::Missing:
    break;
  }

  switch (store::outbox_enqueue(box, message, now, id)) {
  case store::Enqueue::Stored:
    if (!store::record_send(message.sent_by, message.client_id, box.id, id, now,
                            since)) {
      IC_API::trap("the message could not be stored");
    }
    outbox::crash_at("after_enqueue");
    outbox::arm();
    break;
  case store::Enqueue::Duplicate:
    break;
  case store::Enqueue::OverQuota:
    IC_API::trap("this mailbox is full");
  case store::Enqueue::Failed:
    IC_API::trap("the message could not be stored");
  }
  ic_api.to_wire(nat64(id));
}

void mail_outbox_list() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  std::optional<uint64_t> cursor;
  uint64_t limit = 0;
  CandidTypeRecord in;
  in.append("cursor", CandidTypeOptNat64{&cursor});
  in.append("limit", CandidTypeNat64{&limit});
  const store::Mailbox box = require_file(read_mailbox(ic_api, {in}));

  std::optional<int64_t> from;
  if (cursor) from = static_cast<int64_t>(*cursor);
  const store::OutboxPage page = store::outbox_list(
      box, from,
      static_cast<int64_t>(limit == 0 || limit > k_max_page ? k_max_page
                                                            : limit));

  std::vector<CandidType> items;
  for (const store::OutboxSummary &s : page.items)
    items.push_back(summary_value(s));
  std::optional<uint64_t> next;
  if (page.cursor) next = static_cast<uint64_t>(*page.cursor);
  CandidTypeRecord r;
  r.append("items",
           CandidTypeVecOf(summary_value(store::OutboxSummary{}), items));
  r.append("cursor", CandidTypeOptNat64{next});
  ic_api.to_wire(r);
}

void mail_outbox_get() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  uint64_t id = 0;
  const store::Mailbox box =
      require_file(read_mailbox(ic_api, {CandidTypeNat64{&id}}));
  store::OutboxSummary summary;
  std::string html;
  std::vector<store::OutboxAttachment> attachments;
  if (!store::outbox_get(box, static_cast<int64_t>(id), summary, html,
                         attachments)) {
    IC_API::trap("no such message");
  }
  std::vector<CandidType> files;
  for (const store::OutboxAttachment &a : attachments) {
    files.push_back(attachment_value(a));
  }
  CandidTypeRecord r;
  r.append("summary", summary_value(summary));
  r.append("html_body", CandidTypeText{html});
  r.append("attachments", CandidTypeVecOf(attachment_value({}), files));
  ic_api.to_wire(r);
}

// The owner's decision to try again. It is a new send to the bridge, so mail
// whose outcome is unknown can arrive twice: the webmail must say so.
void mail_outbox_resend() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  uint64_t id = 0;
  const store::Mailbox box =
      require_writable_file(read_mailbox(ic_api, {CandidTypeNat64{&id}}));
  const std::string refused = store::outbox_resend(
      box, static_cast<int64_t>(id), static_cast<int64_t>(IC_API::time()));
  if (!refused.empty()) IC_API::trap(refused);
  outbox::arm();
  ic_api.to_wire();
}

void mail_outbox_delete() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  uint64_t id = 0;
  const store::Mailbox box =
      require_writable_file(read_mailbox(ic_api, {CandidTypeNat64{&id}}));
  const std::string refused =
      store::outbox_delete(box, static_cast<int64_t>(id));
  if (!refused.empty()) IC_API::trap(refused);
  ic_api.to_wire();
}

// Deletes the messages in one write, and returns the ids deleted; one that is
// being sent, or is not there, is skipped
void mail_outbox_delete_many() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  std::vector<uint64_t> ids;
  const store::Mailbox box =
      require_writable_file(read_mailbox(ic_api, {CandidTypeVecNat64{&ids}}));
  require_batch(ids);
  std::vector<uint64_t> deleted;
  if (!store::outbox_delete_many(box, ids, deleted))
    IC_API::trap("the delete failed");
  ic_api.to_wire(CandidTypeVecNat64{deleted});
}
