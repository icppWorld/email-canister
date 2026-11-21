// Controllers only. These methods never return message data.

#include <algorithm>
#include <cctype>
#include <limits>
#include <optional>
#include <string>

#include "allowlist.h"
#include "api.h"
#include "db.h"
#include "dev_hooks.h"
#include "ic_api.h"
#include "ingest.h"
#include "ingest_limits.h"
#include "mail_store.h"
#include "outbox.h"
#include "outbox_store.h"
#include "owner.h"
#include "queue_store.h"

namespace {

int64_t g_mailbox_cap = 100;
int64_t g_backlog_cap = 1000;
int64_t g_dedupe_window_ns = 7LL * 24 * 3600 * 1'000'000'000;
const uint64_t k_default_quota_bytes = 2ULL * 1024 * 1024 * 1024;
// The store keeps a quota as a signed 64-bit number
const uint64_t k_max_quota_bytes = std::numeric_limits<int64_t>::max();

void require_controller(IC_API &ic_api) {
  CandidTypePrincipal caller = ic_api.get_caller();
  if (!ic_api.is_controller(caller)) IC_API::trap("controllers only");
}

} // namespace

int64_t ingest_mailbox_cap() { return g_mailbox_cap; }
int64_t ingest_backlog_cap() { return g_backlog_cap; }
int64_t dedupe_window_ns() { return g_dedupe_window_ns; }

void admin_set_domain() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string domain;
  ic_api.from_wire(CandidTypeText{&domain});
  if (!store::set_domain(lower(domain)))
    IC_API::trap("could not store the domain");
  ic_api.to_wire();
}

void admin_set_bridge() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string bridge;
  ic_api.from_wire(CandidTypePrincipal{&bridge});
  if (!store::set_bridge(bridge)) IC_API::trap("could not store the bridge");
  ic_api.to_wire();
}

void admin_settings() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  require_controller(ic_api);
  const std::string bridge = store::bridge();
  CandidTypeRecord r;
  r.append("domain", CandidTypeText{store::domain()});
  r.append("bridge", CandidTypeOptPrincipal{
                         bridge.empty() ? std::nullopt
                                        : std::optional<std::string>{bridge}});
  ic_api.to_wire(r);
}

void admin_create_mailbox() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  std::optional<uint64_t> quota;
  std::optional<std::string> first;
  CandidTypeRecord mailbox;
  mailbox.append("local", CandidTypeText{&local});
  mailbox.append("quota_bytes", CandidTypeOptNat64{&quota});
  mailbox.append("first_member", CandidTypeOptPrincipal{&first});
  ic_api.from_wire(mailbox);
  if (quota.value_or(0) > k_max_quota_bytes) IC_API::trap("quota too large");
  // Checked before anything is created, so a refused first member leaves no
  // mailbox: creating one never needs a second call that could add someone
  // to a mailbox that exists
  if (first) {
    const std::string refused = store::refuse_member(*first);
    if (!refused.empty()) IC_API::trap(refused);
  }
  const std::string refused = store::create_mailbox(
      lower(local), static_cast<int64_t>(quota.value_or(k_default_quota_bytes)),
      static_cast<int64_t>(IC_API::time() / 1'000'000'000));
  if (!refused.empty()) IC_API::trap(refused);
  if (first) {
    // On a new mailbox only a failed write refuses it; the trap undoes the
    // creation
    const std::string not_added = store::add_member(
        lower(local), *first, static_cast<int64_t>(IC_API::time()));
    if (!not_added.empty()) IC_API::trap(not_added);
  }
  ic_api.to_wire();
}

void admin_add_member() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  std::string principal;
  std::optional<uint64_t> uidvalidity;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  args.append(CandidTypePrincipal{&principal});
  args.append(CandidTypeOptNat64{&uidvalidity});
  ic_api.from_wire(args);
  std::optional<int64_t> listed;
  if (uidvalidity) listed = static_cast<int64_t>(*uidvalidity);
  const std::string refused = store::add_member(
      lower(local), principal, static_cast<int64_t>(IC_API::time()), listed);
  if (!refused.empty()) IC_API::trap(refused);
  ic_api.to_wire();
}

