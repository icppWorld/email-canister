#include "calendar_store.h"

#include <string_view>

#include "db.h"

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
  while (true) {
    const size_t end = block.find("\r\n", start);
    if (end == std::string_view::npos) {
      lines.push_back(block.substr(start));
      return lines;
    }
    lines.push_back(block.substr(start, end - start));
    start = end + 2;
  }
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

// The block's content lines, unfolded (RFC 5545 3.1): a line that starts
// with a space or a tab continues the one before
std::vector<std::string> unfolded(const std::vector<std::string_view> &raw) {
  std::vector<std::string> lines;
  for (std::string_view line : raw) {
    if (!lines.empty() && !line.empty() && (line[0] == ' ' || line[0] == '\t'))
      lines.back().append(line.substr(1));
    else lines.emplace_back(line);
  }
  return lines;
}

std::string upper(std::string s) {
  for (char &c : s) {
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
  }
  return s;
}

// The component a BEGIN or END line names, in upper case, or empty for any
// other line. A line is read as a parser reads it: in any case, and with any
// parameters.
std::string component_of(const std::string &line, std::string_view keyword) {
  const size_t colon = line.find(':');
  if (colon == std::string::npos ||
      upper(line.substr(0, line.find_first_of(":;"))) != keyword)
    return "";
  return upper(line.substr(colon + 1));
}

// The components a calendar holds, which no block may hold inside it
const std::string_view k_outer[] = {"VCALENDAR", "VEVENT", "VTIMEZONE"};

// Why `block` is not one `component` that has the property line `id_line`,
// or empty. It may hold subcomponents, such as a VALARM.
std::string invalid_block(std::string_view block, std::string_view component,
                          const std::string &id_line) {
  if (block.size() > k_max_event_bytes) return "the block is too large";
  if (!clean_lines(block))
    return "lines must end in CRLF, with no other control characters";
  // The first and last lines exactly as the webmail writes them, unfolded
  const std::vector<std::string_view> raw = lines_of(block);
  const std::vector<std::string> lines = unfolded(raw);
  if (lines.size() < 3 || lines.front() != "BEGIN:" + std::string(component) ||
      lines.back() != "END:" + std::string(component) ||
      raw.back() != lines.back())
    return "the block must be one " + std::string(component);
  bool has_id = false;
  for (size_t i = 1; i + 1 < lines.size(); ++i) {
    for (std::string_view keyword : {"BEGIN", "END"}) {
      const std::string named = component_of(lines[i], keyword);
      for (std::string_view outer : k_outer) {
        if (named == outer)
          return "the block holds another " + std::string(outer);
      }
    }
    if (lines[i] == id_line) has_id = true;
  }
  if (!has_id) return "the block has no " + id_line;
  return "";
}

std::string invalid_event(const Event &event) {
  if (!plain_name(event.uid, k_max_uid, "@._-"))
    return "the uid must be letters, digits and @._- only";
  if (event.starts < 0 || event.ends < event.starts)
    return "the event must end after it starts";
  return invalid_block(event.vevent, "VEVENT", "UID:" + event.uid);
}

std::string invalid_zones(const std::vector<TimeZone> &zones) {
  if (zones.size() > k_max_zones_per_event)
    return "too many time zones in one event";
  for (const TimeZone &zone : zones) {
    if (!plain_name(zone.tzid, 64, "/_+-"))
      return "the time zone must be an IANA name";
    std::string why =
        invalid_block(zone.block, "VTIMEZONE", "TZID:" + zone.tzid);
    if (!why.empty()) return why;
  }
  return "";
}

