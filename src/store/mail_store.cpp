#include "mail_store.h"

#include <algorithm>
#include <limits>

#include "db.h"
#include "ic_api.h"
#include "mime_extract.h"
#include "queue_store.h"

namespace {

const size_t k_preview_chars = 200;
uint64_t g_search_budget = 3'000'000'000; // a query may use 5B
int64_t g_purge_step_bytes = 1LL << 30;

// The mailbox parsed last: the next parse takes the one after it, so that a
// mailbox whose claim keeps failing holds up no other
int64_t g_parsed_last = 0;
const size_t k_max_query_bytes = 512;
const size_t k_max_query_words = 16;

#define SUMMARY_COLUMNS                                                        \
  "uid, state, flags, modseq, received_ns, sent_at, envelope_from, subject, "  \
  "sender, attachments, preview, raw_bytes"

store::Summary read_summary(db::Stmt &row) {
  store::Summary s;
  s.uid = row.column_integer(0);
  s.state = row.column_integer(1);
  s.flags = row.column_integer(2);
  s.modseq = row.column_integer(3);
  s.received_ns = row.column_integer(4);
  s.sent_at = row.column_integer(5);
  s.envelope_from = row.column_text(6);
  s.subject = row.column_text(7);
  s.sender = row.column_text(8);
  s.attachments = row.column_integer(9);
  s.preview = row.column_text(10);
  s.raw_bytes = row.column_integer(11);
  return s;
}

// Every word as a quoted FTS5 string, so that none of it is query syntax
std::string fts_query(const std::string &query) {
  std::string out;
  std::string word;
  size_t words = 0;
  const auto end_word = [&]() {
    if (!word.empty() && words < k_max_query_words) {
      out += out.empty() ? "\"" : " \"";
      out += word;
      out += '"';
      ++words;
    }
    word.clear();
  };
  for (size_t i = 0; i < std::min(query.size(), k_max_query_bytes); ++i) {
    const auto c = static_cast<unsigned char>(query[i]);
    if (c <= ' ') {
      end_word();
    } else if (c == '"') {
      word += "\"\"";
    } else {
      word.push_back(query[i]);
    }
  }
  end_word();
  return out;
}

// The first characters of the text with whitespace collapsed
std::string make_preview(const char *text) {
  std::string out;
  size_t chars = 0;
  bool space = false;
  for (const char *p = text; *p != '\0'; ++p) {
    const auto c = static_cast<unsigned char>(*p);
    if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
      space = !out.empty();
      continue;
    }
    const bool starts_char = (c & 0xC0) != 0x80;
    if (starts_char && chars == k_preview_chars) break;
    if (space) out.push_back(' ');
    space = false;
    out.push_back(*p);
    if (starts_char) ++chars;
  }
  return out;
}

// Keeps a message that cannot be parsed, viewable, out of the parse queue
bool quarantine(const store::Mailbox &box, int64_t id, int64_t attempts,
                const std::string &error) {
  store::MailboxWrite write(box);
  if (!write) return false;
  db::Stmt update(box.file,
                  "UPDATE messages SET state = ?, attempts = ?, last_error = ? "
                  "WHERE id = ? AND state = ?");
  db::Stmt count(db::control(),
                 "UPDATE mailboxes SET unparsed = unparsed - 1, "
                 "quarantined = quarantined + 1, parse_attempts = 0, "
                 "parse_error = '' WHERE id = ?");
  if (!update || !count ||
      !update.integer(1, store::Quarantined)
           .integer(2, attempts)
           .text(3, error)
           .integer(4, id)
           .integer(5, store::Queued)
           .done()) {
    return false;
  }
  return (db::changes(box.file) == 0 || count.integer(1, box.id).done()) &&
         write.commit();
}

std::string or_empty(const char *s) { return s == nullptr ? "" : s; }