// Takes effect at the member's next call
void admin_remove_member() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  std::string principal;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  args.append(CandidTypePrincipal{&principal});
  ic_api.from_wire(args);
  const std::string refused = store::remove_member(lower(local), principal);
  if (!refused.empty()) IC_API::trap(refused);
  // A download the member held has ended: what it held back moves at once
  ingest::arm();
  outbox::arm();
  ic_api.to_wire();
}

// The name the members of a mailbox see for a principal; "" removes it
void admin_set_name() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string principal;
  std::string name;
  CandidArgs args;
  args.append(CandidTypePrincipal{&principal});
  args.append(CandidTypeText{&name});
  ic_api.from_wire(args);
  const std::string refused = store::set_name(principal, name);
  if (!refused.empty()) IC_API::trap(refused);
  ic_api.to_wire();
}

void admin_set_disabled() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  bool disabled = false;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  args.append(CandidTypeBool{&disabled});
  ic_api.from_wire(args);
  const std::string refused = store::set_disabled(lower(local), disabled);
  if (!refused.empty()) IC_API::trap(refused);
  outbox::arm(); // mail queued while it was disabled
  ic_api.to_wire();
}

void admin_set_quota() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  uint64_t quota = 0;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  args.append(CandidTypeNat64{&quota});
  ic_api.from_wire(args);
  if (quota > k_max_quota_bytes) IC_API::trap("quota too large");
  if (!store::set_quota(lower(local), static_cast<int64_t>(quota))) {
    IC_API::trap("no such entry");
  }
  ic_api.to_wire();
}

// Call until remaining is 0: each call shortens the mailbox's file by a step
void admin_purge() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  ic_api.from_wire(CandidTypeText{&local});
  store::Entry entry;
  if (!store::find_entry(lower(local), entry)) IC_API::trap("no such entry");
  if (!entry.disabled) IC_API::trap("disable the entry before purging it");
  const int64_t remaining = store::purge_step(entry.id);
  if (remaining < 0) IC_API::trap("the purge failed");
  dev_record_cost(__func__);
  CandidTypeRecord result;
  result.append("remaining", CandidTypeNat64{static_cast<uint64_t>(remaining)});
  ic_api.to_wire(result);
}

// Queues again the mail whose move into the mailbox kept failing. Returns how
// many messages.
void admin_retry_moves() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  ic_api.from_wire(CandidTypeText{&local});
  store::Entry entry;
  if (!store::find_entry(lower(local), entry)) IC_API::trap("no such entry");
  const int64_t queued = store::retry_moves(entry.id);
  if (queued < 0) IC_API::trap("the retry failed");
  ingest::arm();
  ic_api.to_wire(CandidTypeNat64{static_cast<uint64_t>(queued)});
}

// Checks a mailbox's file: SQLite's quick_check of one table, or of the whole
// file, and the file's version and counters against the registry. A check of
// the whole file holds the mailbox for repair when it finds a problem, and
// releases it when it finds none.
void admin_check() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  std::optional<std::string> table;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  args.append(CandidTypeOptText{&table});
  ic_api.from_wire(args);
  store::Entry entry;
  if (!store::find_entry(lower(local), entry) || entry.vacant)
    IC_API::trap("no such entry");
  if (entry.purging) IC_API::trap("the mailbox is being purged");
  // This release's checks may not fit a newer file, which is not damage
  if (entry.schema > db::mailbox_version())
    IC_API::trap("the mailbox needs a newer release: its file has schema "
                 "version " +
                 std::to_string(entry.schema) + ", this release's is " +
                 std::to_string(db::mailbox_version()));
  const auto problems = store::check_file(entry, table);
  std::string found;
  for (const std::string &problem :
       problems.value_or(std::vector<std::string>{}))
    found += (found.empty() ? "" : "\n") + problem;
  if (problems && !table && found != entry.needs_repair) {
    if (!store::set_needs_repair(entry.id, found))
      IC_API::trap("cannot store the result");
    if (found.empty()) { // released: the pumps pick it up again
      ingest::arm();
      outbox::arm();
    }
  }
  const std::string result = !problems       ? "the file cannot be opened"
                             : found.empty() ? "ok"
                                             : found;
  dev_record_cost(__func__);
  CandidTypeRecord r;
  r.append("result", CandidTypeText{result});
  r.append("instructions", CandidTypeNat64{IC_API::performance_counter()});
  ic_api.to_wire(r);
}

