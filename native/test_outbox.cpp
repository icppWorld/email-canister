// mail_send's checks, and the outbox's list and delete. No timer runs in the
// native tests, so a message stays queued.

#include <set>
#include <string>
#include <vector>

#include "api.h"
#include "support.h"

using namespace native;

namespace {

std::string attachment(const std::string &filename) {
  return "record { filename = \"" + filename + "\"; content = blob \"x\" }";
}

std::string used_bytes(const std::string &test) {
  return field(CALL(test, mail_me, "()", USER_B), "used_bytes");
}

// The ids in an outbox page, in order
std::vector<std::string> ids(const std::string &page) {
  std::vector<std::string> out;
  for (size_t at = page.find("id = "); at != std::string::npos;
       at = page.find("id = ", at + 5)) {
    if (at > 0 && page[at - 1] == '_') continue; // client_id
    out.push_back(field(page, "id", at));
  }
  return out;
}

} // namespace

void test_outbox(MockIC &) {
  const std::string quota = used_bytes("the quota before");
  struct Refused {
    std::string name;
    Send send;
    std::string trap;
  };
  std::vector<Refused> refused;
  Send s;
  s.client_id = "";
  refused.push_back({"an empty client_id", s, "invalid client_id"});
  s = Send{};
  s.client_id = std::string(65, 'c');
  refused.push_back({"a 65-character client_id", s, "invalid client_id"});
  s = Send{};
  s.cc = "\"not an address\"";
  refused.push_back({"an invalid cc", s, "invalid address: not an address"});
  s = Send{};
  s.bcc = "\"x@\"";
  refused.push_back({"an invalid bcc", s, "invalid address: x@"});
  s = Send{};
  s.subject = std::string(999, 's');
  refused.push_back({"a 999-character subject", s, "invalid subject"});
  s = Send{};
  for (int i = 0; i < 21; ++i) {
    s.attachments += attachment("f" + std::to_string(i)) + "; ";
  }
  refused.push_back({"21 attachments", s, "too many attachments"});
  for (const std::string &name : {std::string("a/b"), std::string("a\\\\b"),
                                  std::string(""), std::string(256, 'n')}) {
    s = Send{};
    s.attachments = attachment(name);
    refused.push_back({"an attachment named \"" + name.substr(0, 8) + "\"", s,
                       "invalid attachment name"});
  }
  for (const Refused &r : refused) {
    TRAPS("mail_send refuses " + r.name, mail_send, in("bob", r.send.args()),
          USER_B, r.trap);
  }
  {
    const std::string test = "a refused message uses no quota";
    expect_equal(test, used_bytes(test), quota);
  }
  {
    // The limits themselves are allowed
    const std::string test = "a message at every limit is queued";
    Send at_limits;
    at_limits.client_id = std::string(64, 'c');
    at_limits.subject = std::string(998, 's');
    for (int i = 0; i < 20; ++i) {
      at_limits.attachments += attachment(std::string(255, 'a' + i)) + "; ";
    }
    CALL(test, mail_send, in("bob", at_limits.args()), USER_B);
  }

  {
    const std::string test = "the outbox pages newest first";
    for (int i = 0; i < 4; ++i) {
      Send next;
      next.client_id = "page" + std::to_string(i);
      CALL(test, mail_send, in("bob", next.args()), USER_B);
    }
    std::vector<std::string> seen;
    std::string cursor = "null";
    for (int pages = 0; pages < 5; ++pages) {
      const std::string page = CALL(
          test, mail_outbox_list,
          in("bob", "(record { cursor = " + cursor + "; limit = 2 })"), USER_B);
      for (const std::string &id : ids(page))
        seen.push_back(id);
      if (field(page, "cursor").empty()) {
        expect(test, page, "cursor = null");
        break;
      }
      cursor = "opt " + field(page, "cursor");
    }
    check(test,
          seen.size() == 5 &&
              std::set<std::string>(seen.begin(), seen.end()).size() == 5,
          "not 5 different ids but " + std::to_string(seen.size()));
    for (size_t i = 1; i < seen.size(); ++i) {
      check(test, std::stoull(seen[i - 1]) > std::stoull(seen[i]),
            "ids not descending: " + seen[i - 1] + " then " + seen[i]);
    }
    const std::string all =
        CALL(test, mail_outbox_list,
             in("bob", "(record { cursor = null; limit = 0 })"), USER_B);
    check(test, ids(all).size() == 5, "not 5 items with limit 0: " + all);

    // Queued mail may be deleted, and gives its quota back; queued mail is
    // not resent
    TRAPS("queued mail is not resent", mail_outbox_resend,
          "(\"bob\", " + seen.front() + ")", USER_B,
          "only rejected or unknown mail can be resent");
    for (const std::string &id : seen) {
      CALL(test, mail_outbox_delete, "(\"bob\", " + id + ")", USER_B);
    }
    expect_equal(test, used_bytes(test), quota);
    expect(test,
           CALL(test, mail_outbox_list,
                in("bob", "(record { cursor = null; limit = 0 })"), USER_B),
           "items = vec {}");
  }
  {
    // In a shared mailbox every member sees who sent each message, by the
    // name an admin gave them where there is one
    const std::string test = "sent mail names its sender";
    const std::string sent =
        CALL(test, mail_send, in("team", Send{.client_id = "by-bob"}.args()),
             USER_B);
    const std::string by_bob = sent.substr(1, sent.find_first_of(" :)") - 1);
    const std::string got =
        CALL(test, mail_outbox_get, "(\"team\", " + by_bob + ")", USER_A);
    expect(test, got, "sent_by = principal \"" + USER_B + "\"");
    expect(test, got, "sent_by_name = null");
    CALL(test, mail_send, in("team", Send{.client_id = "by-alice"}.args()),
         USER_A);
    const std::string page =
        CALL(test, mail_outbox_list,
             in("team", "(record { cursor = null; limit = 0 })"), USER_B);
    expect(test, page, "sent_by = principal \"" + USER_A + "\"");
    expect(test, page, "sent_by_name = opt \"Alice A\"");
    for (const std::string &id : ids(page))
      CALL(test, mail_outbox_delete, "(\"team\", " + id + ")", USER_A);
  }
  {
    // A retry from another of the sender's mailboxes is refused: the first
    // try may have gone out from there, and a message cannot be recalled
    const std::string test = "a client_id is sent from one mailbox only";
    const Send retried{.client_id = "retried"};
    const std::string sent =
        CALL(test, mail_send, in("team", retried.args()), USER_B);
    TRAPS(test, mail_send, in("bob", retried.args()), USER_B,
          "already queued from team@");
    // The mailbox it went out from answers with that message, as before
    expect_equal(
        test, CALL(test, mail_send, in("team", retried.args()), USER_B), sent);
    // Another member's client_id is theirs alone, in a shared mailbox too
    const std::string by_alice =
        CALL(test, mail_send, in("team", retried.args()), USER_A);
    check(test, by_alice != sent, "alice got bob's message: " + by_alice);
    expect(test,
           CALL(test, mail_outbox_get,
                "(\"team\", " +
                    by_alice.substr(1, by_alice.find_first_of(" :)") - 1) + ")",
                USER_A),
           "sent_by = principal \"" + USER_A + "\"");
    for (const std::string &queued :
         ids(CALL(test, mail_outbox_list,
                  in("team", "(record { cursor = null; limit = 0 })"), USER_A)))
      CALL(test, mail_outbox_delete, "(\"team\", " + queued + ")", USER_A);
    // Deleted before any attempt it never left, so a retry may go anywhere
    const std::string again =
        CALL(test, mail_send, in("bob", retried.args()), USER_B);
    CALL(test, mail_outbox_delete,
         "(\"bob\", " + again.substr(1, again.find_first_of(" :)") - 1) + ")",
         USER_B);
  }
  {
    // The record does not depend on the mailbox it was sent from: one held
    // for repair, left or purged neither blocks other sends nor lets a retry
    // through
    const std::string test = "a client_id stays with its mailbox";
    add_mailbox(test, USER_B, "crew");
    const Send held{.client_id = "held"};
    CALL(test, mail_send, in("crew", held.args()), USER_B);
    CALL(test, dev_damage_file, "(\"crew\", \"outbox_bodies\")", CONTROLLER);
    expect_not(test, CALL(test, admin_check, "(\"crew\", null)", CONTROLLER),
               "result = \"ok\"");
    const std::string other = CALL(
        test, mail_send, in("bob", Send{.client_id = "other"}.args()), USER_B);
    TRAPS(test, mail_send, in("bob", held.args()), USER_B,
          "already queued from crew@");
    CALL(test, admin_remove_member, "(\"crew\", principal \"" + USER_B + "\")",
         CONTROLLER);
    TRAPS(test, mail_send, in("bob", held.args()), USER_B,
          "already queued from crew@");
    CALL(test, admin_set_disabled, "(\"crew\", true)", CONTROLLER);
    expect(test, CALL(test, admin_purge, "(\"crew\")", CONTROLLER),
           "remaining = 0");
    TRAPS(test, mail_send, in("bob", held.args()), USER_B,
          "already queued from crew@");
    CALL(test, mail_outbox_delete,
         "(\"bob\", " + other.substr(1, other.find_first_of(" :)") - 1) + ")",
         USER_B);
  }
}