// The rest of claim_parse, once the file is open
store::Claim claim_in_file(const store::Mailbox &box, int64_t max_attempts,
                           int64_t parse_id, int64_t attempts,
                           std::string error, int64_t &id) {
  const int64_t mailbox = box.id;
  {
    db::Stmt first(
        box.file,
        "SELECT id FROM messages WHERE state = 0 ORDER BY id LIMIT 1");
    if (!first) return store::Claim::Failed;
    if (!first.row()) {
      if (first.failed()) return store::Claim::Failed;
      db::Stmt reset(db::control(),
                     "UPDATE mailboxes SET unparsed = 0 WHERE id = ?");
      return reset && reset.integer(1, mailbox).done() ? store::Claim::Again
                                                       : store::Claim::Failed;
    }
    id = first.column_integer(0);
  }
  if (id != parse_id) {
    attempts = 0;
    error.clear();
  }
  if (attempts >= max_attempts) {
    return quarantine(box, id, attempts,
                      "processing failed repeatedly: " + error)
               ? store::Claim::Again
               : store::Claim::Failed;
  }
  db::Stmt update(db::control(),
                  "UPDATE mailboxes SET parse_id = ?, parse_attempts = ?, "
                  "parse_error = ? WHERE id = ?");
  return update && update.integer(1, id)
                       .integer(2, attempts + 1)
                       .text(3, error)
                       .integer(4, mailbox)
                       .done()
             ? store::Claim::Claimed
             : store::Claim::Failed;
}

} // namespace