void admin_list_entries() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  require_controller(ic_api);
  const auto member = [](const store::Member &m) -> CandidType {
    CandidTypeRecord r;
    r.append("principal", CandidTypePrincipal{m.principal});
    r.append("name", CandidTypeOptText{m.name});
    return r;
  };
  const auto value = [&member](const store::Entry &e,
                               const std::vector<store::Member> &of) {
    std::vector<CandidType> members;
    for (const store::Member &m : of)
      members.push_back(member(m));
    CandidTypeRecord r;
    r.append("local", CandidTypeText{e.local});
    r.append("members", CandidTypeVecOf(member(store::Member{}), members));
    r.append("vacant", CandidTypeBool{e.vacant});
    r.append("disabled", CandidTypeBool{e.disabled});
    r.append("quota_bytes",
             CandidTypeNat64{static_cast<uint64_t>(e.quota_bytes)});
    r.append("used_bytes",
             CandidTypeNat64{static_cast<uint64_t>(e.used_bytes)});
    r.append("message_count",
             CandidTypeNat64{static_cast<uint64_t>(e.message_count)});
    r.append("needs_repair", CandidTypeOptText{e.needs_repair.empty()
                                                   ? std::nullopt
                                                   : std::optional<std::string>{
                                                         e.needs_repair}});
    r.append("uidvalidity",
             CandidTypeNat64{static_cast<uint64_t>(e.uidvalidity)});
    return CandidType{r};
  };
  const auto members = store::all_members();
  std::vector<CandidType> elements;
  for (const store::Entry &e : store::list_entries()) {
    const auto of = members.find(e.id);
    elements.push_back(value(
        e, of == members.end() ? std::vector<store::Member>{} : of->second));
  }
  ic_api.to_wire(CandidTypeVecOf(value(store::Entry{}, {}), elements));
}

void admin_storage_totals() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  require_controller(ic_api);
  const store::Totals totals = store::storage_totals();
  CandidTypeRecord r;
  r.append("mailboxes",
           CandidTypeNat64{static_cast<uint64_t>(totals.mailboxes)});
  r.append("messages", CandidTypeNat64{static_cast<uint64_t>(totals.messages)});
  r.append("used_bytes",
           CandidTypeNat64{static_cast<uint64_t>(totals.used_bytes)});
  r.append("database_bytes",
           CandidTypeNat64{static_cast<uint64_t>(totals.database_bytes)});
  r.append("stable_memory_bytes",
           CandidTypeNat64{static_cast<uint64_t>(totals.stable_memory_bytes)});
  ic_api.to_wire(r);
}

void admin_ingest_stats() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  require_controller(ic_api);
  const store::IngestStats counts = store::ingest_stats();
  CandidTypeRecord stats;
  stats.append("queued", CandidTypeNat64{static_cast<uint64_t>(counts.queued)});
  stats.append("indexed",
               CandidTypeNat64{static_cast<uint64_t>(counts.indexed)});
  stats.append("quarantined",
               CandidTypeNat64{static_cast<uint64_t>(counts.quarantined)});
  stats.append("quarantined_moves", CandidTypeNat64{static_cast<uint64_t>(
                                        counts.quarantined_moves)});
  ic_api.to_wire(stats);
}

#ifdef EMAIL_CANISTER_TEST_HOOKS
#include <map>
#include <sys/stat.h>

