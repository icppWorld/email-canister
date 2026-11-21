#include "queue_store.h"

#include "allowlist.h"
#include "db.h"
#include "ic_api.h"
#include "mail_store.h"

namespace {

const int64_t k_prune_keys = 100;

struct QueueRow {
  int64_t mailbox{0};
  int64_t body_id{0};
  std::string envelope_from;
  std::string rfc_message_id;
  std::string dedupe_key;
  int64_t received_ns{0};
  int64_t raw_bytes{0};
};

// Puts a message into its file, with a uid and modseq from the registry: in
// Spam when its envelope sender is blocked, else in the Inbox. Spam's 30 days
// count from its arrival.
bool store_in_file(sqlite3 *file_db, const QueueRow &row) {
  const std::optional<bool> spam =
      store::is_blocked(file_db, row.envelope_from);
  if (!spam) return false;
  const int64_t folder = *spam ? store::Spam : store::Inbox;
  int64_t uid = 0;
  int64_t modseq = 0;
  {
    db::Stmt counters(db::control(),
                      "UPDATE mailboxes SET next_uid = next_uid + 1, "
                      "modseq = modseq + 1, message_count = message_count + 1, "
                      "unseen = unseen + ?, unparsed = unparsed + 1 "
                      "WHERE id = ? "
                      "RETURNING next_uid - 1, modseq");
    if (!counters || !counters.integer(1, store::counts_unseen(0, folder))
                          .integer(2, row.mailbox)
                          .row())
      return false;
    uid = counters.column_integer(0);
    modseq = counters.column_integer(1);
    if (!counters.done()) return false;
  }
  db::Stmt insert(file_db,
                  "INSERT INTO messages(uid, state, modseq, received_ns, "
                  "envelope_from, rfc_message_id, dedupe_key, raw_bytes, "
                  "folder, folder_ns) VALUES(?,0,?,?,?,?,?,?,?,?)");
  if (!insert || !insert.integer(1, uid)
                      .integer(2, modseq)
                      .integer(3, row.received_ns)
                      .text(4, row.envelope_from)
                      .text(5, row.rfc_message_id)
                      .text(6, row.dedupe_key)
                      .integer(7, row.raw_bytes)
                      .integer(8, folder)
                      .integer(9, *spam ? row.received_ns : 0)
                      .done()) {
    return false;
  }
  db::Stmt raw(db::control(), "SELECT raw FROM queue_bodies WHERE id = ?");
  db::Stmt body(file_db, "INSERT INTO bodies(id, raw) VALUES(?, ?)");
  return raw && body && raw.integer(1, row.body_id).row() &&
         body.integer(1, db::last_insert_id(file_db))
             .blob(2, raw.column_blob(0), raw.column_bytes(0))
             .done();
}

// Deletes a queue row, and its body once no other recipient needs it
bool remove_row(int64_t queue_id, int64_t body_id) {
  db::Stmt row(db::control(), "DELETE FROM queue WHERE id = ?");
  db::Stmt share(db::control(),
                 "UPDATE queue_bodies SET recipients = recipients - 1 "
                 "WHERE id = ?");
  db::Stmt body(db::control(),
                "DELETE FROM queue_bodies WHERE id = ? AND recipients <= 0");
  return row && share && body && row.integer(1, queue_id).done() &&
         share.integer(1, body_id).done() && body.integer(1, body_id).done();
}

} // namespace

