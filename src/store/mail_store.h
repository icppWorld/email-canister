// The mail in a mailbox's file: parsing it, and the owner's view of it.
// Nothing here traps: failures are returned, so that the callers decide.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "allowlist.h"
#include "claim.h"

namespace store {

// Queued: moved into the file, waiting to be parsed
enum MessageState : int64_t { Queued = 0, Indexed = 1, Quarantined = 2 };

std::string domain();
bool set_domain(const std::string &domain);

// Picks the oldest message waiting to be parsed, in the mailbox after the one
// parsed last, and records the attempt in the registry. That has to be
// committed before the message is processed: the processing may trap. Again
// means it quarantined the message instead, or deferred the mailbox until
// now + `defer_ns` because its file cannot be opened.
Claim claim_parse(int64_t max_attempts, int64_t now_ns, int64_t defer_ns,
                  int64_t &mailbox, int64_t &id);

// A call that never ran gives back the attempt it claimed for message `id`.
// Changes nothing once another message is claimed.
void record_parse_failure(int64_t mailbox, int64_t id, const std::string &error,
                          bool attempted);

// Parses and indexes one message. Returns false on a database failure, which
// makes the message retry. A message that cannot be parsed is quarantined.
bool process(int64_t mailbox, int64_t id);

// Whether the mailbox's index is due a merge: one every `every` messages
bool merge_due(int64_t mailbox, int64_t every);

// One bounded step of FTS5 segment merging
bool merge_index(int64_t mailbox, int64_t pages);

struct IngestStats {
  int64_t queued{0};
  int64_t indexed{0};
  int64_t quarantined{0};       // in the mailboxes: they could not be parsed
  int64_t quarantined_moves{0}; // in the queue: they could not be moved
};
IngestStats ingest_stats();

// Message flags, which the mailbox owner can set
enum MessageFlag : int64_t { Seen = 1, Flagged = 2 };

// Where a message is
enum Folder : int64_t { Inbox = 0, Trash = 1, Spam = 2 };
const int64_t k_last_folder = Spam;

// The unseen count is of the unread mail in the Inbox
inline int64_t counts_unseen(int64_t flags, int64_t folder) {
  return folder == Inbox && (flags & Seen) == 0 ? 1 : 0;
}
#define COUNTS_UNSEEN "flags & 1 = 0 AND folder = 0"

struct Summary {
  int64_t uid{0};
  int64_t state{0};
  int64_t flags{0};
  int64_t modseq{0};
  int64_t received_ns{0};
  int64_t sent_at{0};
  std::string envelope_from;
  std::string subject;
  std::string sender;
  int64_t attachments{0};
  std::string preview;
  int64_t raw_bytes{0};
  int64_t folder{Inbox};
  // The From address alone, as mail_block takes it. Empty when the message
  // is not parsed yet, or has no such address.
  std::string sender_address;
};

// One page, newest first. An absent cursor means there is nothing more.
struct Page {
  std::vector<Summary> items;
  std::optional<int64_t> cursor;
};

Page list_messages(const Mailbox &box, int64_t folder,
                   std::optional<int64_t> cursor, int64_t limit);
// list_messages' query of the Inbox, so that a test can check its plan
extern const char *const k_list_inbox;
bool get_message(const Mailbox &box, int64_t uid, Summary &summary,
                 std::vector<uint8_t> &raw);
// Sets the flags in `set` and clears those in `clear` on each message, so
// that members who change different flags at once keep both changes. Setting
// the seen flag records that `principal` opened the message, at the first
// time they did. A uid that does not exist is skipped. False when the write
// failed.
bool set_flags(const Mailbox &box, const std::vector<uint64_t> &uids,
               int64_t set, int64_t clear, const std::string &principal,
               int64_t now_ns);
struct SeenBy {
  std::string principal;
  int64_t at_ns{0};
};
// Who opened the message, first first
std::vector<SeenBy> seen_by(const Mailbox &box, int64_t uid);

// Deletes the messages still in `folder`, and returns how many, or -1 on
// failure. One that left it meanwhile, as another member restored it, stays.
int64_t delete_messages(const Mailbox &box, const std::vector<uint64_t> &uids,
                        int64_t folder);

// Moves the messages to `folder`, and marks the mailbox for a cleanup when it
// holds expired mail. Mail that arrived more than 30 days ago is deleted
// instead of going to Spam, and does not count. Returns how many moved, or -1
// on failure.
int64_t move_messages(const Mailbox &box, const std::vector<uint64_t> &uids,
                      int64_t folder, int64_t now_ns);

// Mail in Trash is deleted 30 days after it left the Inbox, and mail in Spam
// 30 days after it arrived, by turns of the ingest pump, each a write of its
// own, so a message that cannot be deleted never stops delivery.

// Marks the mailbox for a cleanup, as a delivery refused for its quota does.
// In control.db alone. False on failure.
bool clean_soon(int64_t mailbox);
// Marks the mailbox when its open file holds expired mail, or that cannot be
// read, in the caller's write: after new mail and a move. False on failure.
bool clean_if_expired(const Mailbox &box, int64_t now_ns);
// Ends the mailbox's cleanups until the next mark, as after one that failed,
// unless it was marked again since its claim read `due` marks
bool stop_cleaning(int64_t mailbox, int64_t due);
// Whether any mailbox is marked, or the registry cannot tell
bool clean_pending();
// Claims a marked mailbox, the one after the mailbox cleaned last, with its
// marks in `due`: Claimed, or Again when its file cannot be opened, as
// open_for_pump does
Claim claim_clean(int64_t now_ns, int64_t defer_ns, int64_t &mailbox,
                  int64_t &due);
// Deletes up to 20 expired messages, and ends the mailbox's cleanups once
// none is left. Waits, still marked, while a download holds the file. False
// on failure.
bool clean_expired(int64_t mailbox, int64_t now_ns);

// Words in the query must all match, and are never read as FTS5 syntax. A page
// can be short, even empty, with a cursor: the instruction budget ran out.
Page search(const Mailbox &box, int64_t folder, const std::string &query,
            std::optional<int64_t> cursor, int64_t limit);

// Senders whose mail goes to Spam, by envelope sender or From address. The
// addresses are in lower case.
const int64_t k_max_blocked = 1000;
// True when this call blocked the address, false when it was blocked
// already, nullopt on failure. At k_max_blocked addresses the oldest block
// makes room, so that marking mail as Spam never fails for lack of it.
std::optional<bool> block(const Mailbox &box, const std::string &address,
                          const std::string &principal, int64_t now_ns);
// True when the address was blocked, nullopt on failure
std::optional<bool> unblock(const Mailbox &box, const std::string &address);
struct Blocked {
  std::string address;
  std::string blocked_by;
  int64_t at_ns{0};
};
// The list, newest first, in `found`. False when it cannot be read.
bool blocked(const Mailbox &box, std::vector<Blocked> &found);
// Whether mail from `address` goes to Spam; nullopt when that cannot be read
std::optional<bool> is_blocked(sqlite3 *file, const std::string &address);

// Empties a disabled mailbox. The first call clears what control.db holds for
// it and closes the file; every call then shortens the file by a step, and
// the last deletes it and frees the address. The registry row stays, with its
// uid and outbox counters. Returns the bytes left, or -1 on failure.
int64_t purge_step(int64_t mailbox);

#ifdef EMAIL_CANISTER_TEST_HOOKS
void set_budgets(uint64_t search, uint64_t purge_step_bytes);
#endif

} // namespace store
