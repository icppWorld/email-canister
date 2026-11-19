// Behaves like the relay bridge's relaySend: a repeated outboxId
// reports the first outcome and sends nothing. The modes add the failures the
// real bridge can only show by accident.

#include "relay_stub.h"

#include <map>
#include <string>
#include <vector>

#include "ic_api.h"
#include "ic_async.h"

namespace {

struct Attachment {
  std::string filename;
  std::string base64;
};

struct Status {
  std::string kind;
  std::string detail;
};

std::string g_mode = "sent";
std::map<std::string, Status> g_results;
std::map<std::string, uint64_t> g_sends;
uint64_t g_calls = 0;
uint64_t g_total_sends = 0;
std::string g_last_from, g_last_key, g_last_subject, g_last_attachment;
std::vector<std::string> g_last_to;

void reply_status(IC_API &ic_api, const Status &status) {
  if (status.kind == "sending") {
    ic_api.to_wire(CandidTypeVariant{"sending", CandidTypeInt{__int128_t{1}}});
  } else if (status.kind == "sent") {
    ic_api.to_wire(CandidTypeVariant{"sent"});
  } else {
    ic_api.to_wire(
        CandidTypeVariant{status.kind, CandidTypeText{status.detail}});
  }
}

void count_send(const std::string &key) {
  ++g_sends[key];
  ++g_total_sends;
}

IC_Async relay_send_async() {
  IC_API ic_api(CanisterUpdate{"relaySend"}, false);
  std::string key, from, subject, html;
  std::vector<std::string> to, cc, bcc;
  std::vector<Attachment> attachments;
  Attachment attachment;
  CandidTypeRecord in;
  in.append("outboxId", CandidTypeText{&key});
  in.append("fromUsername", CandidTypeText{&from});
  in.append("to", CandidTypeVecText{&to});
  in.append("cc", CandidTypeVecText{&cc});
  in.append("bcc", CandidTypeVecText{&bcc});
  in.append("subject", CandidTypeText{&subject});
  in.append("htmlBody", CandidTypeText{&html});
  in.append("attachments",
            CandidTypeVecOf(
                [&]() -> CandidType {
                  attachment = {};
                  CandidTypeRecord r;
                  r.append("filename", CandidTypeText{&attachment.filename});
                  r.append("base64", CandidTypeText{&attachment.base64});
                  return r;
                },
                [&]() { attachments.push_back(attachment); }));
  ic_api.from_wire(in);

  if (g_mode == "trap") IC_API::trap("the bridge is out of cycles");

  ++g_calls;
  g_last_key = key;
  g_last_from = from;
  g_last_to = to;
  g_last_subject = subject;
  g_last_attachment = attachments.empty() ? "" : attachments[0].base64;

  if (g_mode == "garbage") {
    // A reply that is not a RelayStatus; nothing was sent
    ic_api.to_wire(CandidTypeText{std::string("not a RelayStatus")});
    co_return;
  }

  const auto seen = g_results.find(key);
  if (seen != g_results.end()) {
    reply_status(ic_api, seen->second);
    co_return;
  }

  if (g_mode == "rejected") {
    g_results[key] = {"rejected", "HTTP 400: bad request"};
  } else if (g_mode == "unknown") {
    count_send(key);
    g_results[key] = {"unknown", "HTTP 500"};
  } else if (g_mode == "sending") {
    count_send(key);
    g_results[key] = {"sending", ""};
  } else {
    count_send(key);
    g_results[key] = {"sent", ""};
  }

  if (g_mode == "drop") {
    // The mail went out, and the caller never learns: the state above commits
    // at this await, and the trap below turns the reply into a reject
    IC_CallResult<IC_CallReply> committed = co_await IC_Call::unbounded_wait(
        ic_api.get_canister_self(), "stub_commit");
    (void)committed;
    IC_API::trap("the reply was lost");
  }
  reply_status(ic_api, g_results[key]);
}

} // namespace

void relaySend() { relay_send_async(); }

void stub_commit() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  ic_api.from_wire();
  ic_api.to_wire();
}

void stub_set_mode() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  ic_api.from_wire(CandidTypeText{&g_mode});
  ic_api.to_wire();
}

void stub_finish() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  std::string kind;
  ic_api.from_wire(CandidTypeText{&kind});
  for (auto &[key, status] : g_results) {
    if (status.kind == "sending") status = {kind, "finished by the test"};
  }
  ic_api.to_wire();
}

void stub_reset() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  ic_api.from_wire();
  g_mode = "sent";
  g_results.clear();
  g_sends.clear();
  g_calls = 0;
  g_total_sends = 0;
  g_last_from = g_last_key = g_last_subject = g_last_attachment = "";
  g_last_to.clear();
  ic_api.to_wire();
}

void stub_stats() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  uint64_t max_sends = 0;
  for (const auto &[key, sends] : g_sends) {
    if (sends > max_sends) max_sends = sends;
  }
  CandidTypeRecord r;
  r.append("calls", CandidTypeNat64{g_calls});
  r.append("sends", CandidTypeNat64{g_total_sends});
  r.append("max_sends_per_key", CandidTypeNat64{max_sends});
  r.append("last_from", CandidTypeText{g_last_from});
  r.append("last_key", CandidTypeText{g_last_key});
  r.append("last_to", CandidTypeVecText{g_last_to});
  r.append("last_subject", CandidTypeText{g_last_subject});
  r.append("last_attachment", CandidTypeText{g_last_attachment});
  ic_api.to_wire(r);
}