namespace {

std::map<std::string, uint64_t> g_costs;

store::Entry require_test_entry(const std::string &local) {
  store::Entry entry;
  if (!store::find_entry(local, entry)) IC_API::trap("no such mailbox");
  return entry;
}

store::Mailbox require_test_mailbox(const std::string &local) {
  return require_file(require_test_entry(local));
}

} // namespace

void dev_record_cost(const char *method) {
  g_costs[method] = IC_API::performance_counter();
}

void dev_pause() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  bool paused = false;
  ic_api.from_wire(CandidTypeBool{&paused});
  ingest::set_paused(paused);
  ic_api.to_wire();
}

void dev_set_backlog_cap() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  uint64_t mailbox = 0;
  uint64_t backlog = 0;
  CandidArgs args;
  args.append(CandidTypeNat64{&mailbox});
  args.append(CandidTypeNat64{&backlog});
  ic_api.from_wire(args);
  g_mailbox_cap = static_cast<int64_t>(mailbox);
  g_backlog_cap = static_cast<int64_t>(backlog);
  ic_api.to_wire();
}

void dev_set_dedupe_window() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  uint64_t window_ns = 0;
  ic_api.from_wire(CandidTypeNat64{&window_ns});
  g_dedupe_window_ns = static_cast<int64_t>(window_ns);
  ic_api.to_wire();
}

void dev_trap_moves() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  bool trap = false;
  ic_api.from_wire(CandidTypeBool{&trap});
  ingest::set_trap_moves(trap);
  ic_api.to_wire();
}

void dev_message() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  uint64_t uid = 0;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  args.append(CandidTypeNat64{&uid});
  ic_api.from_wire(args);
  const store::Mailbox box = require_test_mailbox(local);
  db::Stmt select(
      box.file,
      "SELECT state, uid, attempts, subject, sender, preview, last_error, "
      "raw_bytes, sent_at, attachments FROM messages WHERE uid = ?");
  if (!select || !select.integer(1, static_cast<int64_t>(uid)).row()) {
    IC_API::trap("no such message");
  }
  const auto number = [&](int i) {
    return CandidTypeNat64{static_cast<uint64_t>(select.column_integer(i))};
  };
  CandidTypeRecord r;
  r.append("state", number(0));
  r.append("uid", number(1));
  r.append("attempts", number(2));
  r.append("subject", CandidTypeText{select.column_text(3)});
  r.append("sender", CandidTypeText{select.column_text(4)});
  r.append("preview", CandidTypeText{select.column_text(5)});
  r.append("last_error", CandidTypeText{select.column_text(6)});
  r.append("raw_bytes", number(7));
  r.append("sent_at", number(8));
  r.append("attachments", number(9));
  r.append("mailbox", CandidTypeText{local});
  ic_api.to_wire(r);
}

// Every mailbox's matches, by uid
void dev_search() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string query;
  ic_api.from_wire(CandidTypeText{&query});
  const auto hit = [](const std::string &mailbox, int64_t uid) -> CandidType {
    CandidTypeRecord r;
    r.append("mailbox", CandidTypeText{mailbox});
    r.append("uid", CandidTypeNat64{static_cast<uint64_t>(uid)});
    return r;
  };
  std::vector<CandidType> hits;
  for (const store::Entry &entry : store::list_entries()) {
    sqlite3 *file_db = store::mailbox_file(entry.id);
    if (file_db == nullptr) continue;
    db::Stmt select(file_db,
                    "SELECT uid FROM messages WHERE id IN "
                    "(SELECT rowid FROM fts WHERE fts MATCH ?) ORDER BY uid");
    if (!select) IC_API::trap("cannot search");
    select.text(1, query);
    while (select.row())
      hits.push_back(hit(entry.local, select.column_integer(0)));
  }
  ic_api.to_wire(CandidTypeVecOf(hit("", 0), hits));
}

void dev_outbox_timing() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  uint64_t retry_ns = 0;
  uint64_t deadline_ns = 0;
  uint64_t abandon_ns = 0;
  CandidArgs args;
  args.append(CandidTypeNat64{&retry_ns});
  args.append(CandidTypeNat64{&deadline_ns});
  args.append(CandidTypeNat64{&abandon_ns});
  ic_api.from_wire(args);
  outbox::set_timing(retry_ns, deadline_ns, abandon_ns);
  ic_api.to_wire();
}

