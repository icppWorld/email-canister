// The registry: the mailboxes on this domain, with their counters, and the
// principals that are members of each. A principal can be a member of several
// mailboxes, and a mailbox can have several members. It lives in control.db;
// the mail lives in the mailbox's own file.

#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "claim.h"
#include "db.h"
#include "ic_api.h"

namespace store {

struct Entry {
  int64_t id{0};
  std::string local;
  bool vacant{false}; // purged: the address is free
  bool disabled{false};
  int64_t quota_bytes{0};
  int64_t used_bytes{0};
  int64_t message_count{0};
  int64_t unseen{0}; // messages without the seen flag
  int64_t members{0};
  int64_t uidvalidity{0};
  bool purging{false};
  int64_t export_until_ns{0};   // the file is frozen for a download until then
  int64_t export_started_ns{0}; // names that download
  std::string export_principal; // who downloads it
  int64_t schema{0};            // the schema version of the file
  std::string needs_repair;     // why nothing may use the file, or empty
};

// A mailbox and its open file
struct Mailbox {
  int64_t id{0};
  sqlite3 *file{nullptr};
};

struct Totals {
  int64_t mailboxes{0};
  int64_t messages{0};
  int64_t used_bytes{0};
  int64_t database_bytes{0};
  int64_t stable_memory_bytes{0};
};

// The most members a mailbox can have
const int64_t k_max_members = 100;

struct Member {
  std::string principal;
  std::optional<std::string> name;
};

// Returns why the mailbox was refused, or an empty string. Creates its file,
// and traps if that fails. A purged address is given out again this way.
std::string create_mailbox(const std::string &local, int64_t quota_bytes,
                           int64_t now_seconds);

// Why the principal can never be a member, or an empty string. Every refusal
// that depends on the principal alone belongs here.
std::string refuse_member(const std::string &principal);

// Return why they were refused, or an empty string. Given `uidvalidity`, it
// refuses a mailbox created again since it was listed with that one.
std::string add_member(const std::string &local, const std::string &principal,
                       int64_t now_ns,
                       std::optional<int64_t> uidvalidity = std::nullopt);
// Ends the member's download too, which no one else could end
std::string remove_member(const std::string &local,
                          const std::string &principal);
// Every mailbox's members, by mailbox id, in the order they were added
std::map<int64_t, std::vector<Member>> all_members();

// A name or a header holds none of these
bool has_control_character(const std::string &s);

// The name an admin gave a principal; an empty name removes it. Returns why
// it was refused, or an empty string.
std::string set_name(const std::string &principal, const std::string &name);
std::optional<std::string> name_of(const std::string &principal);

// Returns why it was refused, or an empty string. A mailbox being purged
// cannot be enabled.
std::string set_disabled(const std::string &local, bool disabled);
bool set_quota(const std::string &local, int64_t quota_bytes);
bool find_entry(const std::string &local, Entry &entry);
std::vector<Entry> list_entries();
Totals storage_totals();

// The mailbox `local`, when `principal` is a member and it is enabled. Access
// to mail goes through this only.
bool member_mailbox(const std::string &principal, const std::string &local,
                    Entry &entry);
// Every enabled mailbox `principal` is a member of, by address
std::vector<Entry> member_mailboxes(const std::string &principal);

// A mailbox that accepts mail: not purged and not disabled
enum class Lookup { Found, Missing, Failed };
Lookup deliverable_mailbox(const std::string &local, int64_t &id);

// The mailbox's file, or nullptr while it is purged or has none, needs
// repair, or waits for its schema upgrade. Every reader and writer of mail
// opens the file through this.
sqlite3 *mailbox_file(int64_t id);
sqlite3 *mailbox_file(const Entry &entry); // for an entry just read
// Why nothing may use the entry's file now, as an owner's call is refused, or
// empty
std::string unusable(const Entry &entry);
// The retry time of a mailbox held for repair, which keeps every pump away
const int64_t k_held_ns = INT64_MAX;
// A mailbox whose file waits for its schema upgrade, where `version` is the
// parameter that holds the current version. A vacant row has no file. A file
// newer than this release waits for the release that knows its version.
#define WAITS_FOR_UPGRADE(version)                                             \
  "(schema < " version " AND vacant = 0 AND purging = 0)"

// Opens a mailbox's file for a pump: Claimed with the file, or Again when it
// cannot be opened, after which every pump leaves the mailbox alone until
// `retry_ns`. Failed when even that could not be recorded.
Claim open_for_pump(int64_t id, int64_t retry_ns, sqlite3 *&file);

// Makes every pump leave a mailbox alone until `retry_ns`: Again, or Failed
// when that could not be recorded
Claim defer_pump(int64_t id, int64_t retry_ns);

// Claims a mailbox whose file waits for a schema upgrade: Claimed, or Again
// when its file cannot be opened, as open_for_pump does
Claim claim_upgrade(int64_t now_ns, int64_t defer_ns, int64_t &id);
// Whether any mailbox's file waits for a schema upgrade, or the registry
// cannot tell
bool upgrade_pending();
// What an upgrade of a mailbox's file came to
enum class Upgraded {
  Done,   // upgraded, or held: the file is ahead of its registry
  NotDue, // purged, held, deferred, or upgraded meanwhile
  Wait,   // the file cannot be opened or written now
  Failed  // a step failed, and the file is as it was
};
// Takes the mailbox's file to the current schema version. A failed step
// describes itself in `problem`; the caller decides whether that holds the
// mailbox.
Upgraded upgrade_file(int64_t id, std::string &problem);
// Holds the mailbox for repair, for `why`, or with an empty `why` releases it.
// Nothing may use the file meanwhile, and the pumps keep away: its
// retry_after_ns is k_held_ns.
bool set_needs_repair(int64_t id, const std::string &why);
// Begins the reason of every hold that a failed schema upgrade set
const char *const k_upgrade_failed = "the schema upgrade failed: ";
// A check of the mailbox's file: db::quick_check of one table, or of the
// whole file on a db::CheckConnection, with the file's version and counters
// against the registry. The problems found, or nullopt when the file cannot be opened.
// Traps when `table` is not one of the file's tables.
std::optional<std::vector<std::string>>
check_file(const Entry &entry, const std::optional<std::string> &table);
// Gives back quota, in the registry
bool release_quota(int64_t mailbox, int64_t bytes);

// A download of a mailbox's file. While it lasts nothing writes to the file:
// MailboxWrite refuses, and the pumps leave the mailbox alone.
struct Export {
  int64_t size{0};       // the file's bytes
  int64_t started_ns{0}; // names this download: a lapsed one is not resumed
  int64_t until_ns{0};
};

// Whether a freeze that holds the file until `until_ns` holds it now
inline bool frozen(int64_t until_ns) {
  return until_ns > static_cast<int64_t>(IC_API::time());
}

// Whether a download holds the mailbox's file now
bool exporting(int64_t mailbox);

// Whether the entry's download is live and `principal`'s: only the member who
// started it reads it
inline bool downloading_for(const Entry &entry, const std::string &principal) {
  return frozen(entry.export_until_ns) && entry.export_principal == principal;
}

// Starts a download for `principal`, or with `renew_ns` renews theirs that
// started then, holding the file until now + `hold_ns`, but never more than
// `limit_ns` after it started. A start is refused while a download is under
// way, and a renewal of one that has lapsed, been replaced or is another
// member's. Returns why it was refused, or an empty string.
std::string export_freeze(int64_t mailbox, const std::string &principal,
                          int64_t now_ns, int64_t hold_ns, int64_t limit_ns,
                          std::optional<int64_t> renew_ns, Export &out);

// Ends `principal`'s download that started at `started_ns` early, so that the
// pumps go on at once. A later download, or another member's, is left alone.
bool export_thaw(int64_t mailbox, const std::string &principal,
                 int64_t started_ns);

// A write to a mailbox's file and to the registry, which commit together.
// Declare it before the write's statements, so that they finish first.
class MailboxWrite {
public:
  explicit MailboxWrite(const Mailbox &box);
  explicit MailboxWrite(int64_t id); // opens the file through mailbox_file

  // False when the file could not be opened or a transaction not begun
  explicit operator bool() const;
  sqlite3 *file() const { return m_box.file; }

  // The file's counters copy the registry's, so that the file stands on its
  // own, and the registry records the file's size. The file commits first;
  // if control.db then fails to commit, this traps, which rolls back both.
  // False when the file's commit failed, or a download holds the file, which
  // leaves both rolled back.
  bool commit();

private:
  Mailbox m_box;
  db::Transaction m_control;
  db::Transaction m_file;
};

} // namespace store
