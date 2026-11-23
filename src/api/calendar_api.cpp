// A mailbox's calendar (see calendar_store.h), and its feed over HTTP: an
// iCalendar file at /cal/<token>.ics that calendar apps subscribe to. The
// token is the only secret, so anyone who has the address reads the calendar.

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "allowlist.h"
#include "api.h"
#include "calendar_store.h"
#include "ic_api.h"
#include "ic_async.h"
#include "ic_management.h"
#include "mail_store.h"
#include "owner.h"

namespace {

const uint64_t k_max_page = 200;
const size_t k_page_bytes = 1'500'000; // under the 2 MB reply of a query
const size_t k_token_bytes = 16;

CandidType event_value(const store::Event &e) {
  CandidTypeRecord r;
  r.append("uid", CandidTypeText{e.uid});
  r.append("vevent", CandidTypeText{e.vevent});
  r.append("starts", nat64(e.starts));
  r.append("ends", nat64(e.ends));
  r.append("modified_ns", nat64(e.modified_ns));
  return r;
}

int64_t seconds(uint64_t value) {
  // Keeps a far-ahead end inside SQLite's integers
  const uint64_t max = static_cast<uint64_t>(INT64_MAX);
  return static_cast<int64_t>(value > max ? max : value);
}

// The token in "/cal/<token>.ics", where a token is lower-case hex, or empty
std::string token_of(const std::string &url) {
  std::string_view path(url);
  path = path.substr(0, path.find('?'));
  const std::string_view prefix = "/cal/";
  const std::string_view suffix = ".ics";
  if (path.size() != prefix.size() + 2 * k_token_bytes + suffix.size() ||
      path.substr(0, prefix.size()) != prefix ||
      path.substr(path.size() - suffix.size()) != suffix) {
    return "";
  }
  const std::string_view token = path.substr(prefix.size(), 2 * k_token_bytes);
  for (char c : token) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return "";
  }
  return std::string(token);
}

IC_HttpResponse plain(uint16_t status, const std::string &text) {
  IC_HttpResponse response;
  response.status_code = status;
  response.headers = {{"Content-Type", "text/plain; charset=utf-8"}};
  response.body.assign(text.begin(), text.end());
  return response;
}

std::string hex(const std::vector<uint8_t> &bytes, size_t count) {
  static const char digits[] = "0123456789abcdef";
  std::string out;
  for (size_t i = 0; i < count && i < bytes.size(); ++i) {
    out.push_back(digits[bytes[i] >> 4]);
    out.push_back(digits[bytes[i] & 15]);
  }
  return out;
}

// Gives the calendar a new secret address; any earlier one stops working
IC_Async feed_reset_async() {
  IC_API ic_api(CanisterUpdate{"mail_cal_feed_reset"}, false);
  std::string local;
  ic_api.from_wire(CandidTypeText{&local});
  require_writable_file(require_mailbox(ic_api, local));
  IC_CallResult<IC_Blob> random = co_await IC_Management::raw_rand();
  if (!random || random->size() < k_token_bytes)
    IC_API::trap("no randomness for the address, try again");
  // The call above let other calls run: the caller's membership and the file
  // are read again
  const store::Mailbox box =
      require_writable_file(require_mailbox(ic_api, local));
  const std::string token = hex(*random, k_token_bytes);
  if (!store::set_feed_token(box.id, token))
    IC_API::trap("the address could not be stored");
  ic_api.to_wire(CandidTypeText{token});
}

} // namespace

// The events overlapping a window, in UTC seconds: [from, to)
void mail_cal_list() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  uint64_t from = 0;
  uint64_t to = 0;
  std::optional<uint64_t> cursor;
  uint64_t limit = 0;
  CandidTypeRecord in;
  in.append("from", CandidTypeNat64{&from});
  in.append("to", CandidTypeNat64{&to});
  in.append("cursor", CandidTypeOptNat64{&cursor});
  in.append("limit", CandidTypeNat64{&limit});
  const store::Mailbox box = require_file(read_mailbox(ic_api, {in}));
  std::optional<int64_t> after;
  if (cursor) after = seconds(*cursor);
  const auto page =
      store::list_events(box, seconds(from), seconds(to), after,
                         page_limit(limit, k_max_page), k_page_bytes);
  if (!page) IC_API::trap("the calendar cannot be read");
  std::vector<CandidType> items;
  for (const store::Event &e : page->items)
    items.push_back(event_value(e));
  std::optional<uint64_t> next;
  if (page->cursor) next = static_cast<uint64_t>(*page->cursor);
  CandidTypeRecord r;
  r.append("items", CandidTypeVecOf(event_value(store::Event{}), items));
  r.append("cursor", CandidTypeOptNat64{next});
  ic_api.to_wire(r);
}