namespace store {

std::string domain() {
  db::Stmt select(db::control(),
                  "SELECT value FROM settings WHERE key = 'domain'");
  return select && select.row() ? select.column_text(0) : "";
}

bool set_domain(const std::string &domain) {
  db::Stmt upsert(db::control(),
                  "INSERT OR REPLACE INTO settings VALUES('domain', ?)");
  return upsert && upsert.text(1, domain).done();
}

Claim claim_parse(int64_t max_attempts, int64_t now_ns, int64_t defer_ns,
                  int64_t &mailbox, int64_t &id) {
  int64_t parse_id = 0;
  int64_t attempts = 0;
  std::string error;
  {
    // A purge sets unparsed to 0. A file of another version waits for its
    // upgrade or its release.
    db::Stmt select(
        db::control(),
        "SELECT id, parse_id, parse_attempts, parse_error "
        "FROM mailboxes WHERE unparsed > 0 AND retry_after_ns <= ?1 "
        "AND schema = ?3 "
        "ORDER BY id <= ?2, id LIMIT 1");
    if (!select) return Claim::Failed;
    if (!select.integer(1, now_ns)
             .integer(2, g_parsed_last)
             .integer(3, db::mailbox_version())
             .row()) {
      return select.failed() ? Claim::Failed : Claim::Empty;
    }
    mailbox = select.column_integer(0);
    g_parsed_last = mailbox;
    parse_id = select.column_integer(1);
    attempts = select.column_integer(2);
    error = select.column_text(3);
  }
  sqlite3 *file = nullptr;
  const Claim open = open_for_pump(mailbox, now_ns + defer_ns, file);
  if (open != Claim::Claimed) return open;
  const Claim claim = claim_in_file(Mailbox{mailbox, file}, max_attempts,
                                    parse_id, attempts, error, id);
  // A file that opens but then fails is as broken as one that does not open
  return claim == Claim::Failed ? defer_pump(mailbox, now_ns + defer_ns)
                                : claim;
}

// The attempt claimed for message `id`, if it is still the one claimed
static bool give_back_parse_attempt(int64_t mailbox, int64_t id) {
  db::Stmt back(db::control(),
                "UPDATE mailboxes SET parse_attempts = "
                "max(0, parse_attempts - 1) WHERE id = ? AND parse_id = ?");
  return back && back.integer(1, mailbox).integer(2, id).done();
}

void record_parse_failure(int64_t mailbox, int64_t id, const std::string &error,
                          bool attempted) {
  // A call that never ran keeps the last real error
  if (!attempted) {
    give_back_parse_attempt(mailbox, id);
    return;
  }
  // Only for the message still claimed: a purge, or a newer pump, may have
  // moved on
  db::Stmt update(db::control(), "UPDATE mailboxes SET parse_error = ? "
                                 "WHERE id = ? AND parse_id = ?");
  update.text(1, error).integer(2, mailbox).integer(3, id).done();
}

bool process(int64_t mailbox, int64_t id) {
  if (exporting(mailbox)) {
    // A download began after the claim: the parse waits for it, without
    // counting this attempt
    return give_back_parse_attempt(mailbox, id);
  }
  const Mailbox box{mailbox, mailbox_file(mailbox)};
  if (box.file == nullptr) return false;
  {
    db::Stmt state(box.file, "SELECT state FROM messages WHERE id = ?");
    if (!state) return false;
    if (!state.integer(1, id).row())
      return !state.failed(); // deleted since it was claimed
    if (state.column_integer(0) != Queued) return true;
  }
  int64_t attempts = 1;
  {
    db::Stmt claim(db::control(), "SELECT parse_attempts FROM mailboxes "
                                  "WHERE id = ? AND parse_id = ?");
    if (!claim) return false;
    if (claim.integer(1, mailbox).integer(2, id).row()) {
      attempts = claim.column_integer(0);
    } else if (claim.failed()) {
      return false;
    }
  }
  MimeSummary summary;
  bool parsed = false;
  { // the read ends here, with the pointers into its row
    db::Stmt body(box.file, "SELECT raw FROM bodies WHERE id = ?");
    if (!body || !body.integer(1, id).row()) return false;
    const char *raw = static_cast<const char *>(body.column_blob(0));
    const size_t raw_size = body.column_bytes(0);

#ifdef EMAIL_CANISTER_TEST_HOOKS
    const std::string marker = "X-Email-Canister-Test-Trap:";
    if (raw != nullptr && std::search(raw, raw + raw_size, marker.begin(),
                                      marker.end()) != raw + raw_size) {
      IC_API::trap("test hook: this message traps during processing");
    }
#endif

    parsed = mime_extract(raw == nullptr ? "" : raw, raw_size, &summary) == 0;
  }
  if (!parsed) {
    return quarantine(box, id, attempts, "the message cannot be parsed");
  }
  const std::string subject = or_empty(summary.subject);
  const std::string sender = or_empty(summary.sender);
  const std::string text = or_empty(summary.text);
  const std::string preview = make_preview(text.c_str());
  const int64_t sent_at = summary.sent_at_seconds;
  const int64_t attachments = summary.attachments;
  mime_summary_free(&summary);

  MailboxWrite write(box);
  if (!write) return false;
  db::Stmt update(box.file,
                  "UPDATE messages SET state = ?, subject = ?, sender = ?, "
                  "sent_at = ?, attachments = ?, preview = ?, attempts = ?, "
                  "last_error = '' WHERE id = ?");
  db::Stmt index(
      box.file,
      "INSERT INTO fts(rowid, subject, sender, body) VALUES(?,?,?,?)");
  db::Stmt count(db::control(),
                 "UPDATE mailboxes SET unparsed = unparsed - 1, "
                 "since_merge = since_merge + 1, parse_attempts = 0, "
                 "parse_error = '' WHERE id = ?");
  const bool ok = update && index && count &&
                  update.integer(1, Indexed)
                      .text(2, subject)
                      .text(3, sender)
                      .integer(4, sent_at)
                      .integer(5, attachments)
                      .text(6, preview)
                      .integer(7, attempts)
                      .integer(8, id)
                      .done() &&
                  index.integer(1, id)
                      .text(2, subject)
                      .text(3, sender)
                      .text(4, text)
                      .done() &&
                  count.integer(1, mailbox).done();
  return ok && write.commit();
}

bool merge_due(int64_t mailbox, int64_t every) {
  db::Stmt select(db::control(),
                  "SELECT since_merge >= ? FROM mailboxes WHERE id = ?");
  return select && select.integer(1, every).integer(2, mailbox).row() &&
         select.column_integer(0) != 0;
}

bool merge_index(int64_t mailbox, int64_t pages) {
  // A download holds the file: the merge would be rolled back at its commit,
  // so it waits, still due, until the download ends
  if (exporting(mailbox)) return true;
  MailboxWrite write(mailbox);
  if (!write) return false;
  db::Stmt merge(write.file(), "INSERT INTO fts(fts, rank) VALUES('merge', ?)");
  db::Stmt reset(db::control(),
                 "UPDATE mailboxes SET since_merge = 0 WHERE id = ?");
  return merge && reset && merge.integer(1, pages).done() &&
         reset.integer(1, mailbox).done() && write.commit();
}

IngestStats ingest_stats() {
  IngestStats stats;
  stats.queued = std::max<int64_t>(0, backlog(INT64_MAX));
  db::Stmt select(
      db::control(),
      "SELECT coalesce(sum(max(0, message_count - unparsed - quarantined)), 0), "
      "coalesce(sum(quarantined), 0), "
      "(SELECT count(*) FROM queue WHERE quarantined = 1) FROM mailboxes");
  if (select && select.row()) {
    stats.indexed = select.column_integer(0);
    stats.quarantined = select.column_integer(1);
    stats.quarantined_moves = select.column_integer(2);
  }
  return stats;
}

Page list_messages(const Mailbox &box, std::optional<int64_t> cursor,
                   int64_t limit) {
  Page page;
  db::Stmt select(box.file, "SELECT " SUMMARY_COLUMNS " FROM messages "
                            "WHERE uid < ? ORDER BY uid DESC LIMIT ?");
  if (!select) return page;
  select.integer(1, cursor.value_or(std::numeric_limits<int64_t>::max()))
      .integer(2, limit + 1);
  while (select.row()) {
    if (static_cast<int64_t>(page.items.size()) == limit) {
      page.cursor = page.items.back().uid;
      break;
    }
    page.items.push_back(read_summary(select));
  }
  return page;
}

bool get_message(const Mailbox &box, int64_t uid, Summary &summary,
                 std::vector<uint8_t> &raw) {
  db::Stmt select(box.file,
                  "SELECT " SUMMARY_COLUMNS ", id FROM messages WHERE uid = ?");
  if (!select || !select.integer(1, uid).row()) return false;
  summary = read_summary(select);
  db::Stmt body(box.file, "SELECT raw FROM bodies WHERE id = ?");
  if (!body || !body.integer(1, select.column_integer(12)).row()) return false;
  const auto *bytes = static_cast<const uint8_t *>(body.column_blob(0));
  raw.assign(bytes, bytes + body.column_bytes(0));
  return true;
}

bool set_flags(const Mailbox &box, int64_t uid, int64_t set, int64_t clear,
               const std::string &principal, int64_t now_ns) {
  MailboxWrite write(box);
  if (!write) return false;
  db::Stmt find(box.file, "SELECT flags FROM messages WHERE uid = ?");
  if (!find || !find.integer(1, uid).row()) return false;
  const int64_t before = find.column_integer(0);
  const int64_t after = (before | set) & ~clear;
  bool ok = find.done();
  if (after != before) {
    // The unseen count follows the seen flag
    const int64_t unseen = ((after & Seen) ? 0 : 1) - ((before & Seen) ? 0 : 1);
    db::Stmt bump(db::control(),
                  "UPDATE mailboxes SET modseq = modseq + 1, "
                  "unseen = unseen + ? WHERE id = ? RETURNING modseq");
    ok = ok && bump && bump.integer(1, unseen).integer(2, box.id).row();
    const int64_t modseq = ok ? bump.column_integer(0) : 0;
    ok = ok && bump.done();
    db::Stmt update(box.file,
                    "UPDATE messages SET flags = ?, modseq = ? WHERE uid = ?");
    ok = ok && update &&
         update.integer(1, after).integer(2, modseq).integer(3, uid).done();
  }
  if (set & Seen) { // the first time only
    db::Stmt seen(box.file, "INSERT OR IGNORE INTO seen_by(uid, principal, "
                            "at_ns) VALUES(?, ?, ?)");
    ok = ok && seen &&
         seen.integer(1, uid).text(2, principal).integer(3, now_ns).done();
  }
  return ok && write.commit();
}

std::vector<SeenBy> seen_by(const Mailbox &box, int64_t uid) {
  std::vector<SeenBy> found;
  db::Stmt select(box.file, "SELECT principal, at_ns FROM seen_by "
                            "WHERE uid = ? ORDER BY at_ns, principal");
  if (!select) return found;
  select.integer(1, uid);
  while (select.row())
    found.push_back({select.column_text(0), select.column_integer(1)});
  return found;
}

int64_t delete_messages(const Mailbox &box, const std::vector<uint64_t> &uids) {
  MailboxWrite write(box);
  if (!write) return -1;
  int64_t deleted = 0;
  int64_t bytes = 0;
  int64_t unparsed = 0;
  int64_t quarantined = 0;
  int64_t unseen = 0;
  bool ok = true;
  {
    db::Stmt find(box.file, "SELECT id, state, raw_bytes, flags FROM messages "
                            "WHERE uid = ?");
    db::Stmt message(box.file, "DELETE FROM messages WHERE id = ?");
    db::Stmt body(box.file, "DELETE FROM bodies WHERE id = ?");
    db::Stmt index(box.file, "DELETE FROM fts WHERE rowid = ?");
    db::Stmt seen(box.file, "DELETE FROM seen_by WHERE uid = ?");
    ok = find && message && body && index && seen;
    for (size_t i = 0; ok && i < uids.size(); ++i) {
      find.reset();
      find.integer(1, static_cast<int64_t>(uids[i]));
      if (!find.row()) {
        ok = !find.failed(); // a failed read must not pass for a missing uid
        continue;
      }
      const int64_t id = find.column_integer(0);
      const int64_t state = find.column_integer(1);
      bytes += find.column_integer(2);
      unparsed += state == Queued ? 1 : 0;
      quarantined += state == Quarantined ? 1 : 0;
      unseen += (find.column_integer(3) & Seen) ? 0 : 1;
      find.reset();
      message.reset();
      body.reset();
      index.reset();
      seen.reset();
      ok = message.integer(1, id).done() && body.integer(1, id).done() &&
           seen.integer(1, static_cast<int64_t>(uids[i])).done() &&
           (state != Indexed ||
            index.integer(1, id).done()); // only these are indexed
      ++deleted;
    }
  }
  db::Stmt subtract(db::control(),
                    "UPDATE mailboxes SET used_bytes = used_bytes - ?, "
                    "message_count = message_count - ?, "
                    "unparsed = unparsed - ?, quarantined = quarantined - ?, "
                    "unseen = unseen - ?, modseq = modseq + 1 WHERE id = ?");
  ok = ok && subtract &&
       subtract.integer(1, bytes)
           .integer(2, deleted)
           .integer(3, unparsed)
           .integer(4, quarantined)
           .integer(5, unseen)
           .integer(6, box.id)
           .done();
  if (!ok || !write.commit()) return -1;
  return deleted;
}

Page search(const Mailbox &box, const std::string &query,
            std::optional<int64_t> cursor, int64_t limit) {
  Page page;
  const std::string match = fts_query(query);
  if (match.empty()) return page;

  // One hit at a time, so that a large mailbox cannot overrun the budget unseen
  db::Stmt hits(box.file,
                "SELECT rowid FROM fts WHERE fts MATCH ? AND rowid < ? "
                "ORDER BY rowid DESC");
  db::Stmt lookup(box.file,
                  "SELECT " SUMMARY_COLUMNS " FROM messages WHERE id = ?");
  if (!hits || !lookup) return page;
  hits.text(1, match).integer(
      2, cursor.value_or(std::numeric_limits<int64_t>::max()));
  bool examined = false; // every call advances, however little budget it has
  while (hits.row()) {
    const int64_t id = hits.column_integer(0);
    if (examined && IC_API::performance_counter() > g_search_budget) {
      page.cursor = id + 1;
      break;
    }
    examined = true;
    lookup.reset();
    if (lookup.integer(1, id).row()) {
      page.items.push_back(read_summary(lookup));
      if (static_cast<int64_t>(page.items.size()) == limit) {
        page.cursor = id;
        break;
      }
    }
  }
  return page;
}

int64_t purge_step(int64_t mailbox) {
  bool purging = false;
  {
    db::Stmt state(db::control(), "SELECT purging FROM mailboxes WHERE id = ?");
    if (!state || !state.integer(1, mailbox).row()) return -1;
    purging = state.column_integer(0) != 0;
  }
  if (!purging) {
    db::Transaction control(db::control());
    db::Stmt reset(db::control(),
                   "UPDATE mailboxes SET purging = 1, used_bytes = 0, "
                   "message_count = 0, unseen = 0, unparsed = 0, "
                   "quarantined = 0, "
                   "since_merge = 0, parse_id = 0, parse_attempts = 0, "
                   "parse_error = '', retry_after_ns = 0, outbox_due_ns = 0, "
                   "export_until_ns = 0, export_principal = '', "
                   "needs_repair = '' WHERE id = ?");
    // Its members go with it: a new mailbox at the address starts without
    db::Stmt members(db::control(), "DELETE FROM members WHERE mailbox_id = ?");
    if (!control || !clear_queue(mailbox) || !reset ||
        !reset.integer(1, mailbox).done() || !members ||
        !members.integer(1, mailbox).done() || !control.commit()) {
      return -1;
    }
  }
  const int64_t remaining = db::shrink_mailbox(mailbox, g_purge_step_bytes);
  if (remaining < 0) return -1;
  // The file holds its stable memory until the last step
  db::Stmt record(db::control(),
                  "UPDATE mailboxes SET file_bytes = ? WHERE id = ?");
  if (!record || !record.integer(1, remaining).integer(2, mailbox).done())
    return -1;
  if (remaining != 0) return remaining;
  db::Stmt vacate(db::control(),
                  "UPDATE mailboxes SET vacant = 1, disabled = 0, "
                  "purging = 0 WHERE id = ?");
  return vacate && vacate.integer(1, mailbox).done() ? 0 : -1;
}

#ifdef EMAIL_CANISTER_TEST_HOOKS
void set_budgets(uint64_t search, uint64_t purge_step_bytes) {
  g_search_budget = search;
  g_purge_step_bytes = static_cast<int64_t>(purge_step_bytes);
}
#endif

} // namespace store
