// A mailbox's calendar: its events, the time zones they name, and the secret
// address of its iCalendar feed. The webmail writes each event as one
// standard VEVENT block (RFC 5545); this code checks the block's shape,
// stores it, and joins the blocks into the feed. It never reads recurrence
// rules or time zones. Nothing here traps.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "allowlist.h"

namespace store {

const size_t k_max_event_bytes = 16384;         // one VEVENT or VTIMEZONE block
const int64_t k_max_events = 5000;              // per calendar
const int64_t k_max_zones = 100;                // per calendar
const size_t k_max_zones_per_event = 4;         // in one put
const size_t k_max_uid = 255;                   // characters
const size_t k_max_feed_bytes = 1'900'000;      // under the IC's 2 MB reply
const int64_t k_feed_past_seconds = 31'536'000; // a year of past events

struct Event {
  std::string uid;
  std::string vevent;
  int64_t starts{0}; // UTC seconds
  int64_t ends{0};   // UTC seconds, far ahead for a repeat that never ends
  int64_t modified_ns{0};
  int64_t row{0}; // the cursor of a page
};

struct TimeZone {
  std::string tzid;
  std::string block;
};

struct EventPage {
  std::vector<Event> items;
  std::optional<int64_t> cursor; // absent when there is nothing more
};

// The events that overlap [from, to), after `cursor`, up to `limit` of them
// and about `max_bytes` of blocks
std::optional<EventPage> list_events(const Mailbox &box, int64_t from,
                                     int64_t to, std::optional<int64_t> cursor,
                                     int64_t limit, size_t max_bytes);

// Adds or replaces the event, with the zones it names: the block must be one
// VEVENT whose UID line is the uid, and each zone one VTIMEZONE whose TZID
// line is its tzid. Returns why it was refused, or nullopt when the database
// failed; empty when it is stored. A zone no event names any more is dropped.
std::optional<std::string> put_event(const Mailbox &box, const Event &event,
                                     const std::vector<TimeZone> &zones);

// Whether there was such an event, or nullopt when the database failed
std::optional<bool> delete_event(const Mailbox &box, const std::string &uid);

// The token of the mailbox's feed, empty while it is not shared, or nullopt
// when the registry failed
std::optional<std::string> feed_token(int64_t mailbox);

// Shares the mailbox's calendar under `token`, or with an empty token stops
// sharing it. Any earlier address stops working.
bool set_feed_token(int64_t mailbox, const std::string &token);

// The enabled mailbox whose feed has this token: Found, with its id and local
// part, Missing, or Failed
Lookup feed_mailbox(const std::string &token, int64_t &id, std::string &local);

// The calendar as one iCalendar file, named `name`, with the events that end
// after `now - k_feed_past_seconds`: the latest when they would not fit
std::optional<std::string> feed(sqlite3 *file, const std::string &name,
                                int64_t now_seconds);

} // namespace store
