// The Inbox, Trash and Spam folders, and the senders a mailbox blocks

#include <string>
#include <utility>
#include <vector>

#include "allowlist.h"
#include "api.h"
#include "db.h"
#include "ic0.h"
#include "ic_api.h"
#include "mail_store.h"
#include "queue_store.h"
#include "support.h"

using namespace native;

namespace {

std::string move(const std::string &test, const std::string &list, int to) {
  return CALL(test, mail_move,
              "(\"fox\", " + list + ", " + std::to_string(to) + ")", USER_A);
}

std::string listed(const std::string &test, int number) {
  return CALL(test, mail_list, in("fox", list_args("50", number)), USER_A);
}

std::string fox(const std::string &test) { return me_of(test, USER_A, "fox"); }

const int64_t k_day_ns = 86'400'000'000'000;

void later_by_days(int days) {
  ic0mock_set_time_override(IC_API::time() +
                            static_cast<uint64_t>(days) *
                                static_cast<uint64_t>(k_day_ns));
}

// Sets when the messages arrived, `days` ago: seeded mail arrived at 0, which
// the clock, counted natively from boot, may or may not be 30 days past
void arrived(const std::string &test, const std::string &uids, int days) {
  const int64_t at = static_cast<int64_t>(IC_API::time()) - days * k_day_ns;
  CALL(test, dev_file_exec,
       "(\"fox\", \"UPDATE messages SET received_ns = " + std::to_string(at) +
           " WHERE uid IN (" + uids + ")\")",
       CONTROLLER);
}

std::string fox_id() {
  return std::to_string(
      control_integer("SELECT id FROM mailboxes WHERE local = 'fox'"));
}

bool clean_due() {
  return control_integer(
             "SELECT clean_due FROM mailboxes WHERE local = 'fox'") > 0;
}

// One integer from fox's file, or -1
int64_t fox_integer(const std::string &sql) {
  db::Stmt select(store::mailbox_file(std::stoll(fox_id())), sql.c_str());
  return select && select.row() ? select.column_integer(0) : -1;
}

// A turn of the pump, whose calls to the canister itself the Mock IC runs
void pump(const std::string &test) { CALL(test, ingest_pump, "()", SELF); }

// ingest_clean, after a member's move marked the mailbox again meanwhile
bool g_marked_meanwhile = false;
void ingest_clean_after_a_mark() {
  g_marked_meanwhile = true;
  store::clean_soon(std::stoll(fox_id()));
  ingest_clean();
}

// A cleanup turn of the pump, which natively no timer runs
void clean(const std::string &test) {
  CALL(test, ingest_clean, "(" + fox_id() + ")", SELF);
}

// Mail for fox from `user`@sender.example
std::string mail_from(const std::string &user) {
  return "(record { envelope = opt record { from = record { user = \"" + user +
         "\"; domain = \"sender.example\" }; to = vec { record { user = "
         "\"fox\"; domain = \"mail.example\" } } }; message = opt record { "
         "headers = vec { record { name = \"From\"; value = \"" +
         user +
         "@sender.example\" }; record { name = \"Subject\"; value = "
         "\"" +
         user +
         "\" } }; body = blob \"hello\" }; gateway_flags = null; "
         "message_id = opt \"gateway-1\" })";
}

// Delivers mail_from(`user`) as far as the queue, and returns its row
std::string queue_mail(const std::string &test, const std::string &user) {
  expect(test, CALL(test, smtp_request, mail_from(user), CONTROLLER),
         "variant { Ok");
  return std::to_string(control_integer(
      "SELECT max(id) FROM queue WHERE mailbox_id = " + fox_id()));
}

} // namespace

