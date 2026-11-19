// The Inbox, Trash and Spam folders, and the senders a mailbox blocks

#include <string>

#include "api.h"
#include "ic0.h"
#include "ic_api.h"
#include "support.h"

using namespace native;

namespace {

std::string folder(int number, int limit = 50) {
  return "(record { folder = " + std::to_string(number) +
         "; cursor = null; limit = " + std::to_string(limit) + " })";
}

std::string uids(int first, int count) {
  std::string out = "vec {";
  for (int uid = first; uid < first + count; ++uid)
    out += " " + std::to_string(uid) + ";";
  return out + " }";
}

std::string move(const std::string &test, const std::string &list, int to) {
  return CALL(test, mail_move,
              "(\"fox\", " + list + ", " + std::to_string(to) + ")", USER_A);
}

std::string listed(const std::string &test, int number) {
  return CALL(test, mail_list, in("fox", folder(number)), USER_A);
}

std::string fox(const std::string &test) { return me_of(test, USER_A, "fox"); }

void later_by_days(int days) {
  ic0mock_set_time_override(IC_API::time() +
                            static_cast<uint64_t>(days) * 86'400'000'000'000);
}

} // namespace

void test_folders(MockIC &) {
  add_mailbox("fox's mailbox", USER_A, "fox");
  CALL("seed fox's mailbox", dev_seed, "(\"fox\", 1, 4)", CONTROLLER);
  {
    const std::string test = "new mail is in the Inbox";
    const std::string inbox = listed(test, 0);
    expect(test, inbox, "uid = 4 : ");
    expect(test, inbox, "folder = 0 : ");
    expect(test, listed(test, 1), "items = vec {}");
    expect(test, fox(test), "unseen = 4 : ");
  }
  {
    const std::string test = "a move to Trash takes unread mail off the count";
    expect(test, move(test, "vec { 1; 2; 99 }", 1), "(2 : nat64)");
    const std::string trash = listed(test, 1);
    expect(test, trash, "uid = 2 : ");
    expect(test, trash, "folder = 1 : ");
    expect_not(test, listed(test, 0), "uid = 2 : ");
    expect(test, fox(test), "unseen = 2 : ");
    expect(test, fox(test), "message_count = 4 : ");
    // Already there: nothing moves
    expect(test, move(test, "vec { 1 }", 1), "(0 : nat64)");
  }
  {
    const std::string test = "reading mail in Trash leaves the count alone";
    CALL(test, mail_set_flags, "(\"fox\", vec { 1 }, 1, 0)", USER_A);
    expect(test, fox(test), "unseen = 2 : ");
  }
  {
    const std::string test = "a search covers one folder";
    const auto search = [&](int number) {
      return CALL(test, mail_search,
                  in("fox", "(record { \"query\" = \"seedcommon\"; folder = " +
                                std::to_string(number) +
                                "; cursor = null; limit = 10 })"),
                  USER_A);
    };
    const std::string inbox = search(0);
    expect(test, inbox, "uid = 3 : ");
    expect_not(test, inbox, "uid = 1 : ");
    const std::string trash = search(1);
    expect(test, trash, "uid = 1 : ");
    expect_not(test, trash, "uid = 3 : ");
  }
  {
    const std::string test = "a restore counts unread mail again";
    // uid 1 was read in Trash, uid 2 was not
    expect(test, move(test, "vec { 1; 2 }", 0), "(2 : nat64)");
    expect(test, fox(test), "unseen = 3 : ");
    expect(test, listed(test, 1), "items = vec {}");
  }
  {
    const std::string test = "Spam keeps unread mail off the count too";
    expect(test, move(test, "vec { 3 }", 2), "(1 : nat64)");
    expect(test, fox(test), "unseen = 2 : ");
    expect(test, listed(test, 2), "uid = 3 : ");
    // From Spam to Trash, still off the count
    expect(test, move(test, "vec { 3 }", 1), "(1 : nat64)");
    expect(test, fox(test), "unseen = 2 : ");
    expect(test, CALL(test, admin_check, "(\"fox\", null)", CONTROLLER),
           "result = \"ok\"");
  }
  {
    const std::string test = "a delete in Trash leaves the count alone";
    expect(test, CALL(test, mail_delete, "(\"fox\", vec { 3 })", USER_A),
           "(1 : nat64)");
    expect(test, fox(test), "unseen = 2 : ");
    expect(test, fox(test), "message_count = 3 : ");
    expect(test, CALL(test, admin_check, "(\"fox\", null)", CONTROLLER),
           "result = \"ok\"");
  }
  TRAPS("a list names a folder there is", mail_list, in("fox", folder(3)),
        USER_A, "no such folder");
  TRAPS("a move names a folder there is", mail_move, "(\"fox\", vec { 1 }, 3)",
        USER_A, "no such folder");
  TRAPS("201 messages are too many to move at once", mail_move,
        "(\"fox\", " + uids(1, 201) + ", 1)", USER_A,
        "too many messages at once");
  TRAPS("201 messages are too many to flag at once", mail_set_flags,
        "(\"fox\", " + uids(1, 201) + ", 2, 0)", USER_A,
        "too many messages at once");
  TRAPS("only a member moves mail", mail_move, "(\"fox\", vec { 1 }, 1)",
        USER_B, "no such mailbox for this principal");
  {
    const std::string test = "flags change for many messages at once";
    CALL(test, mail_set_flags, "(\"fox\", vec { 1; 2; 4 }, 2, 0)", USER_A);
    const std::string inbox = listed(test, 0);
    check(test,
          count(inbox, "flags = 2 : ") + count(inbox, "flags = 3 : ") == 3,
          "not every message flagged in: " + inbox);
    CALL(test, mail_set_flags, "(\"fox\", vec { 1; 2; 4 }, 1, 2)", USER_A);
    expect(test, fox(test), "unseen = 0 : ");
  }

  CALL("seed fox's mailbox again", dev_seed, "(\"fox\", 5, 25)", CONTROLLER);
  {
    const std::string test = "Trash empties itself after 30 days, 20 at a time";
    expect(test, move(test, uids(5, 25), 1), "(25 : nat64)");
    expect(test, fox(test), "message_count = 28 : ");
    later_by_days(29);
    expect(test, move(test, "vec {}", 1), "(0 : nat64)");
    expect(test, fox(test), "message_count = 28 : ");
    later_by_days(2);
    move(test, "vec {}", 1);
    expect(test, fox(test), "message_count = 8 : ");
    move(test, "vec {}", 1);
    expect(test, fox(test), "message_count = 3 : ");
    expect(test, listed(test, 1), "items = vec {}");
    expect(test, CALL(test, admin_check, "(\"fox\", null)", CONTROLLER),
           "result = \"ok\"");
    ic0mock_clear_time_override();
  }

  {
    const std::string test = "a blocked address is kept in lower case";
    CALL(test, mail_block, "(\"fox\", \"Spammer@Example.COM\")", USER_A);
    CALL(test, mail_block, "(\"fox\", \"spammer@example.com\")", USER_A);
    const std::string list = CALL(test, mail_blocked, "(\"fox\")", USER_A);
    expect(test, list, "address = \"spammer@example.com\"");
    expect(test, list, "blocked_by = principal \"" + USER_A + "\"");
    expect(test, list, "name = opt \"Alice A\"");
    check(test, count(list, "address = ") == 1, "not one address in: " + list);
  }
  for (const std::string &address :
       {"", "nope", "@example.com", "spammer@", "a b@example.com",
        "<a@example.com>", std::string(250, 'a') + "@x.io"}) {
    TRAPS("not an address: " + address.substr(0, 20), mail_block,
          "(\"fox\", \"" + address + "\")", USER_A, "not an email address");
  }
  TRAPS("only a member blocks", mail_block, "(\"fox\", \"x@example.com\")",
        USER_B, "no such mailbox for this principal");
  TRAPS("only a member reads the blocked list", mail_blocked, "(\"fox\")",
        USER_B, "no such mailbox for this principal");
  {
    const std::string test = "an unblocked address is off the list";
    CALL(test, mail_unblock, "(\"fox\", \"SPAMMER@example.com\")", USER_A);
    CALL(test, mail_unblock, "(\"fox\", \"spammer@example.com\")", USER_A);
    expect(test, CALL(test, mail_blocked, "(\"fox\")", USER_A), "(vec {})");
  }
  {
    const std::string test = "the blocked list holds 1000 addresses";
    CALL(test, dev_file_exec,
         "(\"fox\", \"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 "
         "FROM c WHERE x < 1000) INSERT INTO blocked SELECT 'a' || x || "
         "'@example.com', 'p', 0 FROM c\")",
         CONTROLLER);
    TRAPS("a full list takes no more", mail_block,
          "(\"fox\", \"more@example.com\")", USER_A,
          "the mailbox blocks 1000 addresses already");
    // An address on it already is no change
    CALL(test, mail_block, "(\"fox\", \"a7@example.com\")", USER_A);
    CALL(test, mail_unblock, "(\"fox\", \"a7@example.com\")", USER_A);
    CALL(test, mail_block, "(\"fox\", \"more@example.com\")", USER_A);
  }
}
