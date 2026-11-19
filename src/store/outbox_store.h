// Durable outgoing mail. A message moves through these states:
//
//   Queued -> Sending -> Sent | Rejected | Unknown
//
// Sending means a call may have reached the bridge. Retries reuse the same
// key, and the bridge reports the first outcome, so a retry never sends twice.
// Only the owner can start a new attempt, which gets a new key.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "allowlist.h"
#include "claim.h"

namespace store {

enum OutboxState : int64_t {
  OutQueued = 0,
  OutSending = 1,
  OutSent = 2,
  OutRejected = 3,
  OutUnknown = 4
};

struct OutboxAttachment {
  std::string filename;
  std::vector<uint8_t> content;
};

struct NewOutbox {
  std::string sent_by; // the member's principal
  std::string client_id;
  std::vector<std::string> to;
  std::vector<std::string> cc;
  std::vector<std::string> bcc;
  std::string subject;
  std::string html_body;
  std::vector<OutboxAttachment> attachments;
};

struct OutboxSummary {
  int64_t id{0};
  int64_t state{0};
  int64_t attempts{0};
  int64_t created_ns{0};
  std::vector<std::string> to;
  std::vector<std::string> cc;
  std::vector<std::string> bcc;
  std::string subject;
  int64_t attachments{0};
  int64_t bytes{0};
  std::string last_error;
  std::string sent_by;
};

struct OutboxPage {
  std::vector<OutboxSummary> items;
  std::optional<int64_t> cursor;
};

// What the bridge needs for one attempt
struct OutboxRequest {
  int64_t mailbox{0};
  int64_t id{0};
  int64_t generation{0};
  std::string key;
  std::string from_username;
  std::vector<std::string> to;
  std::vector<std::string> cc;
  std::vector<std::string> bcc;
  std::string subject;
  std::string html_body;
  std::vector<std::pair<std::string, std::string>> attachments; // base64
};

std::string bridge();
bool set_bridge(const std::string &principal);

// The size of the request the bridge will receive and post: text as escaped
// in JSON, attachments in base64
size_t outbox_encoded_size(const NewOutbox &message);

// The message `principal` sent as `client_id` since `since_ns`: its mailbox,
// that mailbox's local part, and its id there
Lookup sent_from(const std::string &principal, const std::string &client_id,
                 int64_t since_ns, int64_t &mailbox, std::string &local,
                 int64_t &id);
// Records that send, and forgets some of those before `since_ns`
bool record_send(const std::string &principal, const std::string &client_id,
                 int64_t mailbox, int64_t id, int64_t now_ns, int64_t since_ns);

enum class Enqueue { Stored, Duplicate, OverQuota, Failed };
// Ids come from the registry and are never given out twice, not even after a
// purge, so neither is a bridge key
Enqueue outbox_enqueue(const Mailbox &box, const NewOutbox &message,
                       int64_t now_ns, int64_t &id);

// Picks the message due next, in the enabled mailbox due first, and leases it
// until now + lease. Again means the pump can go on at once: the mailbox had
// nothing due after all, or its message has been Sending for `abandon_ns`
// and becomes Unknown without a call, since the bridge may have forgotten its
// key by the time a retry would reach it, or that the mailbox's file cannot
// be opened, which holds the mailbox until now + lease. On Failed,
// `request.mailbox` names the mailbox when one was picked.
Claim outbox_claim(int64_t now_ns, int64_t lease_ns, int64_t abandon_ns,
                   OutboxRequest &request);

// Makes a mailbox's outbox due again only at `due_ns`, so that one whose claim
// failed holds up no other. Its next own write makes it due as before.
bool outbox_defer(int64_t mailbox, int64_t due_ns);

// The earliest time something is due, false when nothing is waiting
bool outbox_next_due(int64_t &at_ns);

enum class Outcome { Sent, Rejected, Unknown, Retry };

// Ignored when the owner has started a new attempt since this one, or deleted
// the message, or the mailbox is purged. An attempt that keeps needing a
// retry past the deadline becomes Unknown.
void outbox_apply(const OutboxRequest &request, Outcome outcome,
                  const std::string &detail, int64_t now_ns,
                  int64_t deadline_ns);

OutboxPage outbox_list(const Mailbox &box, std::optional<int64_t> cursor,
                       int64_t limit);
bool outbox_get(const Mailbox &box, int64_t id, OutboxSummary &summary,
                std::string &html_body,
                std::vector<OutboxAttachment> &attachments);

// Return why it was refused, or an empty string
std::string outbox_resend(const Mailbox &box, int64_t id, int64_t now_ns);
std::string outbox_delete(const Mailbox &box, int64_t id);

} // namespace store
