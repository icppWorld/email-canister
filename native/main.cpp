// The canister's code as a native executable, on the toolchain's Mock IC:
// fast tests of the logic that needs no replica. Build and run it with
// `make test-native`. The groups share one canister, in this order.

#include "api.h"
#include "mock_ic.h"
#include "support.h"

int main() {
  MockIC mock_ic(true);
  native::setup(mock_ic, "test/email-canister-test.did");

  mock_ic.run_test("init", canister_init, "4449444c0000", "", false,
                   native::CONTROLLER);
  test_admin(mock_ic);
  test_smtp(mock_ic);
  test_mailbox(mock_ic);
  test_outbox(mock_ic);
  test_export(mock_ic);
  test_folders(mock_ic);
  test_check(mock_ic); // last: it leaves every mailbox held

  return mock_ic.test_summary();
}