void test_folders(MockIC &mock_ic) {
  for (const auto &[name, method] :
       std::vector<std::pair<std::string, void (*)()>>{
           {"ingest_move", ingest_move},
           {"ingest_process", ingest_process},
           {"ingest_merge", ingest_merge},
           {"ingest_clean", ingest_clean},
           {"ingest_upgrade_file", ingest_upgrade_file}}) {
    mock_ic.register_method(name, method);
  }
  add_mailbox("fox's mailbox", USER_A, "fox");
  CALL("seed fox's mailbox", dev_seed, "(\"fox\", 1, 4)", CONTROLLER);
  arrived("fox's mail arrived now", "1, 2, 3, 4", 0);
  {
    const std::string test = "new mail is in the Inbox";
    const std::string inbox = listed(test, 0);
    expect(test, inbox, "uid = 4 : ");
    expect(test, inbox, "folder = 0 : ");
    expect(test, listed(test, 1), "items = vec {}");
    expect(test, fox(test), "unseen = 4 : ");
  }
  {
    const std::string test = "the Inbox's list reads its index alone";
    // Without it, the list reads every newer message in Trash and Spam
    db::Stmt plan(
        store::mailbox_file(std::stoll(fox_id())),
        (std::string("EXPLAIN QUERY PLAN ") + store::k_list_inbox).c_str());
    std::string steps;
    while (plan && plan.row())
      steps += plan.column_text(3) + "\n";
    expect(test, steps, "USING INDEX messages_inbox ");
  }
  {
    const std::string test = "the list gives each message's From address";
    // Seeded mail is not parsed: here as mail parsed before the column was
    // added has it, in its sender text only, and as the parse stores it
    CALL(test, dev_file_exec,
         "(\"fox\", \"UPDATE messages SET sender = CASE uid "
         "WHEN 1 THEN 'Fox <Fox@den.example>' WHEN 2 THEN 'Fox <>' "
         "WHEN 3 THEN 'cub@den.example' ELSE 'Vixen <vixen@den.example>' END, "
         "sender_address = CASE uid WHEN 4 THEN 'no-at-sign' ELSE '' END\")",
         CONTROLLER);
    const auto address = [&](int uid) {
      return CALL(test, mail_get, "(\"fox\", " + std::to_string(uid) + ")",
                  USER_A);
    };
    expect(test, address(1), "sender_address = \"Fox@den.example\"");
    expect(test, address(2), "sender_address = \"\"");
    expect(test, address(3), "sender_address = \"cub@den.example\"");
    // The stored one counts, and one mail_block refuses is not given
    expect(test, address(4), "sender_address = \"\"");
    expect(test, listed(test, 0), "sender_address = \"cub@den.example\"");
  }
  {
    const std::string test = "a move to Trash takes unread mail off the count";
    expect_equal(test, move(test, "vec { 1; 2; 99 }", 1),
                 "(2 : nat64, vec { 1 : nat64; 2 : nat64 }, vec {})");
    const std::string trash = listed(test, 1);
    expect(test, trash, "uid = 2 : ");
    expect(test, trash, "folder = 1 : ");
    expect_not(test, listed(test, 0), "uid = 2 : ");
    expect(test, fox(test), "unseen = 2 : ");
    expect(test, fox(test), "message_count = 4 : ");
    // Already there: nothing moves
    expect_equal(test, move(test, "vec { 1 }", 1),
                 "(0 : nat64, vec {}, vec {})");
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
    expect_equal(test, move(test, "vec { 1; 2 }", 0),
                 "(2 : nat64, vec { 1 : nat64; 2 : nat64 }, vec {})");
    expect(test, fox(test), "unseen = 3 : ");
    expect(test, listed(test, 1), "items = vec {}");
  }
  {
    const std::string test = "Spam keeps unread mail off the count too";
    expect_equal(test, move(test, "vec { 3 }", 2),
                 "(1 : nat64, vec { 3 : nat64 }, vec {})");
    expect(test, fox(test), "unseen = 2 : ");
    expect(test, listed(test, 2), "uid = 3 : ");
    // From Spam to Trash, still off the count
    expect_equal(test, move(test, "vec { 3 }", 1),
                 "(1 : nat64, vec { 3 : nat64 }, vec {})");
    expect(test, fox(test), "unseen = 2 : ");
    expect(test, CALL(test, admin_check, "(\"fox\", null)", CONTROLLER),
           "result = \"ok\"");
  }
  {
    const std::string test = "a delete in Trash leaves the count alone";
    expect(test, CALL(test, mail_delete, "(\"fox\", vec { 3 }, 1)", USER_A),
           "(1 : nat64)");
    expect(test, fox(test), "unseen = 2 : ");
    expect(test, fox(test), "message_count = 3 : ");
    expect(test, CALL(test, admin_check, "(\"fox\", null)", CONTROLLER),
           "result = \"ok\"");
  }
  {
    const std::string test = "a delete leaves mail that is in another folder";
    // uid 4 is in the Inbox, as when another member restored it meanwhile
    expect(test, CALL(test, mail_delete, "(\"fox\", vec { 4 }, 1)", USER_A),
           "(0 : nat64)");
    expect(test, fox(test), "message_count = 3 : ");
    expect(test, listed(test, 0), "uid = 4 : ");
  }
  TRAPS("a delete names a folder there is", mail_delete,
        "(\"fox\", vec { 4 }, 3)", USER_A, "no such folder");
  TRAPS("a list names a folder there is", mail_list,
        in("fox", list_args("50", 3)), USER_A, "no such folder");
  TRAPS("a move names a folder there is", mail_move, "(\"fox\", vec { 1 }, 3)",
        USER_A, "no such folder");
  TRAPS("201 messages are too many to move at once", mail_move,
        "(\"fox\", " + uid_vec(1, 201) + ", 1)", USER_A,
        "too many messages at once");
  TRAPS("201 messages are too many to flag at once", mail_set_flags,
        "(\"fox\", " + uid_vec(1, 201) + ", 2, 0)", USER_A,
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
  TRAPS("only the canister cleans a mailbox", ingest_clean, "(1)", CONTROLLER,
        "only this canister can call this method");
  {
    const std::string test = "Trash empties itself after 30 days, 20 per turn";
    expect(test, move(test, uid_vec(5, 25), 1), "(25 : nat64, ");
    expect(test, fox(test), "message_count = 28 : ");
    later_by_days(29);
    // Nothing has expired: a move costs the pump no turn
    expect_equal(test, move(test, "vec {}", 1), "(0 : nat64, vec {}, vec {})");
    check(test, !clean_due(), "a move marked a mailbox with nothing expired");
    clean(test);
    expect(test, fox(test), "message_count = 28 : ");
    later_by_days(2);
    // A move leaves the deleting to the pump
    expect_equal(test, move(test, "vec {}", 1), "(0 : nat64, vec {}, vec {})");
    expect(test, fox(test), "message_count = 28 : ");
    check(test, clean_due(), "a move did not mark the expired mail");
    clean(test);
    expect(test, fox(test), "message_count = 8 : ");
    check(test, clean_due(), "a cleanup that found 20 ended the mark");
    clean(test);
    expect(test, fox(test), "message_count = 3 : ");
    check(test, !clean_due(), "the last cleanup kept the mark");
    expect(test, listed(test, 1), "items = vec {}");
    expect(test, CALL(test, admin_check, "(\"fox\", null)", CONTROLLER),
           "result = \"ok\"");
  }
  {
    const std::string test = "mail past its 30 days is restored, not deleted";
    arrived(test, "1, 2", 0);
    expect_equal(test, move(test, "vec { 1 }", 1),
                 "(1 : nat64, vec { 1 : nat64 }, vec {})");
    expect_equal(test, move(test, "vec { 2 }", 2),
                 "(1 : nat64, vec { 2 : nat64 }, vec {})");
    later_by_days(31);
    // Restore, and Not spam, before the pump reached them
    expect_equal(test, move(test, "vec { 1 }", 0),
                 "(1 : nat64, vec { 1 : nat64 }, vec {})");
    expect_equal(test, move(test, "vec { 2 }", 0),
                 "(1 : nat64, vec { 2 : nat64 }, vec {})");
    clean(test);
    expect(test, fox(test), "message_count = 3 : ");
    const std::string inbox = listed(test, 0);
    expect(test, inbox, "uid = 1 : ");
    expect(test, inbox, "uid = 2 : ");
  }

  CALL("seed fox's mailbox for Spam", dev_seed, "(\"fox\", 30, 4)", CONTROLLER);
  {
    const std::string test = "Spam's 30 days count from the mail's arrival";
    arrived(test, "30", 25);
    expect_equal(test, move(test, "vec { 30 }", 2),
                 "(1 : nat64, vec { 30 : nat64 }, vec {})");
    later_by_days(4);
    clean(test);
    expect(test, listed(test, 2), "uid = 30 : ");
    later_by_days(2);
    clean(test);
    expect_not(test, listed(test, 2), "uid = 30 : ");
    expect(test, fox(test), "message_count = 6 : ");
  }
  {
    const std::string test = "a move from Spam to Trash keeps Spam's time";
    arrived(test, "31", 25);
    expect_equal(test, move(test, "vec { 31 }", 2),
                 "(1 : nat64, vec { 31 : nat64 }, vec {})");
    // Past 30 days since it arrived by now: only a move into Spam deletes
    arrived(test, "31", 31);
    expect_equal(test, move(test, "vec { 31 }", 1),
                 "(1 : nat64, vec { 31 : nat64 }, vec {})");
    later_by_days(6);
    clean(test);
    expect_not(test, listed(test, 1), "uid = 31 : ");
    expect(test, fox(test), "message_count = 5 : ");
  }
  {
    const std::string test = "mail marked as Spam 30 days after it arrived is "
                             "deleted, does not count as moved, and the reply "
                             "says which";
    arrived(test, "32", 31);
    arrived(test, "33", 0);
    const std::string unseen = field(fox(test), "unseen");
    // 33 named twice is in Spam the second time; 999 is not there. A client
    // compares no clocks to know what it may undo.
    expect_equal(test, move(test, "vec { 32; 33; 33; 32; 999 }", 2),
                 "(1 : nat64, vec { 33 : nat64 }, vec { 32 : nat64 })");
    expect_equal(test, move(test, "vec { 32; 33 }", 2),
                 "(0 : nat64, vec {}, vec {})");
    const std::string spam = listed(test, 2);
    expect(test, spam, "uid = 33 : ");
    expect_not(test, spam, "uid = 32 : ");
    expect(test, fox(test), "message_count = 4 : ");
    expect_equal(test, field(fox(test), "unseen"),
                 std::to_string(std::stoll(unseen) - 2));
    expect(test, CALL(test, admin_check, "(\"fox\", null)", CONTROLLER),
           "result = \"ok\"");
  }
  {
    const std::string test = "mail from a blocked envelope sender keeps its "
                             "arrival as Spam's time";
    CALL(test, mail_block, "(\"fox\", \"late@sender.example\")", USER_A);
    const std::string row = queue_mail(test, "late");
    later_by_days(10); // the move comes 10 days after the arrival
    CALL(test, ingest_move, "(" + row + ")", SELF);
    expect(test, listed(test, 2), "envelope_from = \"late@sender.example\"");
    later_by_days(21);
    clean(test);
    expect_not(test, listed(test, 2), "late@sender.example");
    CALL(test, mail_unblock, "(\"fox\", \"late@sender.example\")", USER_A);
  }
  {
    const std::string test = "mail that cannot be deleted stops its cleanup "
                             "only";
    arrived(test, "4", 0);
    expect_equal(test, move(test, "vec { 4 }", 1),
                 "(1 : nat64, vec { 4 : nat64 }, vec {})");
    later_by_days(31);
    CALL(test, dev_file_exec,
         "(\"fox\", \"CREATE TRIGGER damaged BEFORE DELETE ON messages WHEN "
         "old.uid = 4 BEGIN SELECT RAISE(ABORT, 'damaged'); END\")",
         CONTROLLER);
    TRAPS(test, ingest_clean, "(" + fox_id() + ")", SELF,
          "the expired mail could not be deleted");
    // Delivery and moves go on
    CALL(test, ingest_move, "(" + queue_mail(test, "prompt") + ")", SELF);
    expect(test, listed(test, 0), "envelope_from = \"prompt@sender.example\"");
    expect_equal(test, move(test, "vec { 1 }", 1),
                 "(1 : nat64, vec { 1 : nat64 }, vec {})");
    CALL(test, dev_file_exec, "(\"fox\", \"DROP TRIGGER damaged\")",
         CONTROLLER);
    clean(test);
    expect_not(test, listed(test, 1), "uid = 4 : ");
    expect(test, listed(test, 1), "uid = 1 : ");
    expect(test, CALL(test, admin_check, "(\"fox\", null)", CONTROLLER),
           "result = \"ok\"");
  }
  {
    const std::string test = "mail from a blocked From address parsed 30 days "
                             "after it arrived is deleted, not quarantined";
    CALL(test, ingest_move, "(" + queue_mail(test, "stale") + ")", SELF);
    // Blocked before the parse, which files it by its From address
    CALL(test, mail_block, "(\"fox\", \"stale@sender.example\")", USER_A);
    const std::string id =
        std::to_string(fox_integer("SELECT max(id) FROM messages"));
    later_by_days(31); // as when the parse waited for a repair
    CALL(test, ingest_process, "(" + fox_id() + ", " + id + ")", SELF);
    check(test,
          fox_integer("SELECT count(*) FROM messages WHERE id = " + id) == 0,
          "the message was not deleted");
    check(test,
          control_integer(
              "SELECT quarantined FROM mailboxes WHERE local = 'fox'") == 0,
          "the message was quarantined");
    expect(test, CALL(test, admin_check, "(\"fox\", null)", CONTROLLER),
           "result = \"ok\"");
    CALL(test, mail_unblock, "(\"fox\", \"stale@sender.example\")", USER_A);
  }
  {
    const std::string test = "the parse leaves mail from a blocked From "
                             "address that a member put in the Inbox";
    CALL(test, mail_block, "(\"fox\", \"heron@sender.example\")", USER_A);
    // Its envelope sender is blocked too, so delivery files it in Spam
    CALL(test, ingest_move, "(" + queue_mail(test, "heron") + ")", SELF);
    const std::string id =
        std::to_string(fox_integer("SELECT max(id) FROM messages"));
    const std::string uid = std::to_string(
        fox_integer("SELECT uid FROM messages WHERE id = " + id));
    expect(test, listed(test, 2), "uid = " + uid + " : ");
    // Not spam, before the parse
    expect_equal(test, move(test, "vec { " + uid + " }", 0),
                 "(1 : nat64, vec { " + uid + " : nat64 }, vec {})");
    CALL(test, ingest_process, "(" + fox_id() + ", " + id + ")", SELF);
    check(test,
          fox_integer("SELECT folder FROM messages WHERE state = 1 AND id = " +
                      id) == 0,
          "the parse filed it in Spam again");
    expect(test, CALL(test, admin_check, "(\"fox\", null)", CONTROLLER),
           "result = \"ok\"");
    CALL(test, mail_unblock, "(\"fox\", \"heron@sender.example\")", USER_A);
  }
  {
    const std::string test = "a cleanup takes turns with mail to be parsed";
    CALL(test, dev_file_exec,
         "(\"fox\", \"UPDATE messages SET folder_ns = 1 WHERE uid = 1\")",
         CONTROLLER);
    // The move marks the mailbox: uid 1 has been in Trash too long
    CALL(test, ingest_move, "(" + queue_mail(test, "wren") + ")", SELF);
    check(test, clean_due(), "new mail did not mark the expired mail");
    // Parses go before moves, so each turn without the cleanup parses one
    const std::string unparsed = "SELECT sum(unparsed) FROM mailboxes";
    const int64_t before = control_integer(unparsed);
    check(test, before >= 2, "too little to parse");
    pump(test);
    pump(test);
    expect_not(test, listed(test, 1), "uid = 1 : ");
    check(test, control_integer(unparsed) == before - 1,
          "the parses did not take the other turn");
  }
  {
    const std::string test = "a mark made while a cleanup fails stays";
    // Something to parse for the turns between the cleanups
    CALL(test, ingest_move, "(" + queue_mail(test, "rook") + ")", SELF);
    expect_equal(test, move(test, "vec { 2 }", 1),
                 "(1 : nat64, vec { 2 : nat64 }, vec {})");
    CALL(test, dev_file_exec,
         "(\"fox\", \"UPDATE messages SET folder_ns = 1 WHERE uid = 2; "
         "CREATE TRIGGER damaged BEFORE DELETE ON messages WHEN old.uid = 2 "
         "BEGIN SELECT RAISE(ABORT, 'damaged'); END\")",
         CONTROLLER);
    expect_equal(test, move(test, "vec {}", 1), "(0 : nat64, vec {}, vec {})");
    check(test, clean_due(), "a move did not mark the expired mail");
    mock_ic.register_method("ingest_clean", ingest_clean_after_a_mark);
    for (int turn = 0; turn < 3 && !g_marked_meanwhile; ++turn)
      pump(test);
    mock_ic.register_method("ingest_clean", ingest_clean);
    check(test, g_marked_meanwhile, "the pump did not clean");
    check(test, clean_due(), "the failed cleanup cleared a later mark");
    // Without a mark meanwhile, a failed cleanup waits for the next one
    for (int turn = 0; turn < 3 && clean_due(); ++turn)
      pump(test);
    check(test, !clean_due(), "a failed cleanup kept its mark");
    expect(test, listed(test, 1), "uid = 2 : ");
    CALL(test, dev_file_exec, "(\"fox\", \"DROP TRIGGER damaged\")",
         CONTROLLER);
    clean(test);
    expect_not(test, listed(test, 1), "uid = 2 : ");
  }

  add_mailbox("vixen's mailbox", USER_A, "vixen");
  const int64_t vixen =
      control_integer("SELECT id FROM mailboxes WHERE local = 'vixen'");
  {
    const std::string test = "a deferred cleanup wakes the pump when its wait "
                             "ends";
    // vixen has nothing to move or parse, only the mark of a 452
    store::clean_soon(vixen);
    const auto now = static_cast<int64_t>(IC_API::time());
    const std::string retry =
        "UPDATE mailboxes SET retry_after_ns = " + std::to_string(now + 1) +
        " WHERE local = 'vixen'";
    check(test, db::exec(db::control(), retry.c_str()), "cannot defer vixen");
    int64_t at = 0;
    check(test, store::deferred_until(now, at) && at == now + 1,
          "the deferred mark does not wake the pump");
    db::exec(db::control(),
             "UPDATE mailboxes SET retry_after_ns = 0, clean_due = 0 "
             "WHERE local = 'vixen'");
  }
  {
    const std::string test = "a mailbox with much expired mail takes turns "
                             "with the other mailboxes due";
    CALL(test, dev_seed, "(\"fox\", 100, 21)", CONTROLLER);
    const auto last =
        static_cast<int>(fox_integer("SELECT max(uid) FROM messages"));
    expect(test, move(test, uid_vec(last - 20, 21), 1), "(21 : nat64, ");
    CALL(test, dev_seed, "(\"vixen\", 1, 21)", CONTROLLER);
    expect(
        test,
        CALL(test, mail_move, "(\"vixen\", " + uid_vec(1, 21) + ", 1)", USER_A),
        "(21 : nat64, ");
    later_by_days(31);
    move(test, "vec {}", 1);
    CALL(test, mail_move, "(\"vixen\", vec {}, 1)", USER_A);
    const auto now = static_cast<int64_t>(IC_API::time());
    int64_t first = 0;
    int64_t second = 0;
    int64_t due = 0;
    check(test, store::claim_clean(now, 0, first, due) == store::Claim::Claimed,
          "no cleanup claimed");
    CALL(test, ingest_clean, "(" + std::to_string(first) + ")", SELF);
    check(test,
          store::claim_clean(now, 0, second, due) == store::Claim::Claimed,
          "no second cleanup claimed");
    check(test, second != first,
          "the mailbox cleaned last, still due, came first again");
  }
  {
    const std::string test = "upgrades and cleanups leave turns to the parses";
    // crew's and vixen's files wait for an upgrade, which holds each of them,
    // its file being ahead of its registry: one upgrade turn each
    const std::string current = std::to_string(db::mailbox_version());
    const std::string behind = "UPDATE mailboxes SET schema = " + current +
                               " - 1 WHERE local IN ('crew', 'vixen')";
    check(test, db::exec(db::control(), behind.c_str()), "cannot set schema");
    store::set_needs_repair(vixen, ""); // as a check that frees a file does
    check(test, store::upgrade_pending(), "no upgrade pending");
    // fox has a message to parse, and 21 expired: two cleanup turns
    CALL(test, ingest_move, "(" + queue_mail(test, "kite") + ")", SELF);
    check(test, clean_due(), "fox is not due for a cleanup");
    const std::string unparsed = "SELECT sum(unparsed) FROM mailboxes";
    const int64_t before = control_integer(unparsed);
    for (int turn = 0; turn < 4; ++turn)
      pump(test);
    check(test, control_integer(unparsed) < before, "no parse in four turns");
    const std::string restored =
        "UPDATE mailboxes SET schema = " + current +
        ", needs_repair = '', retry_after_ns = 0 WHERE local IN ('crew', "
        "'vixen')";
    check(test, db::exec(db::control(), restored.c_str()),
          "cannot restore crew and vixen");
    ic0mock_clear_time_override();
  }

  {
    const std::string test = "a blocked address is kept in lower case";
    expect(test,
           CALL(test, mail_block, "(\"fox\", \"Spammer@Example.COM\")", USER_A),
           "(true)");
    // Blocked already
    expect(test,
           CALL(test, mail_block, "(\"fox\", \"spammer@example.com\")", USER_A),
           "(false)");
    const std::string list = CALL(test, mail_blocked, "(\"fox\")", USER_A);
    expect(test, list, "address = \"spammer@example.com\"");
    expect(test, list, "blocked_by = principal \"" + USER_A + "\"");
    expect(test, list, "name = opt \"Alice A\"");
    check(test, count(list, "address = ") == 1, "not one address in: " + list);
  }
  for (const std::string &address : std::vector<std::string>{
           "", "nope", "@example.com", "spammer@", "a b@example.com",
           "a@b@example.com", "<a@example.com>",
           std::string(250, 'a') + "@x.io"}) {
    TRAPS("not an address: " + address.substr(0, 20), mail_block,
          "(\"fox\", \"" + address + "\")", USER_A, "not an email address");
  }
  TRAPS("only a member blocks", mail_block, "(\"fox\", \"x@example.com\")",
        USER_B, "no such mailbox for this principal");
  TRAPS("only a member reads the blocked list", mail_blocked, "(\"fox\")",
        USER_B, "no such mailbox for this principal");
  {
    const std::string test = "an unblocked address is off the list";
    expect(
        test,
        CALL(test, mail_unblock, "(\"fox\", \"SPAMMER@example.com\")", USER_A),
        "(true)");
    // Unblocked already: the write is rolled back, never committed
    db::fail_statements("UPDATE counters SET message_count");
    expect(
        test,
        CALL(test, mail_unblock, "(\"fox\", \"spammer@example.com\")", USER_A),
        "(false)");
    check(test, db::fail_statements("") == 0,
          "an unblock that changed nothing committed its write");
    expect(test, CALL(test, mail_blocked, "(\"fox\")", USER_A), "(vec {})");
  }
  {
    const std::string test = "at 1000 addresses a new block replaces the "
                             "oldest";
    CALL(test, dev_file_exec,
         "(\"fox\", \"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 "
         "FROM c WHERE x < 1000) INSERT INTO blocked SELECT 'a' || x || "
         "'@example.com', 'aaaaa-aa', x FROM c\")",
         CONTROLLER);
    // An address on it already is no change
    expect(test,
           CALL(test, mail_block, "(\"fox\", \"a7@example.com\")", USER_A),
           "(false)");
    expect(test,
           CALL(test, mail_block, "(\"fox\", \"more@example.com\")", USER_A),
           "(true)");
    const std::string list = CALL(test, mail_blocked, "(\"fox\")", USER_A);
    check(test, count(list, "address = ") == 1000, "not 1000 addresses");
    expect(test, list, "\"more@example.com\"");
    expect(test, list, "\"a2@example.com\"");
    expect_not(test, list, "\"a1@example.com\"");
  }
  {
    const std::string test = "a blocked list that cannot be read is not "
                             "answered";
    CALL(test, dev_file_exec,
         "(\"fox\", \"ALTER TABLE blocked RENAME TO kept\")", CONTROLLER);
    TRAPS("a blocked list with no table", mail_blocked, "(\"fox\")", USER_A,
          "the blocked list cannot be read");
    // One that fails after its first rows, as a damaged page would: the
    // index gives the rows in the list's order, newest first, with no sort,
    // so 999 come back before the oldest, a2, fails
    CALL(test, dev_file_exec,
         "(\"fox\", \"CREATE INDEX by_time ON kept(at_ns DESC, address); "
         "CREATE VIEW blocked AS SELECT address, CASE address WHEN "
         "'a2@example.com' THEN abs(-9223372036854775807 - 1) ELSE "
         "blocked_by END AS blocked_by, at_ns FROM kept\")",
         CONTROLLER);
    TRAPS("a blocked list that fails partway", mail_blocked, "(\"fox\")",
          USER_A, "the blocked list cannot be read");
    CALL(test, dev_file_exec,
         "(\"fox\", \"DROP VIEW blocked; DROP INDEX by_time; ALTER TABLE kept "
         "RENAME TO blocked\")",
         CONTROLLER);
    expect(test, CALL(test, mail_blocked, "(\"fox\")", USER_A),
           "\"more@example.com\"");
  }
}
