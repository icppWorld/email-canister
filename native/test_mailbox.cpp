// A mailbox's methods: who may call them, paging, search and delete

#include <string>

#include "api.h"
#include "support.h"

using namespace native;

namespace {

size_t count(const std::string &text, const std::string &part) {
  size_t n = 0;
  for (size_t at = text.find(part); at != std::string::npos;
       at = text.find(part, at + part.size())) {
    ++n;
  }
  return n;
}

std::string uids(int first, int count) {
  std::string out = "(vec {";
  for (int uid = first; uid < first + count; ++uid) {
    out += " " + std::to_string(uid) + ";";
  }
  return out + " })";
}

// Every method of a mailbox's members, with a valid argument after the mailbox
struct OwnerCall {
  Method fn;
  std::string method;
  std::string args;
};

const OwnerCall k_owner_calls[] = {
    {mail_list, "mail_list", "(record { cursor = null; limit = 10 })"},
    {mail_get, "mail_get", "(1)"},
    {mail_search, "mail_search",
     "(record { \"query\" = \"hello\"; cursor = null; limit = 10 })"},
    {mail_set_flags, "mail_set_flags", "(1, 1, 0)"},
    {mail_delete, "mail_delete", "(vec { 1 })"},
    {mail_send, "mail_send", Send{}.args()},
    {mail_outbox_list, "mail_outbox_list",
     "(record { cursor = null; limit = 10 })"},
    {mail_outbox_get, "mail_outbox_get", "(1)"},
    {mail_outbox_resend, "mail_outbox_resend", "(1)"},
    {mail_outbox_delete, "mail_outbox_delete", "(1)"},
    {mail_export_freeze, "mail_export_freeze", "(null)"},
    {mail_export_thaw, "mail_export_thaw", "(1)"},
    {mail_export_chunk, "mail_export_chunk",
     "(record { offset = 0; length = 10 })"},
};

// Bob's mailbox refuses `caller` as it refuses an address that does not
// exist, and mail_me lists no mailbox for them
void no_mailbox(const std::string &who, const std::string &caller) {
  for (const OwnerCall &c : k_owner_calls) {
    traps(c.method + " refuses " + who, c.fn, c.method, in("bob", c.args),
          caller, "no such mailbox for this principal");
  }
  const std::string test = "mail_me answers " + who;
  const std::string me = CALL(test, mail_me, "()", caller);
  expect(test, me, "\"principal\" = principal \"" + caller + "\"");
  expect_not(test, me, "local = \"bob\"");
}

// The caller's MailboxInfo of `local`
std::string me_of(const std::string &test, const std::string &caller,
                  const std::string &local) {
  const std::string me = CALL(test, mail_me, "()", caller);
  const size_t at = me.find("local = \"" + local + "\"");
  check(test, at != std::string::npos, "no " + local + " in: " + me);
  // Its whole record: didc orders the fields by their hashes
  const size_t start = me.rfind("record {", at);
  return me.substr(start, me.find('}', at) - start);
}

} // namespace

