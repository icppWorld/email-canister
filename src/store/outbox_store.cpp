#include "outbox_store.h"

#include <limits>

#include "db.h"

namespace {

// Two per send keep the record within the window
const int64_t k_prune_sends = 2;

#define OUTBOX_COLUMNS                                                         \
  "id, state, attempts, created_ns, recipients_to, recipients_cc, "            \
  "recipients_bcc, subject, attachments, bytes, last_error, sent_by"

std::string join_lines(const std::vector<std::string> &items) {
  std::string out;
  for (const std::string &item : items) {
    if (!out.empty()) out.push_back('\n');
    out += item;
  }
  return out;
}

std::vector<std::string> split_lines(const std::string &text) {
  std::vector<std::string> out;
  size_t start = 0;
  while (start < text.size()) {
    size_t end = text.find('\n', start);
    if (end == std::string::npos) end = text.size();
    out.push_back(text.substr(start, end - start));
    start = end + 1;
  }
  return out;
}

store::OutboxSummary read_summary(db::Stmt &row) {
  store::OutboxSummary s;
  s.id = row.column_integer(0);
  s.state = row.column_integer(1);
  s.attempts = row.column_integer(2);
  s.created_ns = row.column_integer(3);
  s.to = split_lines(row.column_text(4));
  s.cc = split_lines(row.column_text(5));
  s.bcc = split_lines(row.column_text(6));
  s.subject = row.column_text(7);
  s.attachments = row.column_integer(8);
  s.bytes = row.column_integer(9);
  s.last_error = row.column_text(10);
  s.sent_by = row.column_text(11);
  return s;
}

size_t base64_size(size_t bytes) { return (bytes + 2) / 3 * 4; }

std::string base64(const void *data, size_t size) {
  static const char *const digits =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const auto *in = static_cast<const uint8_t *>(data);
  std::string out;
  out.reserve(base64_size(size));
  size_t i = 0;
  for (; i + 2 < size; i += 3) {
    const uint32_t v = in[i] << 16 | in[i + 1] << 8 | in[i + 2];
    out.push_back(digits[v >> 18]);
    out.push_back(digits[(v >> 12) & 63]);
    out.push_back(digits[(v >> 6) & 63]);
    out.push_back(digits[v & 63]);
  }
  if (i < size) {
    uint32_t v = in[i] << 16;
    if (i + 1 < size) v |= in[i + 1] << 8;
    out.push_back(digits[v >> 18]);
    out.push_back(digits[(v >> 12) & 63]);
    out.push_back(i + 1 < size ? digits[(v >> 6) & 63] : '=');
    out.push_back('=');
  }
  return out;
}

int64_t payload_bytes(const store::NewOutbox &m) {
  size_t bytes = m.subject.size() + m.html_body.size() + m.client_id.size();
  for (const auto *list : {&m.to, &m.cc, &m.bcc}) {
    for (const std::string &address : *list)
      bytes += address.size();
  }
  for (const store::OutboxAttachment &a : m.attachments) {
    bytes += a.filename.size() + a.content.size();
  }
  return static_cast<int64_t>(bytes);
}

bool delete_rows(sqlite3 *file_db, int64_t id) {
  db::Stmt outbox(file_db, "DELETE FROM outbox WHERE id = ?");
  db::Stmt body(file_db, "DELETE FROM outbox_bodies WHERE id = ?");
  db::Stmt attachments(file_db,
                       "DELETE FROM outbox_attachments WHERE outbox_id = ?");
  return outbox && body && attachments && outbox.integer(1, id).done() &&
         body.integer(1, id).done() && attachments.integer(1, id).done();
}

// Copies when the mailbox's next message is due into the registry, which is
// where the pump looks
bool refresh_due(int64_t mailbox, sqlite3 *file_db) {
  db::Stmt due(file_db, "SELECT coalesce(min(next_attempt_ns), 0) FROM outbox "
                        "WHERE state IN (0, 1)");
  db::Stmt update(db::control(),
                  "UPDATE mailboxes SET outbox_due_ns = ? WHERE id = ?");
  return due && update && due.row() &&
         update.integer(1, due.column_integer(0)).integer(2, mailbox).done();
}

enum class Removed { Done, Missing, Sending, Failed };

// Deletes one message in the caller's MailboxWrite, and adds the bytes it
// frees to `bytes`; the caller gives them back to the quota
Removed remove_message(const store::Mailbox &box, int64_t id, int64_t &bytes) {
  int64_t size = 0;
  bool untried = false;
  {
    db::Stmt select(box.file,
                    "SELECT state, bytes, attempts, generation FROM outbox "
                    "WHERE id = ?");
    if (!select) return Removed::Failed;
    if (!select.integer(1, id).row()) {
      return select.failed() ? Removed::Failed : Removed::Missing;
    }
    if (select.column_integer(0) == store::OutSending) return Removed::Sending;
    size = select.column_integer(1);
    // A resend starts its attempts again, but the first try may have gone out
    untried = select.column_integer(0) == store::OutQueued &&
              select.column_integer(2) == 0 && select.column_integer(3) == 0;
  }
  if (!delete_rows(box.file, id)) return Removed::Failed;
  // Mail that never left frees its client_id: a retry sends it once
  if (untried) {
    db::Stmt forget(db::control(),
                    "DELETE FROM sends WHERE mailbox_id = ? AND outbox_id = ?");
    if (!forget || !forget.integer(1, box.id).integer(2, id).done()) {
      return Removed::Failed;
    }
  }
  bytes += size;
  return Removed::Done;
}

} // namespace

