#include "outbox.h"

#include <algorithm>
#include <vector>

#include "api.h"
#include "candid_decoder.h"
#include "candid_type_graph.h"
#include "candid_value.h"
#include "ic_api.h"
#include "ic_async.h"
#include "outbox_store.h"

namespace {

// Retrying within the bridge's replay window is what makes a retry safe to
// call a retry; past it, the owner decides
uint64_t g_retry_ns = 60'000'000'000;
uint64_t g_deadline_ns = 900'000'000'000;
// Well inside the 7 days the bridge keeps a result
uint64_t g_abandon_ns = 86'400'000'000'000;

std::string g_self;
bool g_timer_set = false;
uint64_t g_timer_id = 0;
uint64_t g_timer_at = 0;

#ifdef EMAIL_CANISTER_TEST_HOOKS
std::string g_crash_point;
#endif

void arm_at(uint64_t at_ns);

void on_timer() {
  g_timer_set = false;
  IC_CallResult<void> sent =
      IC_Call::bounded_wait(CandidTypePrincipal{g_self}, "outbox_pump")
          .oneway();
  (void)sent; // the watchdog below retries
  // A pump can trap or never run: without this, nothing would wake the queue
  int64_t due = 0;
  if (store::outbox_next_due(due)) arm_at(IC_API::time() + g_retry_ns);
}

void arm_at(uint64_t at_ns) {
  if (g_timer_set) {
    if (g_timer_at <= at_ns) return;
    IC_API::cancel_timer(g_timer_id);
  }
  const uint64_t now = IC_API::time();
  g_timer_id = IC_API::set_timer(at_ns > now ? at_ns - now : 0, on_timer);
  g_timer_at = at_ns;
  g_timer_set = true;
}

uint32_t field_id(const char *name) {
  uint32_t h = 0;
  for (; *name != '\0'; ++name)
    h = h * 223 + static_cast<uint8_t>(*name);
  return h;
}

// Never traps: a reply that cannot be read counts as a retry
store::Outcome read_status(const VecBytes &reply, std::string &detail) {
  CandidGraphNode node;
  node.kind = CandidKind::Variant;
  const int text = CandidTypeGraph::prim(CandidKind::Text);
  node.fields = {{field_id("sending"), CandidTypeGraph::prim(CandidKind::Int)},
                 {field_id("sent"), CandidTypeGraph::prim(CandidKind::Null)},
                 {field_id("rejected"), text},
                 {field_id("unknown"), text}};
  std::sort(node.fields.begin(), node.fields.end(),
            [](const CandidGraphField &a, const CandidGraphField &b) {
              return a.id < b.id;
            });
  CandidTypeGraph graph;
  const std::vector<int> args{graph.add(std::move(node))};
  std::vector<CandidValue> values;
  const std::vector<uint8_t> &bytes = reply.vec_uint8_t();
  if (!CandidDecoder::decode(bytes.data(), bytes.size(), graph, args, values,
                             detail)) {
    return store::Outcome::Retry;
  }
  const uint32_t label = values[0].ids[0];
  detail = label == field_id("sending") ? "the bridge is still sending"
                                        : values[0].items[0].text;
  if (label == field_id("sent")) return store::Outcome::Sent;
  if (label == field_id("rejected")) return store::Outcome::Rejected;
  if (label == field_id("unknown")) return store::Outcome::Unknown;
  return store::Outcome::Retry;
}

CandidType attachment_value(const std::string &filename,
                            const std::string &content) {
  CandidTypeRecord r;
  r.append("filename", CandidTypeText{filename});
  r.append("base64", CandidTypeText{content});
  return r;
}

CandidType request_value(const store::OutboxRequest &request) {
  std::vector<CandidType> attachments;
  for (const auto &[filename, content] : request.attachments) {
    attachments.push_back(attachment_value(filename, content));
  }
  CandidTypeRecord r;
  r.append("outboxId", CandidTypeText{request.key});
  r.append("fromUsername", CandidTypeText{request.from_username});
  r.append("to", CandidTypeVecText{request.to});
  r.append("cc", CandidTypeVecText{request.cc});
  r.append("bcc", CandidTypeVecText{request.bcc});
  r.append("subject", CandidTypeText{request.subject});
  r.append("htmlBody", CandidTypeText{request.html_body});
  r.append("attachments",
           CandidTypeVecOf(attachment_value("", ""), attachments));
  return r;
}

IC_Async outbox_pump_async() {
  IC_API ic_api(CanisterUpdate{"outbox_pump"}, false);
  if (ic_api.get_caller().get_text() != g_self) {
    IC_API::trap("only this canister can call this method");
  }
  ic_api.from_wire();

  store::OutboxRequest request;
  const store::Claim claim = store::outbox_claim(
      static_cast<int64_t>(IC_API::time()), static_cast<int64_t>(g_retry_ns),
      static_cast<int64_t>(g_abandon_ns), request);
  if (claim != store::Claim::Claimed) {
    // Retried at once, a failure would repeat again and again. Deferring the
    // failed mailbox lets the others go first.
    const uint64_t retry_at = IC_API::time() + g_retry_ns;
    if (claim == store::Claim::Failed &&
        (request.mailbox == 0 ||
         !store::outbox_defer(request.mailbox,
                              static_cast<int64_t>(retry_at)))) {
      arm_at(retry_at);
    } else {
      outbox::arm();
    }
    ic_api.to_wire();
    co_return;
  }
  outbox::crash_at("before_call");

  // unbounded_wait: a subnet short of memory for best-effort messages drops
  // the largest first, so a large bounded call is the more likely to end in
  // SysUnknown, with no way to know whether it ran. The bridge is the
  // domain's own app, set by the admin, so it is trusted. The claim is
  // committed here: from now on the message counts as possibly sent.
  store::Outcome outcome = store::Outcome::Retry;
  std::string detail;
  const std::string bridge = store::bridge();
  if (bridge.empty()) {
    detail = "no bridge is configured";
  } else {
    IC_CallResult<IC_CallReply> result =
        co_await IC_Call::unbounded_wait(CandidTypePrincipal{bridge},
                                         "relaySend", IC_TrustedCallee{})
            .with_arg(request_value(request));
    outbox::crash_at("after_call");
    if (result) {
      outcome = read_status(result->bytes, detail);
    } else {
      detail = result.error().to_string();
    }
  }
  store::outbox_apply(request, outcome, detail,
                      static_cast<int64_t>(IC_API::time()),
                      static_cast<int64_t>(g_deadline_ns));
  outbox::arm();
  ic_api.to_wire();
}

} // namespace

void outbox_pump() { outbox_pump_async(); }

namespace outbox {

void start(const std::string &canister_self) {
  g_self = canister_self;
  arm();
}

void crash_at([[maybe_unused]] const char *point) {
#ifdef EMAIL_CANISTER_TEST_HOOKS
  if (g_crash_point == point) IC_API::trap("test hook: crash");
#endif
}

void arm() {
  int64_t due = 0;
  if (store::outbox_next_due(due)) arm_at(static_cast<uint64_t>(due));
}

#ifdef EMAIL_CANISTER_TEST_HOOKS
void set_timing(uint64_t retry_ns, uint64_t deadline_ns, uint64_t abandon_ns) {
  g_retry_ns = retry_ns;
  g_deadline_ns = deadline_ns;
  g_abandon_ns = abandon_ns;
}

void set_crash_point(const std::string &point) { g_crash_point = point; }
#endif

} // namespace outbox
