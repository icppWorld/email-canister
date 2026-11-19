// Helpers for the native tests: a method is called with its argument as Candid
// text and gives its reply as Candid text, so a test reads like a replica
// test. didc encodes and decodes both with the test build's .did file.

#pragma once

#include <string>

#include "mock_ic.h"

namespace native {

const std::string CONTROLLER{MOCKIC_CONTROLLER};
const std::string SELF{MOCKIC_CANISTER_SELF};
const std::string ANONYMOUS = "2vxsx-fae";
const std::string USER_A =
    "fi5vb-dqbae-aqcai-baeaq-caiba-eaqca-ibaea-qcaib-aeaqc-aibae-aqe";
const std::string USER_B =
    "uduew-qycai-baeaq-caiba-eaqca-ibaea-qcaib-aeaqc-aibae-aqcai-bae";
const std::string USER_C =
    "n6e37-rydam-bqgay-dambq-gayda-mbqga-ydamb-qgayd-ambqg-aydam-bqe";

using Method = void (*)();

// Remembers the .did file, then moves to a new, empty working directory, where
// SQLite keeps control.db and the mailbox files
void setup(MockIC &mock_ic, const std::string &did);

// The reply of `method`, called by `caller`, as Candid text. `args` is Candid
// text, typed by the method's arguments; with `untyped`, by its values alone.
std::string call(const std::string &test, Method fn, const std::string &method,
                 const std::string &args, const std::string &caller,
                 bool untyped = false);

// Passes when the call traps with a message that contains `trap`
void traps(const std::string &test, Method fn, const std::string &method,
           const std::string &args, const std::string &caller,
           const std::string &trap);

// The number in `name = ` of a reply, or after `from`: its digits only, with
// no separators, opt or type. "" when there is none, as for a null opt.
std::string field(const std::string &reply, const std::string &name,
                  size_t from = 0);

// Ends the run, failed, unless `text` contains `part`
void expect(const std::string &test, const std::string &text,
            const std::string &part);

// Ends the run, failed, when `text` contains `part`
void expect_not(const std::string &test, const std::string &text,
                const std::string &part);

// Ends the run, failed, with `why`, unless `ok`
void check(const std::string &test, bool ok, const std::string &why);

// Ends the run, failed, unless `got` is `wanted`, exactly. An empty `wanted`
// fails too: a field missing on both sides proves nothing.
void expect_equal(const std::string &test, const std::string &got,
                  const std::string &wanted);

// Creates the mailbox `local`, as a controller, with `principal` as its one
// member. `quota` is Candid text.
void add_mailbox(const std::string &test, const std::string &principal,
                 const std::string &local, const std::string &quota = "null");

// A mailbox method's arguments: the mailbox, then `args`, Candid text in
// parentheses
inline std::string in(const std::string &local, const std::string &args) {
  return "(\"" + local + "\", " + args.substr(1);
}

// mail_send's argument. Each part is Candid text.
struct Send {
  std::string client_id = "c1";
  std::string to = "\"a@b.example\"";
  std::string cc;
  std::string bcc;
  std::string subject = "hi";
  std::string attachments;

  std::string args() const {
    return "(record { client_id = \"" + client_id + "\"; to = vec { " + to +
           " }; cc = vec { " + cc + " }; bcc = vec { " + bcc +
           " }; subject = \"" + subject +
           "\"; html_body = \"<p>b</p>\"; attachments = vec { " + attachments +
           " } })";
  }
};

} // namespace native

// call() and traps() with the method's name taken from the function, which
// the .did file types the argument and the reply by
#define CALL(test, method, ...) native::call(test, method, #method, __VA_ARGS__)
#define TRAPS(test, method, ...)                                               \
  native::traps(test, method, #method, __VA_ARGS__)

// The test groups, one per file
void test_smtp(MockIC &mock_ic);
void test_admin(MockIC &mock_ic);
void test_mailbox(MockIC &mock_ic);
void test_outbox(MockIC &mock_ic);
void test_export(MockIC &mock_ic);
void test_check(MockIC &mock_ic);
