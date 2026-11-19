// smtp_request and smtp_request_validate: who may call them, and what they
// refuse before any mail is stored

#include <string>

#include "api.h"
#include "db.h"
#include "ic_api.h"
#include "ingest.h"
#include "mail_store.h"
#include "queue_store.h"
#include "support.h"

using namespace native;

namespace {

std::string address(const std::string &user, const std::string &domain) {
  return "record { user = \"" + user + "\"; domain = \"" + domain + "\" }";
}

std::string to_alice() { return address("alice", "mail.example"); }

std::string header(const std::string &name, const std::string &value) {
  return "record { name = \"" + name + "\"; value = \"" + value + "\" }";
}

// An SmtpRequest from sender@sender.example. Each part is Candid text; an
// empty one leaves its field out (null).
std::string request(const std::string &to,
                    const std::string &headers = header("Subject", "hi"),
                    const std::string &message_id = "\"<1@sender.example>\"",
                    bool has_envelope = true, bool has_message = true) {
  const std::string envelope =
      has_envelope
          ? "opt record { from = " + address("sender", "sender.example") +
                "; to = vec { " + to + " } }"
          : "null";
  const std::string message = has_message
                                  ? "opt record { headers = vec { " + headers +
                                        " }; body = blob \"hello\" }"
                                  : "null";
  return "(record { envelope = " + envelope + "; message = " + message +
         "; gateway_flags = null; message_id = " +
         (message_id.empty() ? "null" : "opt " + message_id) + " })";
}

// One integer from control.db, or -1
int64_t control_integer(const std::string &sql) {
  db::Stmt select(db::control(), sql.c_str());
  return select && select.row() ? select.column_integer(0) : -1;
}

std::string repeat(const std::string &item, int count) {
  std::string out;
  for (int i = 0; i < count; ++i)
    out += item + "; ";
  return out;
}

// Calls both methods with the same request and expects the same refusal
void both_refuse(const std::string &test, const std::string &args,
                 const std::string &caller, const std::string &code) {
  expect(test, CALL(test, smtp_request_validate, args, caller), code);
  expect(test, CALL(test, smtp_request, args, caller), code);
}

} // namespace

