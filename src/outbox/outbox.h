// Sends queued mail through the Caffeine bridge, one attempt per message.

#pragma once

#include <cstdint>
#include <string>

namespace outbox {

// Heap state does not survive an upgrade: call from init and post_upgrade
void start(const std::string &canister_self);

// Schedules a pump for the next message that is due
void arm();

// Traps at this point in the test build, and does nothing otherwise
void crash_at(const char *point);

#ifdef EMAIL_CANISTER_TEST_HOOKS
void set_timing(uint64_t retry_ns, uint64_t deadline_ns, uint64_t abandon_ns);
void set_crash_point(const std::string &point);
#endif

} // namespace outbox
