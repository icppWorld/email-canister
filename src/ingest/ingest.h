// The background pipeline that moves queued mail into the mailbox files, then
// parses and indexes it there.
//
// smtp_request only queues a message in control.db, so that accepting mail
// stays cheap and never depends on the parser. A timer then hands one move,
// one parse or one cleanup of expired mail at a time to a call to this
// canister: one that traps there rolls back alone.

#pragma once

#include <string>

struct IC_CallError;

namespace ingest {

// Heap state does not survive an upgrade: call from init and post_upgrade
void start(const std::string &canister_self);

// Schedules a pump if none is pending. Safe to call repeatedly.
void arm();

// Whether a failed call to this canister may have run, and so counts as an
// attempt. One that was never sent, that the IC refused before it ran, or
// that failed while this canister was stopping, does not.
bool may_have_run(const IC_CallError &error, bool running);

#ifdef EMAIL_CANISTER_TEST_HOOKS
void set_paused(bool paused);
void set_trap_moves(bool trap);
#endif

} // namespace ingest
