#include "allowlist.h"

#include <algorithm>
#include <cctype>
#include <utility>

#include "db.h"
#include "ic_api.h"
#include "mail_store.h"

namespace {

const char *const k_anonymous = "2vxsx-fae";
const size_t k_max_local_part = 64;
const size_t k_max_name = 64;

#define ENTRY_COLUMNS                                                          \
  "id, local, vacant, disabled, quota_bytes, used_bytes, message_count, "      \
  "uidvalidity, purging, export_until_ns, export_started_ns, schema, "         \
  "needs_repair, export_principal, unseen, "                                   \
  "(SELECT count(*) FROM members WHERE mailbox_id = mailboxes.id)"

store::Entry read_entry(db::Stmt &row) {
  store::Entry e;
  e.id = row.column_integer(0);
  e.local = row.column_text(1);
  e.vacant = row.column_integer(2) != 0;
  e.disabled = row.column_integer(3) != 0;
  e.quota_bytes = row.column_integer(4);
  e.used_bytes = row.column_integer(5);
  e.message_count = row.column_integer(6);
  e.uidvalidity = row.column_integer(7);
  e.purging = row.column_integer(8) != 0;
  e.export_until_ns = row.column_integer(9);
  e.export_started_ns = row.column_integer(10);
  e.schema = row.column_integer(11);
  e.needs_repair = row.column_text(12);
  e.export_principal = row.column_text(13);
  e.unseen = row.column_integer(14);
  e.members = row.column_integer(15);
  return e;
}

bool valid_local(const std::string &local) {
  if (local.empty() || local.size() > k_max_local_part) return false;
  if (local.front() == '.' || local.back() == '.') return false;
  if (local.find("..") != std::string::npos) return false;
  for (const unsigned char c : local) {
    if (!std::islower(c) && !std::isdigit(c) && c != '.' && c != '_' &&
        c != '-') {
      return false;
    }
  }
  return true;
}

// The mailboxes a principal is a member of, enabled and not purged
#define MEMBER_MAILBOXES                                                       \
  "SELECT " ENTRY_COLUMNS " FROM mailboxes WHERE vacant = 0 AND "              \
  "disabled = 0 AND id IN (SELECT mailbox_id FROM members WHERE principal = ?)"

// The counters a mailbox's file copies from the registry, in one order for
// the copy and the check
#define COUNTERS                                                               \
  "message_count, uidvalidity, next_uid, modseq, next_outbox_id, unseen"

// The schema version at which no file waited for its upgrade, so that the
// pump need not look on every round; 0 while one may wait
int64_t g_upgraded_at = 0;

} // namespace

