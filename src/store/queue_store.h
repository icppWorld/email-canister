// The delivery queue in control.db. smtp_request stores a message here, once
// for all its recipients, without opening any mailbox file; the ingest pump
// then moves it into each recipient's file. Nothing here traps: failures are
// returned, so that the SMTP handlers can answer with a temporary error.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "claim.h"

namespace store {

struct IncomingMessage {
  std::string envelope_from;
  std::string rfc_message_id;
  std::string dedupe_key;
  const std::vector<uint8_t> *raw;
  int64_t received_ns;
};

// The mailbox's rows in the queue, quarantined ones included, or -1 on
// failure
int64_t queued(int64_t mailbox);

// Run inside a transaction on control.db. `body_id` is 0 until the first
// recipient stores the body, which the others then share. A redelivery, seen
// in the queue or within the dedupe window, changes nothing.
enum class Insert { Stored, Duplicate, Full, OverQuota, Failed };
Insert queue_message(int64_t mailbox, const IncomingMessage &message,
                     int64_t &body_id, int64_t mailbox_cap,
                     int64_t dedupe_since_ns);

// The messages waiting to be moved or parsed in the mailboxes that can be
// worked on at `at_ns` (INT64_MAX counts them all), or -1 on failure
int64_t backlog(int64_t at_ns);

// When the earliest deferred mailbox with work can be worked on again, false
// when there is none
bool deferred_until(int64_t now_ns, int64_t &at_ns);

// Picks the oldest queue row and records the attempt, which has to be
// committed before the move: the move may trap. Again means it quarantined
// the row instead, or deferred its mailbox until now + `defer_ns` because
// its file cannot be opened.
Claim claim_move(int64_t max_attempts, int64_t now_ns, int64_t defer_ns,
                 int64_t &queue_id);

// A call that never ran gives its attempt back, so that it cannot quarantine
// the row, and keeps the last real error
void record_move_failure(int64_t queue_id, const std::string &error,
                         bool attempted);

// Moves a queue row into its mailbox's file, then drops dedupe keys older
// than `dedupe_since_ns`. False on failure, which makes the move retry.
bool move(int64_t queue_id, int64_t dedupe_since_ns);

// Queues a mailbox's quarantined rows again. Returns how many, or -1.
int64_t retry_moves(int64_t mailbox);

// Removes everything control.db holds for a mailbox's mail: its queue rows,
// the bodies no other recipient needs, and its dedupe keys
bool clear_queue(int64_t mailbox);

} // namespace store