// Adds or replaces an event, by its uid
void mail_cal_put() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  store::Event event;
  uint64_t starts = 0;
  uint64_t ends = 0;
  store::TimeZone zone;
  std::vector<store::TimeZone> zones;
  CandidTypeRecord in;
  in.append("uid", CandidTypeText{&event.uid});
  in.append("vevent", CandidTypeText{&event.vevent});
  in.append("starts", CandidTypeNat64{&starts});
  in.append("ends", CandidTypeNat64{&ends});
  in.append("vtimezones", CandidTypeVecOf(
                              [&]() -> CandidType {
                                zone = {};
                                CandidTypeRecord r;
                                r.append("tzid", CandidTypeText{&zone.tzid});
                                r.append("block", CandidTypeText{&zone.block});
                                return r;
                              },
                              [&]() { zones.push_back(zone); }));
  const store::Mailbox box = require_writable_file(read_mailbox(ic_api, {in}));
  event.starts = seconds(starts);
  event.ends = seconds(ends);
  event.modified_ns = static_cast<int64_t>(IC_API::time());
  const std::optional<std::string> refused =
      store::put_event(box, event, zones);
  if (!refused) IC_API::trap("the event could not be stored");
  if (!refused->empty()) IC_API::trap(*refused);
  ic_api.to_wire();
}

// Replies whether there was such an event
void mail_cal_delete() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  std::string uid;
  const store::Mailbox box =
      require_writable_file(read_mailbox(ic_api, {CandidTypeText{&uid}}));
  const std::optional<bool> deleted = store::delete_event(box, uid);
  if (!deleted) IC_API::trap("the delete failed");
  ic_api.to_wire(CandidTypeBool{*deleted});
}

// The token of the calendar's secret address, or null while it is not shared
void mail_cal_feed() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  const store::Entry entry = read_mailbox(ic_api, {});
  const std::optional<std::string> token = store::feed_token(entry.id);
  if (!token) IC_API::trap("the calendar cannot be read");
  std::optional<std::string> shared;
  if (!token->empty()) shared = *token;
  ic_api.to_wire(CandidTypeOptText{shared});
}

void mail_cal_feed_reset() { feed_reset_async(); }

// Stops sharing the calendar: its address stops working
void mail_cal_feed_stop() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  const store::Mailbox box = require_writable_file(read_mailbox(ic_api, {}));
  if (!store::set_feed_token(box.id, ""))
    IC_API::trap("the address could not be removed");
  ic_api.to_wire();
}

// A query reply is not certified, so the feed is served by the update call
// the gateway makes when it is told to upgrade. Only a known address is
// upgraded, so that a stranger's guesses cost no update calls.
void http_request() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  IC_HttpRequest request;
  ic_api.from_wire(request);
  const std::string token = token_of(request.url);
  int64_t id = 0;
  std::string local;
  if (token.empty() ||
      store::feed_mailbox(token, id, local) != store::Lookup::Found) {
    ic_api.to_wire(plain(404, "Not found\n"));
    return;
  }
  if (request.method != "GET" && request.method != "HEAD") {
    IC_HttpResponse response = plain(405, "Method not allowed\n");
    response.headers.push_back({"Allow", "GET, HEAD"});
    ic_api.to_wire(response);
    return;
  }
  IC_HttpResponse response;
  response.upgrade = true;
  ic_api.to_wire(response);
}

void http_request_update() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  IC_HttpUpdateRequest request;
  ic_api.from_wire(request);
  const std::string token = token_of(request.url);
  int64_t id = 0;
  std::string local;
  const store::Lookup found = token.empty()
                                  ? store::Lookup::Missing
                                  : store::feed_mailbox(token, id, local);
  if (found == store::Lookup::Missing) {
    ic_api.to_wire(plain(404, "Not found\n"));
    return;
  }
  std::optional<std::string> body;
  if (found == store::Lookup::Found) {
    if (sqlite3 *file = store::mailbox_file(id))
      body = store::feed(file, local + "@" + mail_domain(ic_api),
                         static_cast<int64_t>(IC_API::time() / 1'000'000'000));
  }
  if (!body) {
    IC_HttpResponse response = plain(503, "Try again later\n");
    response.headers.push_back({"Retry-After", "60"});
    ic_api.to_wire(response);
    return;
  }
  IC_HttpResponse response;
  response.headers = {
      {"Content-Type", "text/calendar; charset=utf-8"},
      {"Cache-Control", "no-cache"},
      // Another deployment's webmail reads it from the browser
      {"Access-Control-Allow-Origin", "*"},
  };
  if (request.method != "HEAD")
    response.body.assign(body->begin(), body->end());
  ic_api.to_wire(response);
}
