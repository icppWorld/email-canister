#include "calendar_store.h"

#include <string_view>

#include "db.h"
#include "sha256.h"

namespace store {

namespace {

// Lines end in CRLF, and no other control character but a tab appears
bool clean_lines(std::string_view block) {
  for (size_t i = 0; i < block.size(); ++i) {
    const auto c = static_cast<unsigned char>(block[i]);
    if (c == '\r') {
      if (i + 1 >= block.size() || block[i + 1] != '\n') return false;
      ++i;
    } else if (c == '\n' || c == 0x7f || (c < 0x20 && c != '\t')) {
      return false;
    }
  }
  return true;
}

// The block's lines, split on CRLF
std::vector<std::string_view> lines_of(std::string_view block) {
  std::vector<std::string_view> lines;
  size_t start = 0;
  while (start <= block.size()) {
    const size_t end = block.find("\r\n", start);
    if (end == std::string_view::npos) {
      lines.push_back(block.substr(start));
      break;
    }
    lines.push_back(block.substr(start, end - start));
    start = end + 2;
  }
  return lines;
}

// A name that needs no quoting or escaping in a URL or a property value
bool plain_name(std::string_view s, size_t max, std::string_view extra) {
  if (s.empty() || s.size() > max) return false;
  for (char c : s) {
    const bool alnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                       (c >= '0' && c <= '9');
    if (!alnum && extra.find(c) == std::string_view::npos) return false;
  }
  return true;
}

// Why `block` is not one `component` that has the property line `id_line`,
// or empty. It may hold subcomponents, such as a VALARM, but not the
// components a calendar holds.
std::string invalid_block(std::string_view block, std::string_view component,
                          const std::string &id_line) {
  if (block.size() > k_max_event_bytes) return "the block is too large";
  if (!clean_lines(block))
    return "lines must end in CRLF, with no other control characters";
  const std::string begin = "BEGIN:" + std::string(component);
  const std::string end = "END:" + std::string(component);
  const std::vector<std::string_view> lines = lines_of(block);
  if (lines.size() < 3 || lines.front() != begin || lines.back() != end)
    return "the block must be one " + std::string(component);
  bool has_id = false;
  for (size_t i = 1; i + 1 < lines.size(); ++i) {
    const std::string_view line = lines[i];
    for (std::string_view name : {"VCALENDAR", "VEVENT", "VTIMEZONE"}) {
      if (line == "BEGIN:" + std::string(name) ||
          line == "END:" + std::string(name))
        return "the block holds another " + std::string(name);
    }
    if (line == id_line) has_id = true;
  }
  if (!has_id) return "the block has no " + id_line;
  return "";
}

// Folds a line we write ourselves at 75 octets, as RFC 5545 asks, without
// splitting a UTF-8 character
void append_line(std::string &out, std::string_view line) {
  size_t taken = 0;
  size_t room = 75;
  while (line.size() - taken > room) {
    size_t cut = taken + room;
    while (cut > taken &&
           (static_cast<unsigned char>(line[cut]) & 0xC0) == 0x80)
      --cut;
    out.append(line.substr(taken, cut - taken));
    out.append("\r\n ");
    taken = cut;
    room = 74; // the leading space counts
  }
  out.append(line.substr(taken));
  out.append("\r\n");
}

// A TEXT value, escaped (RFC 5545 3.3.11)
std::string text_value(std::string_view s) {
  std::string out;
  for (char c : s) {
    if (c == '\\' || c == ';' || c == ',') out.push_back('\\');
    out.push_back(c);
  }
  return out;
}

} // namespace

std::string invalid_event(const Event &event) {
  if (!plain_name(event.uid, k_max_uid, "@._-"))
    return "the uid must be letters, digits and @._- only";
  if (event.starts < 0 || event.ends < event.starts)
    return "the event must end after it starts";
  return invalid_block(event.vevent, "VEVENT", "UID:" + event.uid);
}

std::string invalid_zone(const TimeZone &zone) {
  if (!plain_name(zone.tzid, 64, "/_+-"))
    return "the time zone must be an IANA name";
  return invalid_block(zone.block, "VTIMEZONE", "TZID:" + zone.tzid);
}

std::optional<EventPage> list_events(const Mailbox &box, int64_t from,
                                     int64_t to, std::optional<int64_t> cursor,
                                     int64_t limit, size_t max_bytes) {
  db::Stmt select(box.file,
                  "SELECT id, uid, vevent, starts, ends, modified_ns "
                  "FROM events WHERE ends >= ? AND starts < ? AND id > ? "
                  "ORDER BY id LIMIT ?");
  if (!select) return std::nullopt;
  select.integer(1, from).integer(2, to).integer(3, cursor.value_or(0));
  select.integer(4, limit + 1);
  EventPage page;
  size_t bytes = 0;
  while (select.row()) {
    Event e;
    e.row = select.column_integer(0);
    e.uid = select.column_text(1);
    e.vevent = select.column_text(2);
    e.starts = select.column_integer(3);
    e.ends = select.column_integer(4);
    e.modified_ns = select.column_integer(5);
    // One more than fits says there is more: the page ends before it
    if (static_cast<int64_t>(page.items.size()) == limit ||
        (!page.items.empty() && bytes + e.vevent.size() > max_bytes)) {
      page.cursor = page.items.back().row;
      break;
    }
    bytes += e.vevent.size();
    page.items.push_back(std::move(e));
  }
  if (select.failed()) return std::nullopt;
  return page;
}

std::optional<std::string> put_event(const Mailbox &box, const Event &event,
                                     const std::vector<TimeZone> &zones) {
  MailboxWrite write(box);
  if (!write) return std::nullopt;
  {
    db::Stmt count(box.file, "SELECT count(*), EXISTS(SELECT 1 FROM events "
                             "WHERE uid = ?) FROM events");
    if (!count || !count.text(1, event.uid).row()) return std::nullopt;
    if (count.column_integer(1) == 0 && count.column_integer(0) >= k_max_events)
      return "the calendar is full: it holds " + std::to_string(k_max_events) +
             " events";
  }
  db::Stmt upsert(box.file,
                  "INSERT INTO events(uid, vevent, starts, ends, modified_ns) "
                  "VALUES(?1, ?2, ?3, ?4, ?5) ON CONFLICT(uid) DO UPDATE SET "
                  "vevent = ?2, starts = ?3, ends = ?4, modified_ns = ?5");
  if (!upsert || !upsert.text(1, event.uid)
                      .text(2, event.vevent)
                      .integer(3, event.starts)
                      .integer(4, event.ends)
                      .integer(5, event.modified_ns)
                      .done())
    return std::nullopt;
  db::Stmt zone(box.file, "INSERT INTO zones(tzid, block) VALUES(?1, ?2) "
                          "ON CONFLICT(tzid) DO UPDATE SET block = ?2");
  if (!zone) return std::nullopt;
  for (const TimeZone &z : zones) {
    zone.reset();
    if (!zone.text(1, z.tzid).text(2, z.block).done()) return std::nullopt;
  }
  {
    db::Stmt count(box.file, "SELECT count(*) FROM zones");
    if (!count || !count.row()) return std::nullopt;
    if (count.column_integer(0) > k_max_zones)
      return "the calendar names too many time zones";
  }
  if (!write.commit()) return std::nullopt;
  return "";
}

std::optional<bool> delete_event(const Mailbox &box, const std::string &uid) {
  MailboxWrite write(box);
  db::Stmt remove(box.file, "DELETE FROM events WHERE uid = ?");
  if (!write || !remove || !remove.text(1, uid).done()) return std::nullopt;
  if (db::changes(box.file) == 0) return false; // rolled back: nothing changed
  if (!write.commit()) return std::nullopt;
  return true;
}

std::optional<std::string> feed_token(const Mailbox &box) {
  db::Stmt select(box.file, "SELECT feed_token FROM calendar WHERE id = 1");
  if (!select || !select.row()) return std::nullopt;
  return select.column_text(0);
}

bool set_feed_token(const Mailbox &box, const std::string &token) {
  MailboxWrite write(box);
  db::Stmt clear(db::control(), "DELETE FROM feeds WHERE mailbox_id = ?");
  db::Stmt add(db::control(),
               "INSERT INTO feeds(token_hash, mailbox_id) VALUES(?, ?)");
  db::Stmt record(box.file, "UPDATE calendar SET feed_token = ? WHERE id = 1");
  const std::string hash = token.empty() ? "" : token_hash(token);
  return write && clear && add && record && clear.integer(1, box.id).done() &&
         (token.empty() || add.text(1, hash).integer(2, box.id).done()) &&
         record.text(1, token).done() && db::changes(box.file) == 1 &&
         write.commit();
}

Lookup feed_mailbox(const std::string &token, int64_t &id, std::string &local) {
  db::Stmt select(db::control(),
                  "SELECT m.id, m.local FROM feeds f JOIN mailboxes m "
                  "ON m.id = f.mailbox_id WHERE f.token_hash = ? AND "
                  "m.vacant = 0 AND m.disabled = 0 AND m.purging = 0");
  if (!select) return Lookup::Failed;
  const std::string hash = token_hash(token);
  if (!select.text(1, hash).row())
    return select.failed() ? Lookup::Failed : Lookup::Missing;
  id = select.column_integer(0);
  local = select.column_text(1);
  return Lookup::Found;
}

std::optional<std::string> feed(sqlite3 *file, const std::string &name,
                                int64_t now_seconds) {
  std::string out;
  append_line(out, "BEGIN:VCALENDAR");
  append_line(out, "VERSION:2.0");
  append_line(out, "PRODID:-//email-canister//calendar//EN");
  append_line(out, "CALSCALE:GREGORIAN");
  append_line(out, "X-WR-CALNAME:" + text_value(name));
  append_line(out, "NAME:" + text_value(name));
  // Asks the apps that honour it to look again every hour
  append_line(out, "REFRESH-INTERVAL;VALUE=DURATION:PT1H");
  append_line(out, "X-PUBLISHED-TTL:PT1H");
  {
    db::Stmt zones(file, "SELECT block FROM zones ORDER BY tzid");
    if (!zones) return std::nullopt;
    while (zones.row()) {
      out.append(zones.column_text(0));
      out.append("\r\n");
    }
    if (zones.failed()) return std::nullopt;
  }
  const std::string end = "END:VCALENDAR\r\n";
  db::Stmt events(file, "SELECT vevent FROM events WHERE ends >= ? "
                        "ORDER BY starts DESC, id DESC");
  if (!events) return std::nullopt;
  events.integer(1, now_seconds - k_feed_past_seconds);
  while (events.row()) {
    const std::string block = events.column_text(0);
    if (out.size() + block.size() + 2 + end.size() > k_max_feed_bytes) break;
    out.append(block);
    out.append("\r\n");
  }
  if (events.failed()) return std::nullopt;
  out.append(end);
  return out;
}

std::string token_hash(const std::string &token) {
  return sha256_hex(reinterpret_cast<const uint8_t *>(token.data()),
                    token.size());
}

} // namespace store