void dev_outbox_crash() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string point;
  ic_api.from_wire(CandidTypeText{&point});
  outbox::set_crash_point(point);
  ic_api.to_wire();
}

void dev_set_budgets() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  uint64_t search = 0;
  uint64_t purge_step_bytes = 0;
  CandidArgs args;
  args.append(CandidTypeNat64{&search});
  args.append(CandidTypeNat64{&purge_step_bytes});
  ic_api.from_wire(args);
  if (purge_step_bytes == 0 || purge_step_bytes > INT64_MAX) {
    IC_API::trap("the purge step is 1 byte or more");
  }
  store::set_budgets(search, purge_step_bytes);
  ic_api.to_wire();
}

// Stores ready-indexed messages, as many as fit in one message. Returns how
// many: enough calls build a large mailbox without going through the pump.
void dev_seed() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  uint64_t first = 0;
  uint64_t count = 0;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  args.append(CandidTypeNat64{&first});
  args.append(CandidTypeNat64{&count});
  ic_api.from_wire(args);
  const store::Mailbox box = require_test_mailbox(local);
  store::MailboxWrite write(box);
  if (!write) IC_API::trap("cannot begin");
  uint64_t stored = 0;
  const std::string filler(900, 'f');
  {
    db::Stmt counters(db::control(),
                      "UPDATE mailboxes SET next_uid = next_uid + 1, "
                      "modseq = modseq + 1, message_count = message_count + 1, "
                      "unseen = unseen + 1, used_bytes = used_bytes + ? "
                      "WHERE id = ? "
                      "RETURNING next_uid - 1, modseq");
    db::Stmt insert(
        box.file,
        "INSERT INTO messages(uid, state, modseq, received_ns, "
        "envelope_from, rfc_message_id, dedupe_key, raw_bytes, subject) "
        "VALUES(?,1,?,0,'seed@sender.example',?,?,?,?)");
    db::Stmt body(box.file, "INSERT INTO bodies(id, raw) VALUES(?, ?)");
    db::Stmt index(
        box.file,
        "INSERT INTO fts(rowid, subject, sender, body) VALUES(?,?,?,?)");
    if (!counters || !insert || !body || !index) IC_API::trap("seed failed");
    for (; stored < count && IC_API::performance_counter() < 20'000'000'000;
         ++stored) {
      const std::string n = std::to_string(first + stored);
      const std::string text = "seedcommon word" + n + " " + filler;
      const std::string message_id = "<seed" + n + "@sender.example>";
      const std::string dedupe_key = "id:" + message_id;
      const std::string subject = "seeded " + n;
      counters.reset();
      insert.reset();
      body.reset();
      index.reset();
      if (!counters.integer(1, static_cast<int64_t>(text.size()))
               .integer(2, box.id)
               .row()) {
        IC_API::trap("seed failed");
      }
      const int64_t uid = counters.column_integer(0);
      const int64_t modseq = counters.column_integer(1);
      if (!counters.done() ||
          !insert.integer(1, uid)
               .integer(2, modseq)
               .text(3, message_id)
               .text(4, dedupe_key)
               .integer(5, static_cast<int64_t>(text.size()))
               .text(6, subject)
               .done()) {
        IC_API::trap("seed failed");
      }
      const int64_t id = db::last_insert_id(box.file);
      if (!body.integer(1, id).blob(2, text.data(), text.size()).done() ||
          !index.integer(1, id)
               .text(2, subject)
               .text(3, "seed@sender.example")
               .text(4, text)
               .done()) {
        IC_API::trap("seed failed");
      }
    }
  }
  if (!write.commit()) IC_API::trap("cannot commit");
  store::merge_index(box.id, 2000);
  ic_api.to_wire(CandidTypeNat64{stored});
}