void test_mailbox(MockIC &) {
  no_mailbox("anonymous", ANONYMOUS);
  // Alike: another mailbox's member, and an address that does not exist
  for (const OwnerCall &c : k_owner_calls) {
    traps(c.method + " refuses another mailbox's member", c.fn, c.method,
          in("bob", c.args), USER_A, "no such mailbox for this principal");
    traps(c.method + " refuses an address that does not exist", c.fn, c.method,
          in("nobody", c.args), USER_B, "no such mailbox for this principal");
  }

  {
    const std::string test = "a disabled owner";
    CALL(test, admin_set_disabled, "(\"bob\", true)", CONTROLLER);
    no_mailbox("a disabled owner", USER_B);
    CALL(test, admin_set_disabled, "(\"bob\", false)", CONTROLLER);
    expect(test, CALL(test, mail_me, "()", USER_B),
           "address = \"bob@mail.example\"");
  }

  CALL("seed alice's mailbox", dev_seed, "(\"alice\", 1, 150)", CONTROLLER);
  for (const std::string &limit : {"0", "100", "1000"}) {
    const std::string test = "a page with limit " + limit + " has 100 items";
    const std::string page =
        CALL(test, mail_list,
             in("alice", "(record { cursor = null; limit = " + limit + " })"),
             USER_A);
    check(test, count(page, "uid = ") == 100, "not 100 items in: " + page);
    expect(test, page, "cursor = opt");
  }
  {
    const std::string test = "the last page has no cursor";
    const std::string page =
        CALL(test, mail_list,
             in("alice", "(record { cursor = null; limit = 100 })"), USER_A);
    const std::string cursor = field(page, "cursor");
    const std::string last = CALL(
        test, mail_list,
        in("alice", "(record { cursor = opt " + cursor + "; limit = 100 })"),
        USER_A);
    check(test, count(last, "uid = ") == 50, "not 50 items in: " + last);
    expect(test, last, "cursor = null");
  }

  {
    const std::string test = "an empty search finds nothing";
    const std::string page = CALL(
        test, mail_search,
        in("alice", "(record { \"query\" = \"\"; cursor = null; limit = 10 })"),
        USER_A);
    expect(test, page, "items = vec {}");
    expect(test, page, "cursor = null");
  }
  {
    // Past 16 words and 512 bytes, the rest of a query is left out
    const std::string test = "a long search is cut, not refused";
    std::string words;
    for (int i = 0; i < 40; ++i)
      words += "word" + std::to_string(i) + " ";
    words += std::string(600, 'x');
    expect(test,
           CALL(test, mail_search,
                in("alice", "(record { \"query\" = \"" + words +
                                "\"; cursor = null; limit = 10 })"),
                USER_A),
           "items = vec {}");
  }

  TRAPS("201 messages are too many to delete at once", mail_delete,
        in("alice", uids(1, 201)), USER_A, "too many messages at once");
  {
    const std::string test = "200 messages are deleted at once";
    expect(test, CALL(test, mail_delete, in("alice", uids(1, 200)), USER_A),
           "(150 : nat64)");
    expect(test, CALL(test, mail_me, "()", USER_A), "message_count = 0");
  }

  // The members of team share its read state; each opening is recorded once
  CALL("seed team's mailbox", dev_seed, "(\"team\", 1, 3)", CONTROLLER);
  {
    const std::string test = "a new message is unread for every member";
    expect(test, me_of(test, USER_A, "team"), "unseen = 3");
    expect(test, me_of(test, USER_B, "team"), "unseen = 3");
    expect(test, CALL(test, mail_get, "(\"team\", 1)", USER_A),
           "seen_by = vec {}");
  }
  {
    const std::string test = "opening a message reads it for all";
    CALL(test, mail_set_flags, "(\"team\", 1, 1, 0)", USER_A);
    expect(test, me_of(test, USER_B, "team"), "unseen = 2");
    const std::string got = CALL(test, mail_get, "(\"team\", 1)", USER_B);
    expect(test, got, "\"principal\" = principal \"" + USER_A + "\"");
    expect(test, got, "name = opt \"Alice A\"");
    expect_not(test, got, USER_B);
  }
  {
    const std::string test = "each member is recorded once, at their first";
    const std::string first =
        field(CALL(test, mail_get, "(\"team\", 1)", USER_A), "at_ns");
    CALL(test, mail_set_flags, "(\"team\", 1, 1, 0)", USER_A);
    CALL(test, mail_set_flags, "(\"team\", 1, 1, 0)", USER_B);
    const std::string got = CALL(test, mail_get, "(\"team\", 1)", USER_A);
    expect_equal(test, std::to_string(count(got, "at_ns = ")), "2");
    expect_equal(test, field(got, "at_ns"), first);
    expect(test, me_of(test, USER_A, "team"), "unseen = 2");
  }
  {
    const std::string test = "unread again, for every member";
    CALL(test, mail_set_flags, "(\"team\", 1, 0, 1)", USER_B);
    expect(test, me_of(test, USER_A, "team"), "unseen = 3");
    // Who opened it stays known
    expect(test, CALL(test, mail_get, "(\"team\", 1)", USER_A),
           "\"principal\" = principal \"" + USER_B + "\"");
  }
  TRAPS("an unknown message is not marked", mail_set_flags,
        "(\"team\", 99, 1, 0)", USER_A, "no such message");
  TRAPS("a flag is not both set and cleared", mail_set_flags,
        "(\"team\", 2, 1, 1)", USER_A, "a flag both set and cleared");
  {
    const std::string test = "a refused call records no opening";
    expect(test, CALL(test, mail_get, "(\"team\", 2)", USER_A),
           "seen_by = vec {}");
  }
  {
    // Local parts are stored in lower case, as the admin calls take them
    const std::string test = "a mailbox is named in any case";
    expect(test,
           CALL(test, mail_list,
                in("TeAm", "(record { cursor = null; limit = 1 })"), USER_A),
           "uid = ");
  }
  {
    // Each member sends only the flags they change, so neither undoes the other
    const std::string test = "two members' flag changes are both kept";
    CALL(test, mail_set_flags, "(\"team\", 3, 2, 0)", USER_A);
    CALL(test, mail_set_flags, "(\"team\", 3, 1, 0)", USER_B);
    const std::string page =
        CALL(test, mail_list,
             in("team", "(record { cursor = null; limit = 1 })"), USER_A);
    expect(test, page, "uid = 3");
    expect(test, page, "flags = 3");
    CALL(test, mail_set_flags, "(\"team\", 3, 0, 1)", USER_A);
    expect(test,
           CALL(test, mail_list,
                in("team", "(record { cursor = null; limit = 1 })"), USER_B),
           "flags = 2");
  }
  {
    const std::string test = "a deleted message takes its record with it";
    CALL(test, mail_set_flags, "(\"team\", 2, 1, 0)", USER_A);
    CALL(test, mail_delete, "(\"team\", vec { 1; 2 })", USER_B);
    expect(test, me_of(test, USER_A, "team"), "unseen = 1");
    expect(test,
           CALL(test, admin_check, "(\"team\", opt \"seen_by\")", CONTROLLER),
           "result = \"ok\"");
    // No row left for them, though uid 1 was opened by both: abs() overflows, and
    // fails the call, only while a row is left
    CALL(test, dev_file_exec,
         "(\"team\", \"SELECT abs(-9223372036854775807 - min(1, (SELECT "
         "count(*) FROM seen_by WHERE uid IN (1, 2))))\")",
         CONTROLLER);
    // The unread count the registry keeps is the file's
    expect(test, CALL(test, admin_check, "(\"team\", null)", CONTROLLER),
           "result = \"ok\"");
  }
}