namespace store {

bool stop_feed(int64_t mailbox) {
  db::Stmt clear(db::control(), "DELETE FROM feeds WHERE mailbox_id = ?");
  return clear && clear.integer(1, mailbox).done();
}

std::string create_mailbox(const std::string &local, int64_t quota_bytes,
                           int64_t now_seconds) {
  if (!valid_local(local)) return "invalid address";

  Entry existing;
  int64_t id = 0;
  if (find_entry(local, existing)) {
    if (!existing.vacant)
      return local +
             " already exists. To give someone access to all of its mail, add "
             "them as a member. To give the address to someone new, disable "
             "and purge it first, which deletes its mail.";
    // A purge kept the row, with its uid and outbox counters, so the new
    // mailbox never reuses a uid or a bridge key. A higher uidvalidity tells a
    // syncing client that this is not the old mailbox.
    db::Stmt assign(db::control(),
                    "UPDATE mailboxes SET vacant = 0, disabled = 0, "
                    "quota_bytes = ?, uidvalidity = max(?, uidvalidity + 1), "
                    "schema = ?, needs_repair = '', retry_after_ns = 0 "
                    "WHERE id = ?");
    if (!assign || !assign.integer(1, quota_bytes)
                        .integer(2, now_seconds)
                        .integer(3, db::mailbox_version())
                        .integer(4, existing.id)
                        .done()) {
      return "could not create the mailbox";
    }
    id = existing.id;
  } else {
    db::Stmt insert(db::control(),
                    "INSERT INTO mailboxes(local, quota_bytes, uidvalidity, "
                    "schema) VALUES(?, ?, ?, ?)");
    if (!insert || !insert.text(1, local)
                        .integer(2, quota_bytes)
                        .integer(3, now_seconds)
                        .integer(4, db::mailbox_version())
                        .done()) {
      return "could not create the mailbox";
    }
    id = db::last_insert_id(db::control());
  }
  // A trap here rolls back the registry row too
  db::create_mailbox(id);
  MailboxWrite write(id);
  if (!write || !write.commit()) IC_API::trap("could not create the mailbox");
  return "";
}

std::string refuse_member(const std::string &principal) {
  return principal == k_anonymous ? "the anonymous principal cannot be a member"
                                  : "";
}

std::string add_member(const std::string &local, const std::string &principal,
                       int64_t now_ns, std::optional<int64_t> uidvalidity) {
  if (std::string refused = refuse_member(principal); !refused.empty())
    return refused;
  Entry entry;
  if (!find_entry(local, entry) || entry.vacant) return "no such mailbox";
  if (entry.purging) return "the mailbox is being purged";
  if (uidvalidity && *uidvalidity != entry.uidvalidity)
    return local + " was created again since it was listed. Reload, and check "
                   "that it is the mailbox you mean.";
  db::Stmt count(db::control(), "SELECT count(*), "
                                "count(*) FILTER (WHERE principal = ?2) "
                                "FROM members WHERE mailbox_id = ?1");
  if (!count || !count.integer(1, entry.id).text(2, principal).row())
    return "could not add the member";
  if (count.column_integer(1) > 0) return "already a member of this mailbox";
  if (count.column_integer(0) >= k_max_members)
    return "this mailbox has the most members it can have, " +
           std::to_string(k_max_members);
  db::Stmt insert(db::control(), "INSERT INTO members(mailbox_id, principal, "
                                 "added_ns) VALUES(?, ?, ?)");
  return insert && insert.integer(1, entry.id)
                       .text(2, principal)
                       .integer(3, now_ns)
                       .done()
             ? ""
             : "could not add the member";
}

std::string remove_member(const std::string &local,
                          const std::string &principal) {
  Entry entry;
  if (!find_entry(local, entry) || entry.vacant) return "no such mailbox";
  db::Stmt remove(db::control(),
                  "DELETE FROM members WHERE mailbox_id = ? AND principal = ?");
  if (!remove || !remove.integer(1, entry.id).text(2, principal).done())
    return "could not remove the member";
  if (db::changes(db::control()) != 1) return "not a member of this mailbox";
  // A member may have copied the calendar's secret address: it stops working
  if (!stop_feed(entry.id)) return "could not end the calendar's address";
  if (downloading_for(entry, principal) &&
      !export_thaw(entry.id, principal, entry.export_started_ns))
    return "could not end the member's download";
  return "";
}

std::map<int64_t, std::vector<Member>> all_members() {
  std::map<int64_t, std::vector<Member>> found;
  db::Stmt select(db::control(),
                  "SELECT m.mailbox_id, m.principal, p.name FROM members m "
                  "LEFT JOIN people p ON p.principal = m.principal "
                  "ORDER BY m.mailbox_id, m.added_ns, m.principal");
  if (!select) return found;
  while (select.row()) {
    Member member{select.column_text(1), std::nullopt};
    if (!select.column_is_null(2)) member.name = select.column_text(2);
    found[select.column_integer(0)].push_back(std::move(member));
  }
  return found;
}

bool valid_address(const std::string &address) {
  const size_t k_max_address = 254;
  if (address.empty() || address.size() > k_max_address ||
      has_control_character(address)) {
    return false;
  }
  const size_t at = address.find('@');
  if (at == std::string::npos || at == 0 || at + 1 == address.size() ||
      address.find('@', at + 1) != std::string::npos) {
    return false;
  }
  return address.find_first_of(" <>()[],;:\"\\") == std::string::npos;
}

bool has_control_character(const std::string &s) {
  for (const unsigned char c : s) {
    if (c < 0x20 || c == 0x7f) return true;
  }
  return false;
}

std::string set_name(const std::string &principal, const std::string &name) {
  if (name.size() > k_max_name || has_control_character(name))
    return "invalid name";
  if (name.empty()) {
    db::Stmt remove(db::control(), "DELETE FROM people WHERE principal = ?");
    return remove && remove.text(1, principal).done()
               ? ""
               : "could not store the name";
  }
  db::Stmt upsert(db::control(),
                  "INSERT INTO people(principal, name) VALUES(?1, ?2) "
                  "ON CONFLICT(principal) DO UPDATE SET name = ?2");
  return upsert && upsert.text(1, principal).text(2, name).done()
             ? ""
             : "could not store the name";
}

std::optional<std::string> name_of(const std::string &principal) {
  db::Stmt select(db::control(), "SELECT name FROM people WHERE principal = ?");
  if (!select || !select.text(1, principal).row()) return std::nullopt;
  return select.column_text(0);
}

std::string set_disabled(const std::string &local, bool disabled) {
  Entry entry;
  if (!find_entry(local, entry) || entry.vacant) return "no such entry";
  if (entry.purging && !disabled)
    return "the entry is being purged: finish the purge first";
  db::Transaction write(db::control());
  db::Stmt update(db::control(),
                  "UPDATE mailboxes SET disabled = ? WHERE id = ?");
  // A disabled mailbox's calendar address ends, and is not back when it is
  // enabled again
  return write && update &&
                 update.integer(1, disabled ? 1 : 0)
                     .integer(2, entry.id)
                     .done() &&
                 (!disabled || stop_feed(entry.id)) && write.commit()
             ? ""
             : "could not store the change";
}

bool set_quota(const std::string &local, int64_t quota_bytes) {
  db::Stmt update(db::control(),
                  "UPDATE mailboxes SET quota_bytes = ? WHERE local = ?");
  return update && update.integer(1, quota_bytes).text(2, local).done() &&
         db::changes(db::control()) == 1;
}

bool find_entry(const std::string &local, Entry &entry) {
  db::Stmt select(db::control(),
                  "SELECT " ENTRY_COLUMNS " FROM mailboxes WHERE local = ?");
  if (!select || !select.text(1, local).row()) return false;
  entry = read_entry(select);
  return true;
}

std::vector<Entry> list_entries() {
  std::vector<Entry> entries;
  db::Stmt select(db::control(),
                  "SELECT " ENTRY_COLUMNS " FROM mailboxes ORDER BY local");
  while (select && select.row())
    entries.push_back(read_entry(select));
  return entries;
}

Totals storage_totals() {
  Totals totals;
  db::Stmt sum(db::control(),
               "SELECT count(*) FILTER (WHERE vacant = 0), "
               "coalesce(sum(message_count), 0), "
               "coalesce(sum(used_bytes), 0), coalesce(sum(file_bytes), 0) "
               "FROM mailboxes");
  if (sum && sum.row()) {
    totals.mailboxes = sum.column_integer(0);
    totals.messages = sum.column_integer(1);
    totals.used_bytes = sum.column_integer(2);
    totals.database_bytes = sum.column_integer(3);
  }
  totals.database_bytes += std::max<int64_t>(0, db::file_bytes(db::control()));
  totals.stable_memory_bytes = db::stable_memory_bytes();
  return totals;
}

bool member_mailbox(const std::string &principal, const std::string &local,
                    Entry &entry) {
  db::Stmt select(db::control(), MEMBER_MAILBOXES " AND local = ?");
  if (!select || !select.text(1, principal).text(2, local).row()) return false;
  entry = read_entry(select);
  return true;
}

std::vector<Entry> member_mailboxes(const std::string &principal) {
  std::vector<Entry> entries;
  db::Stmt select(db::control(), MEMBER_MAILBOXES " ORDER BY local");
  if (!select) return entries;
  select.text(1, principal);
  while (select.row())
    entries.push_back(read_entry(select));
  return entries;
}

Lookup deliverable_mailbox(const std::string &local, int64_t &id) {
  db::Stmt select(db::control(), "SELECT id FROM mailboxes WHERE local = ? AND "
                                 "vacant = 0 AND disabled = 0");
  if (!select) return Lookup::Failed;
  if (!select.text(1, local).row()) {
    return select.failed() ? Lookup::Failed : Lookup::Missing;
  }
  id = select.column_integer(0);
  return Lookup::Found;
}

sqlite3 *mailbox_file(int64_t id) {
  db::Stmt select(db::control(), "SELECT purging, schema, needs_repair "
                                 "FROM mailboxes WHERE id = ?");
  if (!select || !select.integer(1, id).row()) return nullptr;
  Entry entry;
  entry.id = id;
  entry.purging = select.column_integer(0) != 0;
  entry.schema = select.column_integer(1);
  entry.needs_repair = select.column_text(2);
  return mailbox_file(entry);
}

sqlite3 *mailbox_file(const Entry &entry) {
  return unusable(entry).empty() ? db::mailbox(entry.id) : nullptr;
}

std::string unusable(const Entry &entry) {
  if (entry.purging) return "the mailbox is being purged";
  if (!entry.needs_repair.empty())
    return "this mailbox needs repair: ask your administrator";
  if (entry.schema > db::mailbox_version())
    return "this mailbox needs a newer release: ask your administrator";
  if (entry.schema != db::mailbox_version())
    return "busy: the mailbox is being upgraded, try again";
  return "";
}

Claim open_for_pump(int64_t id, int64_t retry_ns, sqlite3 *&file) {
  file = mailbox_file(id);
  if (file != nullptr) {
    // Keeps the index of deferred mailboxes to the ones still deferred
    db::Stmt clear(db::control(), "UPDATE mailboxes SET retry_after_ns = 0 "
                                  "WHERE id = ? AND retry_after_ns != 0");
    return clear && clear.integer(1, id).done() ? Claim::Claimed
                                                : Claim::Failed;
  }
  return defer_pump(id, retry_ns);
}

Claim defer_pump(int64_t id, int64_t retry_ns) {
  // A download may hold the mailbox longer
  db::Stmt defer(db::control(), "UPDATE mailboxes SET retry_after_ns = "
                                "max(retry_after_ns, ?) WHERE id = ?");
  return defer && defer.integer(1, retry_ns).integer(2, id).done()
             ? Claim::Again
             : Claim::Failed;
}

Claim claim_upgrade(int64_t now_ns, int64_t defer_ns, int64_t &id) {
  const int64_t current = db::mailbox_version();
  if (g_upgraded_at == current) return Claim::Empty;
  {
    // A download and a hold keep the pumps away through retry_after_ns
    db::Stmt select(db::control(),
                    "SELECT id FROM mailboxes WHERE retry_after_ns <= ?2 AND "
                    "" WAITS_FOR_UPGRADE("?1") " ORDER BY id LIMIT 1");
    if (!select) return Claim::Failed;
    if (!select.integer(1, current).integer(2, now_ns).row()) {
      if (select.failed()) return Claim::Failed;
      if (!upgrade_pending()) g_upgraded_at = current;
      return Claim::Empty;
    }
    id = select.column_integer(0);
  }
  return db::mailbox(id, true) != nullptr ? Claim::Claimed
                                          : defer_pump(id, now_ns + defer_ns);
}

bool upgrade_pending() {
  // A query that fails may hide a waiting file: it counts as one
  db::Stmt select(db::control(),
                  "SELECT 1 FROM mailboxes WHERE "
                  "retry_after_ns < ?2 AND " WAITS_FOR_UPGRADE("?1"));
  return !select ||
         select.integer(1, db::mailbox_version()).integer(2, k_held_ns).row() ||
         select.failed();
}

Upgraded upgrade_file(int64_t id, std::string &problem) {
  const int64_t current = db::mailbox_version();
  int64_t registered = 0;
  {
    db::Stmt select(db::control(),
                    "SELECT schema FROM mailboxes WHERE id = ?2 AND "
                    "retry_after_ns <= ?3 AND " WAITS_FOR_UPGRADE("?1"));
    if (!select) return Upgraded::Wait;
    const auto now = static_cast<int64_t>(IC_API::time());
    if (!select.integer(1, current).integer(2, id).integer(3, now).row())
      return select.failed() ? Upgraded::Wait : Upgraded::NotDue;
    registered = select.column_integer(0);
  }
  sqlite3 *file = db::mailbox(id, true);
  if (file == nullptr) return Upgraded::Wait;
  const int64_t version = db::file_version(file);
  if (version < 0) return Upgraded::Wait;
  if (version != registered) {
    // Creating a mailbox and upgrading its file record the file's version
    // with the file, and a rollback leaves both ahead of the release: a file
    // out of step with its registry is damage
    return set_needs_repair(
               id, "the file has schema version " + std::to_string(version) +
                       ", its registry " + std::to_string(registered))
               ? Upgraded::Done
               : Upgraded::Wait;
  }
  MailboxWrite write(Mailbox{id, file});
  if (!write) return Upgraded::Wait;
  if (!db::upgrade_mailbox(file, version, problem))
    return Upgraded::Failed; // the write rolls the step back
  db::Stmt record(db::control(),
                  "UPDATE mailboxes SET schema = ? WHERE id = ?");
  return record && record.integer(1, current).integer(2, id).done() &&
                 write.commit()
             ? Upgraded::Done
             : Upgraded::Wait;
}

bool set_needs_repair(int64_t id, const std::string &why) {
  // The hold keeps every pump away through retry_after_ns. A release leaves a
  // download's hold, and the file may then wait for its upgrade.
  db::Stmt update(db::control(),
                  "UPDATE mailboxes SET needs_repair = ?1, retry_after_ns = "
                  "iif(?1 != '', ?3, iif(retry_after_ns = ?3, "
                  "export_until_ns, retry_after_ns)) WHERE id = ?2 AND "
                  "(?1 = '' OR (purging = 0 AND vacant = 0))");
  if (why.empty()) g_upgraded_at = 0;
  return update &&
         update.text(1, why).integer(2, id).integer(3, k_held_ns).done();
}

std::optional<std::vector<std::string>>
check_file(const Entry &entry, const std::optional<std::string> &table) {
  if (table) {
    sqlite3 *file = db::mailbox(entry.id, true);
    if (file == nullptr) return std::nullopt;
    return db::quick_check(file, table);
  }
  const db::CheckConnection own(entry.id);
  sqlite3 *file = own.get();
  if (file == nullptr) return std::nullopt;
  std::vector<std::string> problems = db::quick_check(file, std::nullopt);

  const auto differs = [&problems](const std::string &what, int64_t in_file,
                                   int64_t in_registry) {
    if (in_file != in_registry) {
      problems.push_back(what + " is " + std::to_string(in_file) +
                         " in the file, " + std::to_string(in_registry) +
                         " in the registry");
    }
  };
  // A file newer than this release is not damage: nothing uses it until a
  // release that knows its version runs
  const int64_t version = db::file_version(file);
  differs("the schema version", version, entry.schema);
  db::Stmt registry(db::control(),
                    "SELECT " COUNTERS " FROM mailboxes WHERE id = ?");
  db::Stmt counters(file, "SELECT " COUNTERS " FROM counters WHERE id = 1");
  // A file waiting for the version that added the folders has all its mail
  // in the Inbox
  const std::string totals =
      std::string("SELECT (SELECT count(*) FROM messages), "
                  "(SELECT coalesce(max(uid), 0) FROM messages), "
                  "(SELECT coalesce(max(modseq), 0) FROM messages), "
                  "(SELECT coalesce(max(id), 0) FROM outbox), "
                  "(SELECT count(*) FROM messages WHERE ") +
      (version < db::k_folders_version ? "flags & 1 = 0" : COUNTS_UNSEEN) + ")";
  db::Stmt actual(file, totals.c_str());
  if (!registry || !registry.integer(1, entry.id).row())
    IC_API::trap("cannot read the registry");
  if (!counters || !counters.row()) {
    problems.push_back("the file's counters cannot be read");
  } else {
    for (int column = 0; column < counters.column_count(); ++column) {
      differs("counters." + counters.column_name(column),
              counters.column_integer(column), registry.column_integer(column));
    }
  }
  if (!actual || !actual.row()) {
    problems.push_back(std::string("the file's messages and outbox cannot be "
                                   "read: ") +
                       sqlite3_errmsg(file));
    return problems;
  }
  differs("the number of messages", actual.column_integer(0),
          registry.column_integer(0));
  differs("the number of unseen messages", actual.column_integer(4),
          registry.column_integer(5));
  if (actual.column_integer(1) >= registry.column_integer(2)) {
    problems.push_back("uid " + std::to_string(actual.column_integer(1)) +
                       " is not below next_uid " +
                       std::to_string(registry.column_integer(2)));
  }
  if (actual.column_integer(2) > registry.column_integer(3)) {
    problems.push_back("modseq " + std::to_string(actual.column_integer(2)) +
                       " is above the mailbox's " +
                       std::to_string(registry.column_integer(3)));
  }
  if (actual.column_integer(3) >= registry.column_integer(4)) {
    problems.push_back("outbox id " + std::to_string(actual.column_integer(3)) +
                       " is not below next_outbox_id " +
                       std::to_string(registry.column_integer(4)));
  }
  return problems;
}

bool release_quota(int64_t mailbox, int64_t bytes) {
  db::Stmt update(
      db::control(),
      "UPDATE mailboxes SET used_bytes = used_bytes - ? WHERE id = ?");
  return update && update.integer(1, bytes).integer(2, mailbox).done();
}

bool exporting(int64_t mailbox) {
  db::Stmt state(db::control(),
                 "SELECT export_until_ns FROM mailboxes WHERE id = ?");
  return state && state.integer(1, mailbox).row() &&
         frozen(state.column_integer(0));
}

std::string export_freeze(int64_t mailbox, const std::string &principal,
                          int64_t now_ns, int64_t hold_ns, int64_t limit_ns,
                          std::optional<int64_t> renew_ns, Export &out) {
  {
    db::Stmt state(db::control(),
                   "SELECT purging, export_until_ns, export_started_ns, "
                   "export_principal FROM mailboxes WHERE id = ?");
    if (!state || !state.integer(1, mailbox).row())
      return "the download could not start";
    if (state.column_integer(0) != 0) return "the mailbox is being purged";
    const bool live = state.column_integer(1) > now_ns;
    // One download at a time, so that no other one's end thaws it
    if (live && !renew_ns)
      return "a download is already under way: try again once it ends";
    out.started_ns = live ? state.column_integer(2) : now_ns;
    // Only its own member renews a download: the chunks are theirs alone
    if (renew_ns &&
        (*renew_ns != out.started_ns || state.column_text(3) != principal))
      return "the download has ended: start it again";
  }
  out.size = db::mailbox_bytes(mailbox);
  if (out.size < 0) return "the mailbox has no file to download";
  out.until_ns = std::min(now_ns + hold_ns, out.started_ns + limit_ns);
  // The pumps leave the mailbox alone for as long, through their retry time
  db::Stmt hold(db::control(),
                "UPDATE mailboxes SET export_until_ns = ?1, "
                "export_started_ns = ?2, export_principal = ?4, "
                "retry_after_ns = max(retry_after_ns, ?1) WHERE id = ?3");
  return hold && hold.integer(1, out.until_ns)
                     .integer(2, out.started_ns)
                     .integer(3, mailbox)
                     .text(4, principal)
                     .done()
             ? ""
             : "the download could not start";
}

bool export_thaw(int64_t mailbox, const std::string &principal,
                 int64_t started_ns) {
  // Leaves a retry time that a file that cannot be opened set
  db::Stmt thaw(db::control(),
                "UPDATE mailboxes SET retry_after_ns = "
                "iif(retry_after_ns = export_until_ns, 0, retry_after_ns), "
                "export_until_ns = 0 WHERE id = ? AND export_until_ns > 0 "
                "AND export_started_ns = ? AND export_principal = ?");
  return thaw && thaw.integer(1, mailbox)
                     .integer(2, started_ns)
                     .text(3, principal)
                     .done();
}

MailboxWrite::MailboxWrite(const Mailbox &box)
    : m_box(box), m_control(db::control()), m_file(box.file) {}

MailboxWrite::MailboxWrite(int64_t id)
    : MailboxWrite(Mailbox{id, mailbox_file(id)}) {}

MailboxWrite::operator bool() const {
  return static_cast<bool>(m_control) && static_cast<bool>(m_file);
}

bool MailboxWrite::commit() {
  if (!*this) return false;
  {
    // A write that left the counters as they were changes no page
    db::Stmt registry(db::control(),
                      "SELECT " COUNTERS ", export_until_ns FROM mailboxes "
                      "WHERE id = ?");
    db::Stmt mirror(
        m_box.file,
        "UPDATE counters SET message_count = ?1, uidvalidity = ?2, "
        "next_uid = ?3, modseq = ?4, next_outbox_id = ?5, unseen = ?6 "
        "WHERE id = 1 AND (" COUNTERS ") IS NOT (?1, ?2, ?3, ?4, ?5, ?6)");
    if (!registry || !mirror || !registry.integer(1, m_box.id).row() ||
        frozen(registry.column_integer(6))) {
      return false;
    }
    for (int i = 0; i < 6; ++i)
      mirror.integer(i + 1, registry.column_integer(i));
    if (!mirror.done()) return false;
  }
  {
    const int64_t size = db::file_bytes(m_box.file);
    db::Stmt record(db::control(), "UPDATE mailboxes SET file_bytes = ?1 "
                                   "WHERE id = ?2 AND file_bytes != ?1");
    if (size < 0 || !record ||
        !record.integer(1, size).integer(2, m_box.id).done()) {
      return false;
    }
  }
  if (!m_file.commit()) return false;
  if (!m_control.commit()) {
    IC_API::trap("control.db could not commit after a mailbox file did");
  }
  return true;
}

} // namespace store