// The instructions one page of mail_search uses for this mailbox
void dev_search_cost() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  std::string query;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  args.append(CandidTypeText{&query});
  ic_api.from_wire(args);
  store::search(require_test_mailbox(local), store::Inbox, query, std::nullopt,
                50);
  ic_api.to_wire(CandidTypeNat64{IC_API::performance_counter()});
}

// The instructions the last call of a method used, from dev_record_cost
void dev_last_cost() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string method;
  ic_api.from_wire(CandidTypeText{&method});
  const auto found = g_costs.find(method);
  ic_api.to_wire(CandidTypeNat64{found == g_costs.end() ? 0 : found->second});
}

// Makes a mailbox's file unopenable, or openable again and due at once.
// Hiding it also gives both pumps work in that mailbox, which they then fail
// to claim.
void dev_hide_file() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  bool hidden = false;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  args.append(CandidTypeBool{&hidden});
  ic_api.from_wire(args);
  const store::Entry entry = require_test_entry(local);
  if (!db::hide_mailbox(entry.id, hidden))
    IC_API::trap("cannot rename the file");
  db::Stmt work(db::control(),
                hidden
                    ? "UPDATE mailboxes SET unparsed = unparsed + 1, "
                      "outbox_due_ns = 1 WHERE id = ?"
                    : "UPDATE mailboxes SET retry_after_ns = 0 WHERE id = ?");
  if (!work || !work.integer(1, entry.id).done())
    IC_API::trap("cannot store the work");
  ingest::arm();
  outbox::arm();
  ic_api.to_wire();
}

// Adds a step to the mailbox schema, which every file then waits for
void dev_schema_step() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string sql;
  ic_api.from_wire(CandidTypeText{&sql});
  db::add_schema_step(sql);
  ingest::arm();
  outbox::arm(); // a mailbox at the new version may have mail to send
  ic_api.to_wire();
}

// Makes every statement whose SQL contains the text fail, as a fault would;
// an empty text ends it. Replies how many the fault in force had failed.
void dev_fail_statements() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string sql;
  ic_api.from_wire(CandidTypeText{&sql});
  ic_api.to_wire(
      CandidTypeNat64{static_cast<uint64_t>(db::fail_statements(sql))});
}

// Runs SQL on a mailbox's file, around the registry, as a fault would
void dev_file_exec() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  std::string sql;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  args.append(CandidTypeText{&sql});
  ic_api.from_wire(args);
  const std::string error =
      db::exec_in_mailbox(require_test_entry(local).id, sql);
  if (!error.empty()) IC_API::trap(error);
  ic_api.to_wire();
}

// Whether the mailbox is marked for a cleanup of its expired mail
void dev_clean_due() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  ic_api.from_wire(CandidTypeText{&local});
  db::Stmt select(db::control(),
                  "SELECT clean_due FROM mailboxes WHERE local = ?");
  if (!select || !select.text(1, local).row()) IC_API::trap("no such mailbox");
  ic_api.to_wire(CandidTypeBool{select.column_integer(0) != 0});
}

// Damages the root page of one of a mailbox file's tables
void dev_damage_file() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string local;
  std::string table;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  args.append(CandidTypeText{&table});
  ic_api.from_wire(args);
  const store::Entry entry = require_test_entry(local);
  if (!db::damage_mailbox(entry.id, table)) IC_API::trap("cannot damage it");
  ic_api.to_wire();
}

// How many mailbox files are open
void dev_cache() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  require_controller(ic_api);
  ic_api.from_wire();
  ic_api.to_wire(CandidTypeNat64{static_cast<uint64_t>(db::open_mailboxes())});
}

// The size of a file or directory in the canister's file system, if it exists
void dev_stat() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  require_controller(ic_api);
  std::string path;
  ic_api.from_wire(CandidTypeText{&path});
  struct stat st;
  std::optional<uint64_t> size;
  if (stat(path.c_str(), &st) == 0) size = static_cast<uint64_t>(st.st_size);
  ic_api.to_wire(CandidTypeOptNat64{size});
}
#endif