namespace store {

int64_t queued(int64_t mailbox) {
  // Rows whose move was quarantined count too
  db::Stmt count(db::control(),
                 "SELECT count(*) FROM queue WHERE mailbox_id = ?");
  if (!count || !count.integer(1, mailbox).row()) return -1;
  return count.column_integer(0);
}

Insert queue_message(int64_t mailbox, const IncomingMessage &message,
                     int64_t &body_id, int64_t mailbox_cap,
                     int64_t dedupe_since_ns) {
  {
    db::Stmt seen(
        db::control(),
        "SELECT EXISTS(SELECT 1 FROM dedupe WHERE mailbox_id = ?1 AND "
        "envelope_from = ?2 AND dedupe_key = ?3 AND at_ns >= ?4) OR "
        "EXISTS(SELECT 1 FROM queue WHERE mailbox_id = ?1 AND "
        "envelope_from = ?2 AND dedupe_key = ?3)");
    if (!seen || !seen.integer(1, mailbox)
                      .text(2, message.envelope_from)
                      .text(3, message.dedupe_key)
                      .integer(4, dedupe_since_ns)
                      .row()) {
      return Insert::Failed;
    }
    if (seen.column_integer(0) != 0) return Insert::Duplicate;
  }
  const int64_t waiting = queued(mailbox);
  if (waiting < 0) return Insert::Failed;
  if (waiting >= mailbox_cap) return Insert::Full;
  const auto raw_bytes = static_cast<int64_t>(message.raw->size());
  {
    db::Stmt reserve(db::control(),
                     "UPDATE mailboxes SET used_bytes = used_bytes + ?1 "
                     "WHERE id = ?2 AND used_bytes + ?1 <= quota_bytes");
    if (!reserve || !reserve.integer(1, raw_bytes).integer(2, mailbox).done()) {
      return Insert::Failed;
    }
    if (db::changes(db::control()) != 1) return Insert::OverQuota;
  }
  if (body_id == 0) {
    db::Stmt body(db::control(),
                  "INSERT INTO queue_bodies(raw, recipients) VALUES(?, 0)");
    if (!body ||
        !body.blob(1, message.raw->data(), message.raw->size()).done()) {
      return Insert::Failed;
    }
    body_id = db::last_insert_id(db::control());
  }
  db::Stmt insert(db::control(),
                  "INSERT INTO queue(mailbox_id, body_id, envelope_from, "
                  "rfc_message_id, dedupe_key, received_ns, raw_bytes) "
                  "VALUES(?,?,?,?,?,?,?)");
  db::Stmt share(db::control(),
                 "UPDATE queue_bodies SET recipients = recipients + 1 "
                 "WHERE id = ?");
  // An expired key may still be there: the moves prune them a few at a time
  db::Stmt key(db::control(),
               "INSERT OR REPLACE INTO dedupe(mailbox_id, envelope_from, "
               "dedupe_key, at_ns) VALUES(?,?,?,?)");
  const bool ok = insert && share && key &&
                  insert.integer(1, mailbox)
                      .integer(2, body_id)
                      .text(3, message.envelope_from)
                      .text(4, message.rfc_message_id)
                      .text(5, message.dedupe_key)
                      .integer(6, message.received_ns)
                      .integer(7, raw_bytes)
                      .done() &&
                  share.integer(1, body_id).done() &&
                  key.integer(1, mailbox)
                      .text(2, message.envelope_from)
                      .text(3, message.dedupe_key)
                      .integer(4, message.received_ns)
                      .done();
  return ok ? Insert::Stored : Insert::Failed;
}

int64_t backlog(int64_t at_ns) {
  // A file newer than this release waits for another release, as a held one
  // waits for its repair. INT64_MAX counts both.
  const int64_t version =
      at_ns == INT64_MAX ? INT64_MAX : db::mailbox_version();
  db::Stmt count(
      db::control(),
      "SELECT (SELECT count(*) FROM queue q JOIN mailboxes m ON m.id = q.mailbox_id "
      "WHERE q.quarantined = 0 AND m.retry_after_ns <= ?1 AND m.schema <= ?2) + "
      "(SELECT coalesce(sum(unparsed), 0) FROM mailboxes "
      "WHERE unparsed > 0 AND retry_after_ns <= ?1 AND schema <= ?2)");
  return count && count.integer(1, at_ns).integer(2, version).row()
             ? count.column_integer(0)
             : -1;
}

bool deferred_until(int64_t now_ns, int64_t &at_ns) {
  db::Stmt select(
      db::control(),
      "SELECT min(retry_after_ns) FROM mailboxes m WHERE retry_after_ns > 0 AND "
      "retry_after_ns > ?1 AND retry_after_ns < ?3 AND schema <= ?2 AND "
      "(unparsed > 0 OR clean_due > 0 OR "
      "" WAITS_FOR_UPGRADE(
          "?2") " OR EXISTS(SELECT 1 FROM queue q "
                "WHERE q.mailbox_id = m.id AND q.quarantined = 0))");
  if (!select ||
      !select.integer(1, now_ns)
           .integer(2, db::mailbox_version())
           .integer(3, k_held_ns)
           .row() ||
      select.column_is_null(0))
    return false;
  at_ns = select.column_integer(0);
  return true;
}

Claim claim_move(int64_t max_attempts, int64_t now_ns, int64_t defer_ns,
                 int64_t &queue_id) {
  int64_t attempts = 0;
  int64_t mailbox = 0;
  {
    // A file of another version waits for its upgrade or its release
    db::Stmt select(db::control(),
                    "SELECT q.id, q.attempts, q.mailbox_id FROM queue q "
                    "JOIN mailboxes m ON m.id = q.mailbox_id "
                    "WHERE q.quarantined = 0 AND m.retry_after_ns <= ?1 "
                    "AND m.schema = ?2 "
                    "ORDER BY q.id LIMIT 1");
    if (!select) return Claim::Failed;
    if (!select.integer(1, now_ns).integer(2, db::mailbox_version()).row()) {
      return select.failed() ? Claim::Failed : Claim::Empty;
    }
    queue_id = select.column_integer(0);
    attempts = select.column_integer(1);
    mailbox = select.column_integer(2);
  }
  // An attempt is for a move that can fail, not for a file that will not open
  sqlite3 *file = nullptr;
  const Claim open = open_for_pump(mailbox, now_ns + defer_ns, file);
  if (open != Claim::Claimed) return open;
  if (attempts >= max_attempts) {
    db::Stmt quarantine(db::control(),
                        "UPDATE queue SET quarantined = 1 WHERE id = ?");
    return quarantine && quarantine.integer(1, queue_id).done() ? Claim::Again
                                                                : Claim::Failed;
  }
  db::Stmt update(db::control(),
                  "UPDATE queue SET attempts = attempts + 1 WHERE id = ?");
  return update && update.integer(1, queue_id).done() ? Claim::Claimed
                                                      : Claim::Failed;
}

// An attempt that does not count, for a move that waits or never ran
static bool give_back_move_attempt(int64_t queue_id) {
  db::Stmt back(
      db::control(),
      "UPDATE queue SET attempts = max(0, attempts - 1) WHERE id = ?");
  return back && back.integer(1, queue_id).done();
}

void record_move_failure(int64_t queue_id, const std::string &error,
                         bool attempted) {
  // A call that never ran keeps the last real error
  if (!attempted) {
    give_back_move_attempt(queue_id);
    return;
  }
  db::Stmt update(db::control(),
                  "UPDATE queue SET last_error = ? WHERE id = ?");
  update.text(1, error).integer(2, queue_id).done();
}

bool move(int64_t queue_id, int64_t dedupe_since_ns) {
  QueueRow row;
  {
    db::Stmt select(db::control(),
                    "SELECT mailbox_id, body_id, envelope_from, "
                    "rfc_message_id, dedupe_key, received_ns, raw_bytes "
                    "FROM queue WHERE id = ?");
    if (!select) return false;
    if (!select.integer(1, queue_id).row())
      return !select.failed(); // purged since
    row.mailbox = select.column_integer(0);
    row.body_id = select.column_integer(1);
    row.envelope_from = select.column_text(2);
    row.rfc_message_id = select.column_text(3);
    row.dedupe_key = select.column_text(4);
    row.received_ns = select.column_integer(5);
    row.raw_bytes = select.column_integer(6);
  }
  if (exporting(row.mailbox)) {
    // A download began after the claim: the move waits for it, without
    // counting this attempt
    return give_back_move_attempt(queue_id);
  }
  MailboxWrite write(row.mailbox);
  if (!write) return false;

  bool ok = false;
  {
    // Seen after the dedupe window: the reserved bytes go back
    db::Stmt seen(write.file(), "SELECT EXISTS(SELECT 1 FROM messages WHERE "
                                "envelope_from = ? AND dedupe_key = ?)");
    ok = seen && seen.text(1, row.envelope_from).text(2, row.dedupe_key).row();
    if (ok && seen.column_integer(0) != 0) {
      ok = release_quota(row.mailbox, row.raw_bytes);
    } else if (ok) {
      ok = store_in_file(write.file(), row);
    }
  }
  // New mail has the pump clear out expired mail from Trash and Spam, in a
  // write of its own: a message that cannot be deleted then stops no delivery
  ok = ok && clean_if_expired(Mailbox{row.mailbox, write.file()},
                              static_cast<int64_t>(IC_API::time()));
  db::Stmt prune(db::control(),
                 "DELETE FROM dedupe WHERE id IN (SELECT id FROM dedupe "
                 "WHERE at_ns < ? ORDER BY at_ns LIMIT ?)");
  ok = ok && remove_row(queue_id, row.body_id) && prune &&
       prune.integer(1, dedupe_since_ns).integer(2, k_prune_keys).done();
  return ok && write.commit();
}

int64_t retry_moves(int64_t mailbox) {
  db::Stmt update(db::control(),
                  "UPDATE queue SET quarantined = 0, attempts = 0 "
                  "WHERE mailbox_id = ? AND quarantined = 1");
  if (!update || !update.integer(1, mailbox).done()) return -1;
  return db::changes(db::control());
}

bool clear_queue(int64_t mailbox) {
  db::Stmt share(
      db::control(),
      "UPDATE queue_bodies SET recipients = recipients - "
      "(SELECT count(*) FROM queue q WHERE q.body_id = queue_bodies.id "
      "AND q.mailbox_id = ?1) "
      "WHERE id IN (SELECT body_id FROM queue WHERE mailbox_id = ?1)");
  db::Stmt bodies(db::control(),
                  "DELETE FROM queue_bodies WHERE recipients <= 0 AND "
                  "id IN (SELECT body_id FROM queue WHERE mailbox_id = ?)");
  db::Stmt rows(db::control(), "DELETE FROM queue WHERE mailbox_id = ?");
  db::Stmt keys(db::control(), "DELETE FROM dedupe WHERE mailbox_id = ?");
  return share && bodies && rows && keys && share.integer(1, mailbox).done() &&
         bodies.integer(1, mailbox).done() && rows.integer(1, mailbox).done() &&
         keys.integer(1, mailbox).done();
}

} // namespace store
