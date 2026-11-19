// The owner's view of a mailbox (see owner.h)

#include <optional>
#include <string>
#include <vector>

#include "allowlist.h"
#include "api.h"
#include "ic_api.h"
#include "mail_store.h"
#include "owner.h"

namespace {

const uint64_t k_max_page = 100;
const size_t k_max_delete = 200;

CandidTypeNat64 nat64(int64_t value) {
  return CandidTypeNat64{static_cast<uint64_t>(value)};
}

CandidType summary_value(const store::Summary &s) {
  CandidTypeRecord r;
  r.append("uid", nat64(s.uid));
  r.append("state", nat64(s.state));
  r.append("flags", nat64(s.flags));
  r.append("modseq", nat64(s.modseq));
  r.append("received_ns", nat64(s.received_ns));
  r.append("sent_at", nat64(s.sent_at));
  r.append("envelope_from", CandidTypeText{s.envelope_from});
  r.append("subject", CandidTypeText{s.subject});
  r.append("sender", CandidTypeText{s.sender});
  r.append("attachments", nat64(s.attachments));
  r.append("preview", CandidTypeText{s.preview});
  r.append("raw_bytes", nat64(s.raw_bytes));
  return r;
}

void reply_page(IC_API &ic_api, const store::Page &page) {
  std::vector<CandidType> elements;
  for (const store::Summary &s : page.items)
    elements.push_back(summary_value(s));
  std::optional<uint64_t> cursor;
  if (page.cursor) cursor = static_cast<uint64_t>(*page.cursor);
  CandidTypeRecord r;
  r.append("items", CandidTypeVecOf(summary_value(store::Summary{}), elements));
  r.append("cursor", CandidTypeOptNat64{cursor});
  ic_api.to_wire(r);
}

int64_t page_limit(uint64_t limit) {
  return static_cast<int64_t>(limit == 0 || limit > k_max_page ? k_max_page
                                                               : limit);
}

std::optional<int64_t> to_cursor(const std::optional<uint64_t> &cursor) {
  if (!cursor) return std::nullopt;
  return static_cast<int64_t>(*cursor);
}

CandidType seen_value(const std::string &principal,
                      const std::optional<std::string> &name, int64_t at_ns) {
  CandidTypeRecord r;
  r.append("principal", CandidTypePrincipal{principal});
  r.append("name", CandidTypeOptText{name});
  r.append("at_ns", nat64(at_ns));
  return r;
}

CandidType mailbox_value(const store::Entry &e, const std::string &domain) {
  CandidTypeRecord r;
  r.append("local", CandidTypeText{e.local});
  r.append("address", CandidTypeText{e.local + "@" + domain});
  r.append("members", nat64(e.members));
  r.append("message_count", nat64(e.message_count));
  r.append("unseen", nat64(e.unseen));
  r.append("used_bytes", nat64(e.used_bytes));
  r.append("quota_bytes", nat64(e.quota_bytes));
  r.append("uidvalidity", nat64(e.uidvalidity));
  return r;
}

} // namespace

// Open to everyone: this is how a new user learns the principal to hand over,
// and a member which mailboxes they have
void mail_me() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  const std::string caller = ic_api.get_caller().get_text();
  std::string domain = store::domain();
  if (domain.empty())
    domain = ic_api.get_canister_self().get_text() + ".icp0.io";
  std::vector<CandidType> mailboxes;
  for (const store::Entry &e : store::member_mailboxes(caller))
    mailboxes.push_back(mailbox_value(e, domain));
  CandidTypeRecord r;
  r.append("principal", CandidTypePrincipal{caller});
  r.append("name", CandidTypeOptText{store::name_of(caller)});
  r.append("is_controller",
           CandidTypeBool{ic_api.is_controller(ic_api.get_caller())});
  r.append("mailboxes",
           CandidTypeVecOf(mailbox_value(store::Entry{}, ""), mailboxes));
  ic_api.to_wire(r);
}

void mail_list() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  std::optional<uint64_t> cursor;
  uint64_t limit = 0;
  CandidTypeRecord in;
  in.append("cursor", CandidTypeOptNat64{&cursor});
  in.append("limit", CandidTypeNat64{&limit});
  const store::Mailbox box = require_file(read_mailbox(ic_api, {in}));
  reply_page(ic_api,
             store::list_messages(box, to_cursor(cursor), page_limit(limit)));
}

void mail_get() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  uint64_t uid = 0;
  const store::Mailbox box =
      require_file(read_mailbox(ic_api, {CandidTypeNat64{&uid}}));
  store::Summary summary;
  std::vector<uint8_t> raw;
  if (!store::get_message(box, static_cast<int64_t>(uid), summary, raw)) {
    IC_API::trap("no such message");
  }
  std::vector<CandidType> seen;
  for (const store::SeenBy &s : store::seen_by(box, static_cast<int64_t>(uid)))
    seen.push_back(
        seen_value(s.principal, store::name_of(s.principal), s.at_ns));
  CandidTypeRecord r;
  r.append("summary", summary_value(summary));
  r.append("raw", CandidTypeVecNat8{raw});
  r.append("seen_by", CandidTypeVecOf(seen_value("", std::nullopt, 0), seen));
  ic_api.to_wire(r);
}

void mail_search() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  std::string query;
  std::optional<uint64_t> cursor;
  uint64_t limit = 0;
  CandidTypeRecord in;
  in.append("query", CandidTypeText{&query});
  in.append("cursor", CandidTypeOptNat64{&cursor});
  in.append("limit", CandidTypeNat64{&limit});
  const store::Mailbox box = require_file(read_mailbox(ic_api, {in}));
  reply_page(ic_api,
             store::search(box, query, to_cursor(cursor), page_limit(limit)));
}

// Sets the flags in `set` and clears those in `clear`. Setting the seen flag
// records that the caller opened the message, so a reader sets it on every
// open.
void mail_set_flags() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  uint64_t uid = 0;
  uint64_t set = 0;
  uint64_t clear = 0;
  const store::Mailbox box = require_writable_file(
      read_mailbox(ic_api, {CandidTypeNat64{&uid}, CandidTypeNat64{&set},
                            CandidTypeNat64{&clear}}));
  if ((set | clear) & ~static_cast<uint64_t>(store::Seen | store::Flagged)) {
    IC_API::trap("unknown flag");
  }
  // Which one would win is not obvious, and a seen mark records who opened it
  if (set & clear) IC_API::trap("a flag both set and cleared");
  if (!store::set_flags(box, static_cast<int64_t>(uid),
                        static_cast<int64_t>(set), static_cast<int64_t>(clear),
                        ic_api.get_caller().get_text(),
                        static_cast<int64_t>(IC_API::time()))) {
    IC_API::trap("no such message");
  }
  ic_api.to_wire();
}

// Returns how many messages were deleted. Deletion is permanent.
void mail_delete() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  std::vector<uint64_t> uids;
  const store::Mailbox box =
      require_writable_file(read_mailbox(ic_api, {CandidTypeVecNat64{&uids}}));
  if (uids.size() > k_max_delete) IC_API::trap("too many messages at once");
  const int64_t deleted = store::delete_messages(box, uids);
  if (deleted < 0) IC_API::trap("the delete failed");
  ic_api.to_wire(nat64(deleted));
}
