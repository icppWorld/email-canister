// What the test build measures. Production code calls these; they do nothing
// in a release build.

#pragma once

#ifdef EMAIL_CANISTER_TEST_HOOKS
// Keeps the instructions the current call has used, for dev_last_cost
void dev_record_cost(const char *method);
#else
inline void dev_record_cost(const char *) {}
#endif