namespace store {

std::string bridge() {
  db::Stmt select(db::control(),
                  "SELECT value FROM settings WHERE key = 'bridge'");
  return select && select.row() ? select.column_text(0) : "";
}

bool set_bridge(const std::string &principal) {
  db::Stmt upsert(db::control(),
                  "INSERT OR REPLACE INTO settings VALUES('bridge', ?)");
  return upsert && upsert.text(1, principal).done();
}

size_t outbox_encoded_size(const NewOutbox &m) {
  // As the bridge's jsonString escapes text in its JSON: a quote, a backslash,
  // \n, \r and \t take two bytes, any other control character six. Change the
  // two together.
  const auto json_size = [](const std::string &text) {
    size_t size = 0;
    for (const unsigned char c : text) {
      size += c == '"' || c == '\\' || c == '\n' || c == '\r' || c == '\t' ? 2
              : c < 0x20                                                   ? 6
                                                                           : 1;
    }
    return size;
  };
  size_t size = json_size(m.subject) + json_size(m.html_body);
  for (const auto *list : {&m.to, &m.cc, &m.bcc}) {
    for (const std::string &address : *list)
      size += json_size(address);
  }
  for (const OutboxAttachment &a : m.attachments) {
    size += json_size(a.filename) + base64_size(a.content.size());
  }
  return size;
}

Lookup sent_from(const std::string &principal, const std::string &client_id,
                 int64_t since_ns, int64_t &mailbox, std::string &local,
                 int64_t &id) {
  db::Stmt sent(db::control(),
                "SELECT s.mailbox_id, m.local, s.outbox_id FROM sends s "
                "JOIN mailboxes m ON m.id = s.mailbox_id "
                "WHERE s.principal = ? AND s.client_id = ? AND s.at_ns >= ?");
  if (!sent) return Lookup::Failed;
  if (sent.text(1, principal).text(2, client_id).integer(3, since_ns).row()) {
    mailbox = sent.column_integer(0);
    local = sent.column_text(1);
    id = sent.column_integer(2);
    return Lookup::Found;
  }
  return sent.failed() ? Lookup::Failed : Lookup::Missing;
}

bool record_send(const std::string &principal, const std::string &client_id,
                 int64_t mailbox, int64_t id, int64_t now_ns,
                 int64_t since_ns) {
  db::Stmt prune(db::control(),
                 "DELETE FROM sends WHERE id IN (SELECT id FROM sends "
                 "WHERE at_ns < ? ORDER BY at_ns LIMIT ?)");
  db::Stmt record(db::control(),
                  "INSERT OR REPLACE INTO sends(principal, client_id, "
                  "mailbox_id, outbox_id, at_ns) VALUES(?, ?, ?, ?, ?)");
  return prune && prune.integer(1, since_ns).integer(2, k_prune_sends).done() &&
         record &&
         record.text(1, principal)
             .text(2, client_id)
             .integer(3, mailbox)
             .integer(4, id)
             .integer(5, now_ns)
             .done();
}

Enqueue outbox_enqueue(const Mailbox &box, const NewOutbox &m, int64_t now_ns,
                       int64_t &id) {
  {
    // After the registry's window, the file still knows its own messages
    db::Stmt seen(box.file,
                  "SELECT id FROM outbox WHERE sent_by = ? AND client_id = ?");
    if (!seen) return Enqueue::Failed;
    if (seen.text(1, m.sent_by).text(2, m.client_id).row()) {
      id = seen.column_integer(0);
      return Enqueue::Duplicate;
    }
    if (seen.failed()) return Enqueue::Failed;
  }
  MailboxWrite write(box);
  if (!write) return Enqueue::Failed;

  const int64_t bytes = payload_bytes(m);
  {
    db::Stmt reserve(db::control(),
                     "UPDATE mailboxes SET used_bytes = used_bytes + ?1, "
                     "next_outbox_id = next_outbox_id + 1 "
                     "WHERE id = ?2 AND used_bytes + ?1 <= quota_bytes "
                     "RETURNING next_outbox_id - 1");
    if (!reserve) return Enqueue::Failed;
    if (!reserve.integer(1, bytes).integer(2, box.id).row()) {
      return reserve.failed() ? Enqueue::Failed : Enqueue::OverQuota;
    }
    id = reserve.column_integer(0);
    if (!reserve.done()) return Enqueue::Failed;
  }
  std::string key_prefix;
  {
    // The prefix keeps keys unique at the bridge if the canister is reinstalled
    db::Stmt prefix(db::control(),
                    "SELECT value FROM settings WHERE key = 'outbox_prefix'");
    if (!prefix || !prefix.row()) return Enqueue::Failed;
    key_prefix = prefix.column_text(0) + "-" + std::to_string(box.id) + "-" +
                 std::to_string(id);
  }

  const std::string to = join_lines(m.to);
  const std::string cc = join_lines(m.cc);
  const std::string bcc = join_lines(m.bcc);
  db::Stmt insert(
      box.file,
      "INSERT INTO outbox(id, client_id, key_prefix, state, created_ns, "
      "next_attempt_ns, recipients_to, recipients_cc, recipients_bcc, "
      "subject, attachments, bytes, sent_by) "
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  if (!insert) return Enqueue::Failed;
  insert.integer(1, id)
      .text(2, m.client_id)
      .text(3, key_prefix)
      .integer(4, OutQueued)
      .integer(5, now_ns)
      .integer(6, now_ns)
      .text(7, to)
      .text(8, cc)
      .text(9, bcc)
      .text(10, m.subject)
      .integer(11, static_cast<int64_t>(m.attachments.size()))
      .integer(12, bytes)
      .text(13, m.sent_by);
  if (!insert.done()) return Enqueue::Failed;

  db::Stmt body(box.file, "INSERT INTO outbox_bodies(id, html) VALUES(?, ?)");
  if (!body || !body.integer(1, id).text(2, m.html_body).done()) {
    return Enqueue::Failed;
  }
  db::Stmt attachment(
      box.file, "INSERT INTO outbox_attachments(outbox_id, filename, content) "
                "VALUES(?,?,?)");
  if (!attachment) return Enqueue::Failed;
  for (const OutboxAttachment &a : m.attachments) {
    attachment.reset();
    attachment.integer(1, id)
        .text(2, a.filename)
        .blob(3,
              a.content.empty() ? ""
                                : static_cast<const void *>(a.content.data()),
              a.content.size());
    if (!attachment.done()) return Enqueue::Failed;
  }
  if (!refresh_due(box.id, box.file) || !write.commit()) return Enqueue::Failed;
  return Enqueue::Stored;
}

Claim outbox_claim(int64_t now_ns, int64_t lease_ns, int64_t abandon_ns,
                   OutboxRequest &r) {
  {
    // A purge sets outbox_due_ns to 0
    db::Stmt due(db::control(),
                 "SELECT id, local FROM mailboxes WHERE outbox_due_ns > 0 "
                 "AND max(outbox_due_ns, retry_after_ns) <= ? AND disabled = 0 "
                 "AND schema = ? "
                 "ORDER BY max(outbox_due_ns, retry_after_ns) LIMIT 1");
    if (!due) return Claim::Failed;
    // A file that waits for its upgrade is the ingest pump's, which then
    // arms the outbox
    if (!due.integer(1, now_ns).integer(2, db::mailbox_version()).row())
      return due.failed() ? Claim::Failed : Claim::Empty;
    r.mailbox = due.column_integer(0);
    r.from_username = due.column_text(1);
  }
  sqlite3 *file_db = nullptr;
  const Claim open = open_for_pump(r.mailbox, now_ns + lease_ns, file_db);
  if (open != Claim::Claimed) return open;
  MailboxWrite write(Mailbox{r.mailbox, file_db});
  if (!write) return Claim::Failed;

  bool found = false;
  bool abandoned = false;
  {
    db::Stmt due(
        file_db,
        "SELECT id, generation, key_prefix, recipients_to, recipients_cc, "
        "recipients_bcc, subject, state = 1 AND ?1 - first_attempt_ns >= ?2 "
        "FROM outbox WHERE state IN (0, 1) AND next_attempt_ns <= ?1 "
        "ORDER BY next_attempt_ns LIMIT 1");
    if (!due) return Claim::Failed;
    found = due.integer(1, now_ns).integer(2, abandon_ns).row();
    if (!found && due.failed()) return Claim::Failed;
    if (found) {
      r.id = due.column_integer(0);
      r.generation = due.column_integer(1);
      r.key = due.column_text(2) + "-" + std::to_string(r.generation);
      r.to = split_lines(due.column_text(3));
      r.cc = split_lines(due.column_text(4));
      r.bcc = split_lines(due.column_text(5));
      r.subject = due.column_text(6);
      abandoned = due.column_integer(7) != 0;
    }
  }
  if (!found || abandoned) {
    db::Stmt unknown(
        file_db, "UPDATE outbox SET state = 4, last_error = "
                 "'no outcome for a day: it may have been sent' WHERE id = ?");
    const bool ok = !found || (unknown && unknown.integer(1, r.id).done());
    return ok && refresh_due(r.mailbox, file_db) && write.commit()
               ? Claim::Again
               : Claim::Failed;
  }
  {
    db::Stmt body(file_db, "SELECT html FROM outbox_bodies WHERE id = ?");
    if (!body || !body.integer(1, r.id).row()) return Claim::Failed;
    r.html_body = body.column_text(0);
  }
  {
    db::Stmt files(file_db, "SELECT filename, content FROM outbox_attachments "
                            "WHERE outbox_id = ? ORDER BY id");
    if (!files) return Claim::Failed;
    files.integer(1, r.id);
    while (files.row()) {
      r.attachments.emplace_back(
          files.column_text(0),
          base64(files.column_blob(1), files.column_bytes(1)));
    }
    if (files.failed()) return Claim::Failed;
  }
  db::Stmt lease(
      file_db,
      "UPDATE outbox SET state = 1, attempts = attempts + 1, "
      "next_attempt_ns = ?1, "
      "first_attempt_ns = iif(first_attempt_ns = 0, ?2, first_attempt_ns) "
      "WHERE id = ?3");
  return lease &&
                 lease.integer(1, now_ns + lease_ns)
                     .integer(2, now_ns)
                     .integer(3, r.id)
                     .done() &&
                 refresh_due(r.mailbox, file_db) && write.commit()
             ? Claim::Claimed
             : Claim::Failed;
}

bool outbox_defer(int64_t mailbox, int64_t due_ns) {
  db::Stmt update(db::control(), "UPDATE mailboxes SET outbox_due_ns = ? "
                                 "WHERE id = ? AND outbox_due_ns > 0");
  return update && update.integer(1, due_ns).integer(2, mailbox).done();
}

bool outbox_next_due(int64_t &at_ns) {
  db::Stmt due(
      db::control(),
      "SELECT min(max(outbox_due_ns, retry_after_ns)) FROM mailboxes "
      "WHERE outbox_due_ns > 0 AND disabled = 0 AND retry_after_ns < ? "
      "AND schema = ?");
  if (!due ||
      !due.integer(1, store::k_held_ns)
           .integer(2, db::mailbox_version())
           .row() ||
      due.column_is_null(0))
    return false;
  at_ns = due.column_integer(0);
  return true;
}

void outbox_apply(const OutboxRequest &request, Outcome outcome,
                  const std::string &detail, int64_t now_ns,
                  int64_t deadline_ns) {
  MailboxWrite write(request.mailbox);
  // Purged, or the file cannot be opened: then the lease runs out, and the next
  // claim asks the bridge again under the same key
  if (!write) return;
  sqlite3 *file_db = write.file();
  // A late Sent or Rejected is the truth, and corrects an earlier Unknown.
  // A retry is still undecided: the lease from the claim schedules it.
  const int64_t state = outcome == Outcome::Sent       ? OutSent
                        : outcome == Outcome::Rejected ? OutRejected
                                                       : OutUnknown;
  db::Stmt update(
      file_db,
      outcome == Outcome::Retry
          ? "UPDATE outbox SET last_error = ?2, state = iif(?5 - first_attempt_ns >= ?6, 4, 1) "
            "WHERE id = ?3 AND generation = ?4 AND state = 1"
      : outcome == Outcome::Unknown
          ? "UPDATE outbox SET state = ?1, last_error = ?2 "
            "WHERE id = ?3 AND generation = ?4 AND state = 1"
          : "UPDATE outbox SET state = ?1, last_error = ?2 "
            "WHERE id = ?3 AND generation = ?4 AND state IN (1, 4)");
  if (!update) return;
  update
      .integer(1, state) // unused by a retry, which leaves the state alone
      .text(2, detail)
      .integer(3, request.id)
      .integer(4, request.generation);
  if (outcome == Outcome::Retry)
    update.integer(5, now_ns).integer(6, deadline_ns);
  if (update.done() && refresh_due(request.mailbox, file_db)) write.commit();
}

OutboxPage outbox_list(const Mailbox &box, std::optional<int64_t> cursor,
                       int64_t limit) {
  OutboxPage page;
  db::Stmt select(box.file, "SELECT " OUTBOX_COLUMNS " FROM outbox "
                            "WHERE id < ? ORDER BY id DESC LIMIT ?");
  if (!select) return page;
  select.integer(1, cursor.value_or(std::numeric_limits<int64_t>::max()))
      .integer(2, limit + 1);
  while (select.row()) {
    if (static_cast<int64_t>(page.items.size()) == limit) {
      page.cursor = page.items.back().id;
      break;
    }
    page.items.push_back(read_summary(select));
  }
  return page;
}

bool outbox_get(const Mailbox &box, int64_t id, OutboxSummary &summary,
                std::string &html_body,
                std::vector<OutboxAttachment> &attachments) {
  {
    db::Stmt select(box.file,
                    "SELECT " OUTBOX_COLUMNS " FROM outbox WHERE id = ?");
    if (!select || !select.integer(1, id).row()) return false;
    summary = read_summary(select);
  }
  db::Stmt body(box.file, "SELECT html FROM outbox_bodies WHERE id = ?");
  if (!body || !body.integer(1, id).row()) return false;
  html_body = body.column_text(0);
  db::Stmt files(box.file, "SELECT filename, content FROM outbox_attachments "
                           "WHERE outbox_id = ? ORDER BY id");
  if (!files) return false;
  files.integer(1, id);
  while (files.row()) {
    OutboxAttachment a;
    a.filename = files.column_text(0);
    const auto *bytes = static_cast<const uint8_t *>(files.column_blob(1));
    if (bytes != nullptr)
      a.content.assign(bytes, bytes + files.column_bytes(1));
    attachments.push_back(std::move(a));
  }
  return !files.failed();
}

std::string outbox_resend(const Mailbox &box, int64_t id, int64_t now_ns) {
  MailboxWrite write(box);
  if (!write) return "the resend failed";
  db::Stmt update(box.file,
                  "UPDATE outbox SET state = 0, generation = generation + 1, "
                  "attempts = 0, first_attempt_ns = 0, next_attempt_ns = ?1, "
                  "last_error = '' WHERE id = ?2 AND state IN (3, 4)");
  if (!update || !update.integer(1, now_ns).integer(2, id).done()) {
    return "the resend failed";
  }
  if (db::changes(box.file) != 1)
    return "only rejected or unknown mail can be resent";
  return refresh_due(box.id, box.file) && write.commit() ? ""
                                                         : "the resend failed";
}

std::string outbox_delete(const Mailbox &box, int64_t id) {
  MailboxWrite write(box);
  if (!write) return "the delete failed";
  int64_t bytes = 0;
  switch (remove_message(box, id, bytes)) {
  case Removed::Done:
    break;
  case Removed::Missing:
    return "no such message";
  case Removed::Sending:
    return "this message is being sent";
  case Removed::Failed:
    return "the delete failed";
  }
  return release_quota(box.id, bytes) && refresh_due(box.id, box.file) &&
                 write.commit()
             ? ""
             : "the delete failed";
}

bool outbox_delete_many(const Mailbox &box, const std::vector<uint64_t> &ids,
                        std::vector<uint64_t> &deleted) {
  MailboxWrite write(box);
  if (!write) return false;
  int64_t bytes = 0;
  // A repeated id is gone by its second turn, so its bytes count once
  for (const uint64_t id : ids) {
    switch (remove_message(box, static_cast<int64_t>(id), bytes)) {
    case Removed::Done:
      deleted.push_back(id);
      break;
    case Removed::Missing:
    case Removed::Sending:
      break;
    case Removed::Failed:
      return false;
    }
  }
  if (deleted.empty()) return true; // nothing to write
  return release_quota(box.id, bytes) && refresh_due(box.id, box.file) &&
         write.commit();
}

} // namespace store