void test_smtp(MockIC &) {
  // Only the gateway or a controller may deliver: a user, or the bridge the
  // canister sends through, is refused
  both_refuse("a user may not deliver mail", request(to_alice()), USER_A,
              "code = 530");
  both_refuse("the bridge may not deliver mail", request(to_alice()), USER_C,
              "code = 530");
  both_refuse("anonymous may not deliver mail", request(to_alice()), ANONYMOUS,
              "code = 530");

  // The domains served: the custom one in any case, and the canister's own
  for (const std::string &domain :
       {std::string("mail.example"), std::string("MAIL.Example"),
        SELF + ".icp0.io", SELF + ".ICP0.IO"}) {
    const std::string test = "validate accepts alice@" + domain;
    expect(test,
           CALL(test, smtp_request_validate, request(address("alice", domain)),
                CONTROLLER),
           "variant { Ok");
  }
  {
    const std::string test = "validate refuses another domain";
    expect(test,
           CALL(test, smtp_request_validate,
                request(address("alice", "other.example")), CONTROLLER),
           "code = 550");
  }
  {
    // A local part over 64 characters is never a mailbox
    const std::string test = "validate refuses a 65-character local part";
    expect(test,
           CALL(test, smtp_request_validate,
                request(address(std::string(65, 'a'), "mail.example")),
                CONTROLLER),
           "code = 550");
  }
  {
    const std::string test = "validate needs exactly one recipient";
    expect(test,
           CALL(test, smtp_request_validate,
                request(to_alice() + "; " + address("bob", "mail.example")),
                CONTROLLER),
           "code = 501");
    expect(test,
           CALL(test, smtp_request_validate,
                request("", header("Subject", "hi"), "\"<1@x>\""), CONTROLLER),
           "code = 501");
  }

  // A request that is not one, or misses a field, bounces
  {
    const std::string test = "a request of the wrong type is malformed";
    expect(test, CALL(test, smtp_request, "(\"hello\")", CONTROLLER, true),
           "code = 451");
    expect(test,
           CALL(test, smtp_request_validate, "(\"hello\")", CONTROLLER, true),
           "code = 451");
  }
  {
    const std::string test = "a request misses a field";
    for (const std::string &args :
         {request(to_alice(), header("Subject", "hi"), "\"<1@x>\"", false),
          request(to_alice(), header("Subject", "hi"), "\"<1@x>\"", true,
                  false),
          request(to_alice(), header("Subject", "hi"), ""), request("")}) {
      expect(test, CALL(test, smtp_request, args, CONTROLLER), "code = 501");
    }
  }

  // The limits on a message's shape
  {
    const std::string test = "more than 10 recipients is too large";
    expect(
        test,
        CALL(test, smtp_request, request(repeat(to_alice(), 11)), CONTROLLER),
        "code = 552");
  }
  {
    const std::string test = "more than 100 headers is too large";
    expect(test,
           CALL(test, smtp_request,
                request(to_alice(), repeat(header("X-A", "b"), 101)),
                CONTROLLER),
           "code = 552");
  }
  {
    const std::string test = "a header value over 8 KiB is too large";
    expect(test,
           CALL(test, smtp_request,
                request(to_alice(), header("X-A", std::string(8193, 'v'))),
                CONTROLLER),
           "code = 552");
  }
  {
    const std::string test = "10 recipients and 100 headers of 8 KiB fit";
    expect(test,
           CALL(test, smtp_request,
                request(repeat(to_alice(), 10),
                        repeat(header("X-A", std::string(8192, 'v')), 100)),
                CONTROLLER),
           "variant { Ok");
  }
  {
    // The gateway validates each recipient on its own, so a full mailbox
    // defers only its own recipient. Natively nothing drains the queue.
    const std::string test = "validate defers a recipient whose queue is full";
    expect(test,
           CALL(test, smtp_request,
                request(to_alice(), header("Subject", "full"), "\"<3@x>\""),
                CONTROLLER),
           "variant { Ok");
    CALL(test, dev_set_backlog_cap, "(1 : nat64, 1000 : nat64)", CONTROLLER);
    expect(test,
           CALL(test, smtp_request_validate, request(to_alice()), CONTROLLER),
           "code = 451");
    expect(test,
           CALL(test, smtp_request_validate,
                request(address("bob", "mail.example")), CONTROLLER),
           "variant { Ok");
    // A full backlog defers every recipient
    CALL(test, dev_set_backlog_cap, "(100 : nat64, 1 : nat64)", CONTROLLER);
    expect(test,
           CALL(test, smtp_request_validate,
                request(address("bob", "mail.example")), CONTROLLER),
           "code = 451");
    CALL(test, dev_set_backlog_cap, "(100 : nat64, 1000 : nat64)", CONTROLLER);
  }
  {
    const std::string test = "mail for the canister's own domain is accepted";
    expect(test,
           CALL(test, smtp_request,
                request(address("ALICE", SELF + ".icp0.io"),
                        header("Subject", "own domain"), "\"<2@x>\""),
                CONTROLLER),
           "variant { Ok");
  }
  {
    // A call to the canister itself that the IC never ran is no attempt, so a
    // transient refusal cannot quarantine good mail
    const std::string test = "a move or parse that never ran keeps its attempt";
    IC_CallError unsent;
    unsent.kind = IC_CallError::Kind::CallPerformFailed;
    IC_CallError transient;
    transient.reject_code = IC_RejectCode::SysTransient;
    IC_CallError trapped;
    trapped.reject_code = IC_RejectCode::CanisterError;
    check(test,
          !ingest::may_have_run(unsent, true) &&
              !ingest::may_have_run(transient, true) &&
              ingest::may_have_run(trapped, true),
          "a call that never ran counts as an attempt");
    // A stopping canister refuses its calls to itself as if they trapped
    check(test, !ingest::may_have_run(trapped, false),
          "a call refused while stopping counts as an attempt");

    // Natively nothing drains the queue: alice's mail waits there
    const auto now = static_cast<int64_t>(IC_API::time());
    int64_t row = 0;
    check(test, store::claim_move(3, now, 0, row) == store::Claim::Claimed,
          "no move claimed");
    const std::string attempts =
        "SELECT attempts FROM queue WHERE id = " + std::to_string(row);
    check(test, control_integer(attempts) == 1, "the claim was not counted");
    const std::string error_is = "SELECT last_error = 'trapped' FROM queue "
                                 "WHERE id = " +
                                 std::to_string(row);
    store::record_move_failure(row, "trapped", true);
    check(test, control_integer(attempts) == 1,
          "a move that ran lost its attempt");
    check(test, control_integer(error_is) == 1,
          "a move that ran did not record its error");
    int64_t again = 0;
    check(test, store::claim_move(3, now, 0, again) == store::Claim::Claimed,
          "no second move claimed");
    check(test, again == row, "another row was claimed");
    check(test, control_integer(attempts) == 2,
          "the second claim was not counted");
    store::record_move_failure(row, "never ran", false);
    check(test, control_integer(attempts) == 1, "a move that never ran counts");
    check(test, control_integer(error_is) == 1,
          "a move that never ran replaced the error");

    const int64_t alice =
        control_integer("SELECT id FROM mailboxes WHERE local = 'alice'");
    const std::string where =
        " FROM mailboxes WHERE id = " + std::to_string(alice);
    // alice's parse state, put back at the end
    int64_t parse_id = 0;
    int64_t parse_attempts_before = 0;
    std::string parse_error;
    {
      db::Stmt saved(
          db::control(),
          ("SELECT parse_id, parse_attempts, parse_error" + where).c_str());
      check(test, saved && saved.row(), "the parse state cannot be read");
      parse_id = saved.column_integer(0);
      parse_attempts_before = saved.column_integer(1);
      parse_error = saved.column_text(2);
    }
    const auto set_parse = [&](int64_t id, int64_t tries,
                               const std::string &error) {
      db::Stmt set(db::control(),
                   "UPDATE mailboxes SET parse_id = ?, parse_attempts = ?, "
                   "parse_error = ? WHERE id = ?");
      check(test,
            set && set.integer(1, id)
                       .integer(2, tries)
                       .text(3, error)
                       .integer(4, alice)
                       .done(),
            "the parse state cannot be set");
    };
    const std::string parse_attempts = "SELECT parse_attempts" + where;
    const auto parse_error_is = [&](const std::string &error) {
      return control_integer("SELECT parse_error = '" + error + "'" + where) ==
             1;
    };
    set_parse(5, 1, "claimed");
    // Only for the message claimed: another may be claimed since
    store::record_parse_failure(alice, 6, "stale", true);
    store::record_parse_failure(alice, 6, "stale", false);
    check(test,
          control_integer(parse_attempts) == 1 && parse_error_is("claimed"),
          "a stale failure changed the claimed message's parse state");
    // A call that never ran gives its attempt back and keeps the last error
    store::record_parse_failure(alice, 5, "never ran", false);
    check(test,
          control_integer(parse_attempts) == 0 && parse_error_is("claimed"),
          "a parse that never ran counts, or replaced the error");
    // One that ran keeps its attempt and records why it failed
    set_parse(5, 1, "claimed");
    store::record_parse_failure(alice, 5, "trapped", true);
    check(test,
          control_integer(parse_attempts) == 1 && parse_error_is("trapped"),
          "a parse that ran lost its attempt or its error");
    set_parse(parse_id, parse_attempts_before, parse_error);
    db::exec(db::control(),
             ("UPDATE queue SET attempts = 0 WHERE id = " + std::to_string(row))
                 .c_str());
  }
}
