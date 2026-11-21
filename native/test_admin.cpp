// The admin methods: settings, entries, and what they refuse. Sets up the
// domain, the bridge and the mailboxes the later groups use.

#include <cstdint>
#include <string>

#include "api.h"
#include "support.h"

using namespace native;

namespace {

const std::string USER_D =
    "ny7xv-gaeaq-caiba-eaqca-ibaea-qcaib-aeaqc-aibae-aqcai-baeaq-cae";

uint64_t uidvalidity(const std::string &test, const std::string &caller) {
  const std::string value =
      field(CALL(test, mail_me, "()", caller), "uidvalidity");
  return value.empty() ? 0 : std::stoull(value);
}

} // namespace

void test_admin(MockIC &mock_ic) {
  {
    // All of stable memory, in pages of 64 KiB, as the file system reserved
    // it. Past 4 GiB, so a 32-bit size would not do.
    const std::string test = "stable memory is counted in bytes";
    mock_ic.set_stable_size(70000);
    const std::string totals =
        CALL(test, admin_storage_totals, "()", CONTROLLER);
    mock_ic.set_stable_size(0);
    expect_equal(test, field(totals, "stable_memory_bytes"), "4587520000");
  }
  {
    const std::string test = "the settings start empty";
    const std::string settings = CALL(test, admin_settings, "()", CONTROLLER);
    expect(test, settings, "domain = \"\"");
    expect(test, settings, "bridge = null");
  }
  {
    const std::string test = "the domain is stored in lower case";
    CALL(test, admin_set_domain, "(\"MAIL.Example\")", CONTROLLER);
    CALL(test, admin_set_bridge, "(principal \"" + USER_C + "\")", CONTROLLER);
    const std::string settings = CALL(test, admin_settings, "()", CONTROLLER);
    expect(test, settings, "domain = \"mail.example\"");
    expect(test, settings, "bridge = opt principal \"" + USER_C + "\"");
  }
  {
    const std::string test = "a mailbox's address is stored in lower case";
    add_mailbox(test, USER_A, "Alice");
    add_mailbox(test, USER_B, "bob", "opt 5_000_000");
    const std::string entries =
        CALL(test, admin_list_entries, "()", CONTROLLER);
    expect(test, entries, "local = \"alice\"");
    expect(test, entries, "quota_bytes = 2_147_483_648");
    expect(test, entries, "quota_bytes = 5_000_000");
    expect(test, entries, "\"principal\" = principal \"" + USER_A + "\"");
    expect(test, CALL(test, mail_me, "()", USER_A),
           "address = \"alice@mail.example\"");
  }
  TRAPS(
      "a mailbox is created once", admin_create_mailbox,
      "(record { local = \"alice\"; quota_bytes = null; first_member = null })",
      CONTROLLER, "alice already exists.");
  // Creating never gives anyone access to a mailbox that exists, and a
  // refused first member leaves no mailbox behind
  TRAPS("creating never adds a member to an existing mailbox",
        admin_create_mailbox,
        "(record { local = \"alice\"; quota_bytes = null; first_member = "
        "opt principal \"" +
            USER_B + "\" })",
        CONTROLLER, "alice already exists.");
  TRAPS("a refused first member creates no mailbox", admin_create_mailbox,
        "(record { local = \"lone\"; quota_bytes = null; first_member = "
        "opt principal \"" +
            ANONYMOUS + "\" })",
        CONTROLLER, "the anonymous principal cannot be a member");
  {
    const std::string test = "creating adds only to a new mailbox";
    const std::string entries =
        CALL(test, admin_list_entries, "()", CONTROLLER);
    expect(test, entries, "local = \"alice\"");
    expect_not(test, entries, "local = \"lone\"");
    const std::string me = CALL(test, mail_me, "()", USER_B);
    expect(test, me, "local = \"bob\"");
    expect_not(test, me, "local = \"alice\"");
  }
  {
    // A file larger than a schema step's index build fits in one call
    const std::string test = "a quota above 4 GiB is refused";
    const std::string too_large = "4_294_967_297";
    TRAPS(test, admin_create_mailbox,
          "(record { local = \"huge\"; quota_bytes = opt " + too_large +
              "; first_member = null })",
          CONTROLLER, "quota too large");
    expect_not(test, CALL(test, admin_list_entries, "()", CONTROLLER),
               "local = \"huge\"");
    TRAPS(test, admin_set_quota, "(\"alice\", " + too_large + ")", CONTROLLER,
          "quota too large");
    // One more than the store can hold, which it would keep as negative
    TRAPS(test, admin_set_quota, "(\"alice\", 9_223_372_036_854_775_808)",
          CONTROLLER, "quota too large");
    CALL(test, admin_set_quota, "(\"alice\", 4_294_967_296)", CONTROLLER);
    expect(test, CALL(test, admin_list_entries, "()", CONTROLLER),
           "quota_bytes = 4_294_967_296");
    CALL(test, admin_set_quota, "(\"alice\", 2_147_483_648)", CONTROLLER);
  }
  TRAPS("an invalid address is refused", admin_create_mailbox,
        "(record { local = \"a b\"; quota_bytes = null; first_member = null })",
        CONTROLLER, "invalid address");
  TRAPS("a member is added once", admin_add_member,
        "(\"alice\", principal \"" + USER_A + "\", null)", CONTROLLER,
        "already a member of this mailbox");
  TRAPS("the anonymous principal is no member", admin_add_member,
        "(\"alice\", principal \"" + ANONYMOUS + "\", null)", CONTROLLER,
        "the anonymous principal cannot be a member");
  TRAPS("a member needs a mailbox", admin_add_member,
        "(\"ghost\", principal \"" + USER_A + "\", null)", CONTROLLER,
        "no such mailbox");
  TRAPS("only a member is removed", admin_remove_member,
        "(\"alice\", principal \"" + USER_B + "\")", CONTROLLER,
        "not a member of this mailbox");
  for (
      const auto &[method, fn, args] :
      {std::tuple<std::string, Method, std::string>{
           "admin_create_mailbox", admin_create_mailbox,
           "(record { local = \"x\"; quota_bytes = null; first_member = null })"},
       {"admin_add_member", admin_add_member,
        "(\"alice\", principal \"" + USER_B + "\", null)"},
       {"admin_remove_member", admin_remove_member,
        "(\"alice\", principal \"" + USER_A + "\")"},
       {"admin_set_name", admin_set_name,
        "(principal \"" + USER_A + "\", \"A\")"}}) {
    traps(method + " is for controllers only", fn, method, args, USER_A,
          "controllers only");
  }
  {
    // The names members see: set, changed, removed
    const std::string test = "a principal's name";
    CALL(test, admin_set_name, "(principal \"" + USER_A + "\", \"Alice\")",
         CONTROLLER);
    CALL(test, admin_set_name, "(principal \"" + USER_A + "\", \"Alice A\")",
         CONTROLLER);
    expect(test, CALL(test, mail_me, "()", USER_A), "name = opt \"Alice A\"");
    expect(test, CALL(test, admin_list_entries, "()", CONTROLLER),
           "name = opt \"Alice A\"");
    CALL(test, admin_set_name, "(principal \"" + USER_B + "\", \"Bob\")",
         CONTROLLER);
    CALL(test, admin_set_name, "(principal \"" + USER_B + "\", \"\")",
         CONTROLLER);
    expect(test, CALL(test, mail_me, "()", USER_B), "name = null");
  }
  TRAPS("a name has no control characters", admin_set_name,
        "(principal \"" + USER_A + "\", \"a\\nb\")", CONTROLLER,
        "invalid name");
  TRAPS("a name is at most 64 bytes", admin_set_name,
        "(principal \"" + USER_A + "\", \"" + std::string(65, 'n') + "\")",
        CONTROLLER, "invalid name");
  {
    // Alice and bob share "team", and each keeps their own mailbox
    const std::string test = "a shared mailbox";
    add_mailbox(test, USER_A, "team");
    CALL(test, admin_add_member,
         "(\"team\", principal \"" + USER_B + "\", null)", CONTROLLER);
    const std::string alice = CALL(test, mail_me, "()", USER_A);
    expect(test, alice, "local = \"alice\"");
    expect(test, alice, "local = \"team\"");
    check(test,
          alice.find("local = \"alice\"") < alice.find("local = \"team\""),
          "not by address: " + alice);
    const std::string bob = CALL(test, mail_me, "()", USER_B);
    expect(test, bob, "local = \"bob\"");
    expect(test, bob, "local = \"team\"");
    expect(test, bob, "members = 2");
    CALL(test, mail_list, in("team", list_args("1")), USER_B);
  }
  {
    // A removed member loses the mailbox at once; the others keep it
    const std::string test = "a removed member";
    CALL(test, admin_remove_member, "(\"team\", principal \"" + USER_B + "\")",
         CONTROLLER);
    TRAPS("a removed member is refused", mail_list, in("team", list_args("1")),
          USER_B, "no such mailbox for this principal");
    expect_not(test, CALL(test, mail_me, "()", USER_B), "\"team\"");
    CALL(test, mail_list, in("team", list_args("1")), USER_A);
    CALL(test, admin_add_member,
         "(\"team\", principal \"" + USER_B + "\", null)", CONTROLLER);
  }

  for (const auto &[name, fn, method, args] :
       {std::tuple<std::string, Method, std::string, std::string>{
            "set_disabled", admin_set_disabled, "admin_set_disabled",
            "(\"ghost\", true)"},
        {"set_quota", admin_set_quota, "admin_set_quota", "(\"ghost\", 1)"},
        {"purge", admin_purge, "admin_purge", "(\"ghost\")"},
        {"retry_moves", admin_retry_moves, "admin_retry_moves",
         "(\"ghost\")"}}) {
    traps(name + " refuses an address that has no entry", fn, method, args,
          CONTROLLER, "no such entry");
  }
  TRAPS("an active entry is not purged", admin_purge, "(\"alice\")", CONTROLLER,
        "disable the entry before purging it");

  // A purge in steps: until it ends, the entry cannot be enabled again, and
  // the address can be given to someone else only after it
  {
    const std::string test = "a purge in steps";
    add_mailbox(test, USER_D, "dora");
    const uint64_t before = uidvalidity(test, USER_D);
    CALL(test, admin_set_disabled, "(\"dora\", true)", CONTROLLER);
    CALL(test, dev_set_budgets, "(3_000_000_000, 4096)", CONTROLLER);
    const std::string first = CALL(test, admin_purge, "(\"dora\")", CONTROLLER);
    expect_not(test, first, "remaining = 0 ");
    TRAPS("an entry being purged is not enabled", admin_set_disabled,
          "(\"dora\", false)", CONTROLLER,
          "the entry is being purged: finish the purge first");
    CALL(test, dev_set_budgets, "(3_000_000_000, 1_073_741_824)", CONTROLLER);
    expect(test, CALL(test, admin_purge, "(\"dora\")", CONTROLLER),
           "remaining = 0");
    // Its members went with it
    expect(test, CALL(test, mail_me, "()", USER_D), "mailboxes = vec {}");
    const std::string entries =
        CALL(test, admin_list_entries, "()", CONTROLLER);
    expect_not(test, entries, USER_D);
    expect(test, entries, "vacant = true"); // dora's, the only purged one
    TRAPS("a purged mailbox takes no member", admin_add_member,
          "(\"dora\", principal \"" + USER_D + "\", null)", CONTROLLER,
          "no such mailbox");

    // Given out again, the address tells a syncing client to start over
    add_mailbox(test, USER_D, "dora");
    const uint64_t after = uidvalidity(test, USER_D);
    check(test, before > 0 && after > before,
          "uidvalidity " + std::to_string(after) + " is not above " +
              std::to_string(before));

    // A member added from a list read before that goes to the old mailbox,
    // which is gone: the new one is someone else's
    const std::string to_dora = "(\"dora\", principal \"" + USER_A + "\", opt ";
    TRAPS("a member is added only to the mailbox as listed", admin_add_member,
          to_dora + std::to_string(before) + ")", CONTROLLER,
          "dora was created again since it was listed");
    expect(test, CALL(test, mail_me, "()", USER_A), "mailboxes = vec {");
    expect_not(test, CALL(test, mail_me, "()", USER_A), "local = \"dora\"");
    CALL(test, admin_add_member, to_dora + std::to_string(after) + ")",
         CONTROLLER);
    expect(test, CALL(test, mail_me, "()", USER_A), "local = \"dora\"");
    CALL(test, admin_remove_member, "(\"dora\", principal \"" + USER_A + "\")",
         CONTROLLER);
  }
}
