// A mailbox file's check, the mailbox held for repair, and the file schema
// upgrades. Runs last: it leaves every mailbox held.

#include <string>

#include "api.h"
#include "db.h"
#include "ic0.h"
#include "ic_api.h"
#include "support.h"

using namespace native;

namespace {

const std::string USER_E = "66iqw-xyqaa-aaaaa-aaaby-kai";

std::string inspect(const std::string &test, const std::string &local,
                    const std::string &table = "null") {
  return CALL(test, admin_check, "(\"" + local + "\", " + table + ")",
              CONTROLLER);
}

// The admin_list_entries record of `local`
std::string entry(const std::string &test, const std::string &local) {
  const std::string entries = CALL(test, admin_list_entries, "()", CONTROLLER);
  const size_t at = entries.find("local = \"" + local + "\"");
  check(test, at != std::string::npos, "no entry for " + local);
  return entries.substr(at, entries.find('}', at) - at);
}

void file_exec(const std::string &test, const std::string &local,
               const std::string &sql) {
  CALL(test, dev_file_exec, "(\"" + local + "\", \"" + sql + "\")", CONTROLLER);
}

// Natively no timer runs the pump: each mailbox's upgrade is called by hand
void upgrade_now(const std::string &test) {
  for (int id = 1; id <= 20; ++id)
    CALL(test, ingest_upgrade_file, "(" + std::to_string(id) + ")", SELF);
}

// The clock moves past the wait that a failed upgrade leaves
void later() { ic0mock_set_time_override(IC_API::time() + 61'000'000'000); }

void upgrade_round(const std::string &test) {
  upgrade_now(test);
  later();
}

// As many rounds as a step that fails takes to hold its mailbox
void upgrade_every_file(const std::string &test) {
  for (int round = 0; round < 3; ++round)
    upgrade_round(test);
}

const std::string k_list = list_args("10");

} // namespace

void test_check(MockIC &) {
  // The release's schema version, before the steps the tests add: each
  // version below keeps its place relative to it
  const int64_t release = db::mailbox_version();
  const auto version = [release](int64_t ahead) {
    return std::to_string(release + ahead);
  };
  TRAPS("only a controller checks a mailbox", admin_check, "(\"bob\", null)",
        USER_B, "controllers only");
  TRAPS("a check refuses an address that has no entry", admin_check,
        "(\"ghost\", null)", CONTROLLER, "no such entry");
  TRAPS("a check refuses a table the file does not have", admin_check,
        "(\"bob\", opt \"nope\")", CONTROLLER, "the file has no table nope");
  TRAPS("only the canister upgrades a file", ingest_upgrade_file, "(1)",
        CONTROLLER, "only this canister can call this method");
  {
    const std::string test = "a sound mailbox checks ok";
    const std::string whole = inspect(test, "bob");
    expect(test, whole, "result = \"ok\"");
    check(test, !field(whole, "instructions").empty(), "no instructions");
    expect(test, inspect(test, "bob", "opt \"messages\""), "result = \"ok\"");
    expect(test, entry(test, "bob"), "needs_repair = null");
  }
  {
    const std::string test = "a check of one table checks only that table";
    file_exec(test, "bob", "UPDATE counters SET next_uid = next_uid + 5");
    expect(test, inspect(test, "bob", "opt \"counters\""), "result = \"ok\"");
    expect(test, entry(test, "bob"), "needs_repair = null");
  }
  {
    const std::string test = "a check of the whole file holds a broken mailbox";
    expect(test, inspect(test, "bob"), "counters.next_uid is");
    expect(test, entry(test, "bob"), "needs_repair = opt \"counters.next_uid");
    TRAPS("a held mailbox refuses its owner's reads", mail_list,
          in("bob", k_list), USER_B, "this mailbox needs repair");
    TRAPS("a held mailbox refuses its owner's sends", mail_send,
          in("bob", Send{.client_id = "held"}.args()), USER_B,
          "this mailbox needs repair");
    // A download reads the raw file, so the owner can still keep a copy
    const std::string info =
        CALL(test, mail_export_freeze, "(\"bob\", null)", USER_B);
    CALL(test, mail_export_thaw, "(\"bob\", " + field(info, "started_ns") + ")",
         USER_B);
  }
  {
    const std::string test = "a check that finds the file sound again frees it";
    file_exec(test, "bob", "UPDATE counters SET next_uid = next_uid - 5");
    expect(test, inspect(test, "bob"), "result = \"ok\"");
    expect(test, entry(test, "bob"), "needs_repair = null");
    CALL(test, mail_list, in("bob", k_list), USER_B);
  }
  {
    const std::string test = "a damaged table is found by a check of it";
    add_mailbox(test, USER_E, "erin");
    CALL(test, dev_damage_file, "(\"erin\", \"outbox_bodies\")", CONTROLLER);
    expect(test, inspect(test, "erin", "opt \"messages\""), "result = \"ok\"");
    expect_not(test, inspect(test, "erin", "opt \"outbox_bodies\""),
               "result = \"ok\"");
    expect(test, entry(test, "erin"), "needs_repair = null");
    expect_not(test, inspect(test, "erin"), "result = \"ok\"");
    expect_not(test, entry(test, "erin"), "needs_repair = null");
  }
  {
    const std::string test = "a purge frees a mailbox held for repair";
    CALL(test, admin_set_disabled, "(\"erin\", true)", CONTROLLER);
    expect(test, CALL(test, admin_purge, "(\"erin\")", CONTROLLER),
           "remaining = 0");
    TRAPS("a vacated address is not checked", admin_check, "(\"erin\", null)",
          CONTROLLER, "no such entry");
    add_mailbox(test, USER_E, "erin");
    expect(test, entry(test, "erin"), "needs_repair = null");
    expect(test, inspect(test, "erin"), "result = \"ok\"");
  }

  {
    const std::string test = "a schema step holds every mailbox until its file "
                             "is upgraded";
    // Mail in bob's outbox makes it due for the outbox pump
    CALL(test, mail_send, in("bob", Send{.client_id = "due"}.args()), USER_B);
    CALL(test, dev_schema_step, "(\"CREATE TABLE extra(x)\")", CONTROLLER);
    TRAPS("a mailbox waiting for its upgrade is busy", mail_list,
          in("alice", k_list), USER_A, "busy: the mailbox is being upgraded");
    // Waiting is not damage
    expect(test, inspect(test, "alice"), "result = \"ok\"");
    // A file waiting for its upgrade, held for damage, is freed once repaired
    file_exec(test, "erin", "UPDATE counters SET next_uid = next_uid + 5");
    expect(test, inspect(test, "erin"), "counters.next_uid is");
    file_exec(test, "erin", "UPDATE counters SET next_uid = next_uid - 5");
    expect(test, inspect(test, "erin"), "result = \"ok\"");
    expect(test, entry(test, "erin"), "needs_repair = null");
    // The outbox leaves bob to his upgrade: were it to claim him, it would
    // defer him, and the upgrade with him
    CALL(test, outbox_pump, "()", SELF);
    upgrade_every_file(test);
    CALL(test, mail_list, in("alice", k_list), USER_A);
    CALL(test, mail_list, in("bob", k_list), USER_B);
    file_exec(test, "alice", "INSERT INTO extra VALUES(1)");
    expect(test, inspect(test, "alice"), "result = \"ok\"");
  }
  {
    const std::string test = "a new mailbox starts at the current version";
    add_mailbox(test, USER_C, "cleo");
    CALL(test, mail_list, in("cleo", k_list), USER_C);
    file_exec(test, "cleo", "INSERT INTO extra VALUES(1)");
  }
  {
    const std::string test = "a file newer than the registry is held";
    file_exec(test, "bob", "PRAGMA user_version = " + version(4));
    // The file's own version is checked before any check holds it
    TRAPS("a file of another version is not used", mail_list, in("bob", k_list),
          USER_B, "busy: the mailbox cannot be opened");
    const std::string result = inspect(test, "bob");
    expect(test, result,
           "the schema version is " + version(4) + " in the file, " +
               version(1) + " in the registry");
    TRAPS("a newer file refuses its owner", mail_list, in("bob", k_list),
          USER_B, "this mailbox needs repair");
  }
  {
    const std::string test = "an upgrade holds a file out of step with its "
                             "registry";
    file_exec(test, "cleo", "PRAGMA user_version = " + version(3));
    file_exec(test, "erin", "PRAGMA user_version = " + version(0));
    // A step that fails on every file that has the table already
    CALL(test, dev_schema_step, "(\"CREATE TABLE extra(x)\")", CONTROLLER);
    upgrade_round(test);
    expect(test, entry(test, "cleo"),
           "needs_repair = opt \"the file has schema version " + version(3) +
               ", its registry " + version(1));
    TRAPS("a file ahead of its registry is not used", mail_list,
          in("cleo", k_list), USER_C, "this mailbox needs repair");
    // Not upgraded from its own version, where its step would fail
    expect(test, entry(test, "erin"),
           "needs_repair = opt \"the file has schema version " + version(0) +
               ", its registry " + version(1));
  }
  {
    const std::string test = "a step that fails holds the mailbox on its third "
                             "failure";
    const std::string failed_step =
        "needs_repair = opt \"the schema upgrade failed: the step to schema "
        "version " +
        version(2) + " failed";
    // A canister low on cycles fails every upgrade for a while. alice's
    // first failure came with the round above; this is her second.
    upgrade_now(test);
    // Within the minute after a failure, no upgrade is tried
    upgrade_now(test);
    upgrade_now(test);
    expect(test, entry(test, "alice"), "needs_repair = null");
    TRAPS("a failed upgrade is tried again later", mail_list,
          in("alice", k_list), USER_A, "busy: the mailbox is being upgraded");
    later();
    upgrade_now(test); // the third
    expect(test, entry(test, "alice"), failed_step);
    TRAPS("a failed upgrade refuses the owner", mail_list, in("alice", k_list),
          USER_A, "this mailbox needs repair");
    // A check of one table reports on that table only
    expect(test, inspect(test, "alice", "opt \"messages\""), "result = \"ok\"");
    // A check that finds the file sound frees it, so that a release that fixes
    // the step can upgrade it. This step fails again.
    expect(test, inspect(test, "alice"), "result = \"ok\"");
    expect(test, entry(test, "alice"), "needs_repair = null");
    TRAPS("a freed file waits for its upgrade", mail_list, in("alice", k_list),
          USER_A, "busy: the mailbox is being upgraded");
    upgrade_every_file(test);
    expect(test, entry(test, "alice"), failed_step);
  }
  ic0mock_clear_time_override();
}