// Drops the zones no event names any more
bool drop_unused_zones(sqlite3 *file) {
  db::Stmt drop(file, "DELETE FROM zones WHERE NOT EXISTS (SELECT 1 FROM "
                      "event_zones e WHERE e.tzid = zones.tzid)");
  return drop && drop.done();
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
  std::string why = invalid_event(event);
  if (why.empty()) why = invalid_zones(zones);
  if (!why.empty()) return why;

  MailboxWrite write(box);
  if (!write) return std::nullopt;
  db::Stmt known(box.file, "SELECT id FROM events WHERE uid = ?");
  if (!known) return std::nullopt;
  if (!known.text(1, event.uid).row()) {
    if (known.failed()) return std::nullopt;
    db::Stmt count(box.file, "SELECT count(*) FROM events");
    if (!count || !count.row()) return std::nullopt;
    if (count.column_integer(0) >= k_max_events)
      return "the calendar is full: it holds " + std::to_string(k_max_events) +
             " events";
  }
  db::Stmt upsert(box.file,
                  "INSERT INTO events(uid, vevent, starts, ends, modified_ns) "
                  "VALUES(?1, ?2, ?3, ?4, ?5) ON CONFLICT(uid) DO UPDATE SET "
                  "vevent = ?2, starts = ?3, ends = ?4, modified_ns = ?5 "
                  "RETURNING id");
  if (!upsert || !upsert.text(1, event.uid)
                      .text(2, event.vevent)
                      .integer(3, event.starts)
                      .integer(4, event.ends)
                      .integer(5, event.modified_ns)
                      .row())
    return std::nullopt;
  const int64_t id = upsert.column_integer(0);
  if (!upsert.done()) return std::nullopt;

  // The event names these zones now, and only these
  db::Stmt forget(box.file, "DELETE FROM event_zones WHERE event_id = ?");
  db::Stmt zone(box.file, "INSERT INTO zones(tzid, block) VALUES(?1, ?2) "
                          "ON CONFLICT(tzid) DO UPDATE SET block = ?2");
  db::Stmt name(box.file, "INSERT OR IGNORE INTO event_zones(event_id, tzid) "
                          "VALUES(?, ?)");
  if (!forget || !zone || !name || !forget.integer(1, id).done())
    return std::nullopt;
  for (const TimeZone &z : zones) {
    zone.reset();
    name.reset();
    if (!zone.text(1, z.tzid).text(2, z.block).done() ||
        !name.integer(1, id).text(2, z.tzid).done())
      return std::nullopt;
  }
  if (!drop_unused_zones(box.file)) return std::nullopt;
  if (!zones.empty()) {
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
  db::Stmt names(box.file, "DELETE FROM event_zones WHERE event_id IN "
                           "(SELECT id FROM events WHERE uid = ?)");
  db::Stmt remove(box.file, "DELETE FROM events WHERE uid = ?");
  if (!write || !names || !remove || !names.text(1, uid).done() ||
      !remove.text(1, uid).done())
    return std::nullopt;
  if (db::changes(box.file) == 0) return false; // rolled back: nothing changed
  if (!drop_unused_zones(box.file) || !write.commit()) return std::nullopt;
  return true;
}

std::optional<std::string> feed_token(int64_t mailbox) {
  db::Stmt select(db::control(),
                  "SELECT token FROM feeds WHERE mailbox_id = ?");
  if (!select) return std::nullopt;
  if (select.integer(1, mailbox).row()) return select.column_text(0);
  if (select.failed()) return std::nullopt;
  return "";
}

bool set_feed_token(int64_t mailbox, const std::string &token) {
  db::Transaction write(db::control());
  db::Stmt add(db::control(),
               "INSERT INTO feeds(mailbox_id, token) VALUES(?, ?)");
  return write && add && stop_feed(mailbox) &&
         (token.empty() || add.integer(1, mailbox).text(2, token).done()) &&
         write.commit();
}

Lookup feed_mailbox(const std::string &token, int64_t &id, std::string &local) {
  db::Stmt select(db::control(),
                  "SELECT m.id, m.local FROM feeds f JOIN mailboxes m "
                  "ON m.id = f.mailbox_id WHERE f.token = ? AND "
                  "m.vacant = 0 AND m.disabled = 0 AND m.purging = 0");
  if (!select) return Lookup::Failed;
  if (!select.text(1, token).row())
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
  const std::string_view end = "END:VCALENDAR\r\n";
  // Only the ids are sorted; each block is read once, until the file is full
  db::Stmt events(file, "SELECT id FROM events WHERE ends >= ? "
                        "ORDER BY starts DESC, id DESC");
  db::Stmt block(file, "SELECT vevent FROM events WHERE id = ?");
  if (!events || !block) return std::nullopt;
  events.integer(1, now_seconds - k_feed_past_seconds);
  while (events.row()) {
    block.reset();
    if (!block.integer(1, events.column_integer(0)).row()) return std::nullopt;
    const auto *text = static_cast<const char *>(block.column_blob(0));
    const size_t size = block.column_bytes(0);
    if (out.size() + size + 2 + end.size() > k_max_feed_bytes) break;
    out.append(text, size);
    out.append("\r\n");
  }
  if (events.failed()) return std::nullopt;
  out.append(end);
  return out;
}

} // namespace store
