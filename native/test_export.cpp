// A download's edges: the end of the file, and the writes it holds off

#include <cctype>
#include <string>

#include "api.h"
#include "support.h"

using namespace native;

namespace {

std::string chunk(const std::string &offset, const std::string &length) {
  return "(record { offset = " + offset + "; length = " + length + " })";
}

// The bytes in a reply's `data = blob "…"`: didc writes a byte as itself, as
// \hh, or as \ and one character
size_t blob_bytes(const std::string &reply) {
  const std::string start = "data = blob \"";
  size_t i = reply.find(start);
  if (i == std::string::npos) return 0;
  size_t bytes = 0;
  for (i += start.size(); i < reply.size() && reply[i] != '"'; ++bytes) {
    if (reply[i] != '\\') i += 1;
    else if (i + 2 < reply.size() &&
             std::isxdigit(static_cast<unsigned char>(reply[i + 1])) &&
             std::isxdigit(static_cast<unsigned char>(reply[i + 2])))
      i += 3;
    else i += 2;
  }
  return bytes;
}

} // namespace

void test_export(MockIC &) {
  const std::string test = "a download";
  // A message to try the outbox's writes on
  const std::string id = CALL(
      test, mail_send, in("bob", Send{.client_id = "export"}.args()), USER_B);
  const std::string message = id.substr(1, id.find_first_of(" :)") - 1);

  const std::string info =
      CALL(test, mail_export_freeze, "(\"bob\", null)", USER_B);
  const std::string size = field(info, "size");
  const std::string started = field(info, "started_ns");

  {
    const std::string at_end = "a chunk at the end of the file is empty";
    const std::string reply =
        CALL(at_end, mail_export_chunk, in("bob", chunk(size, "10")), USER_B);
    expect(at_end, reply, "data = blob \"\"");
    expect_equal(at_end, field(reply, "size"), size);
  }
  {
    const std::string past = "a chunk past the end of the file is empty";
    expect(past,
           CALL(past, mail_export_chunk, in("bob", chunk(size + "_000", "10")),
                USER_B),
           "data = blob \"\"");
  }
  {
    const std::string last = "the last chunk ends with the file";
    const std::string offset = std::to_string(std::stoull(size) - 3);
    const std::string reply =
        CALL(last, mail_export_chunk, in("bob", chunk(offset, "10")), USER_B);
    expect_equal(last, std::to_string(blob_bytes(reply)), "3");
    expect_equal(last, field(reply, "size"), size);
    expect_equal(last, field(reply, "started_ns"), started);
  }

  TRAPS("a download holds off a resend", mail_outbox_resend,
        "(\"bob\", " + message + ")", USER_B, "downloading:");
  TRAPS("a download holds off an outbox delete", mail_outbox_delete,
        "(\"bob\", " + message + ")", USER_B, "downloading:");
  TRAPS("a download holds off a send", mail_send,
        in("bob", Send{.client_id = "held"}.args()), USER_B, "downloading:");

  CALL(test, mail_export_thaw, "(\"bob\", " + started + ")", USER_B);
  TRAPS("after the download a chunk is refused", mail_export_chunk,
        in("bob", chunk("0", "10")), USER_B, "no download is under way");
  CALL(test, mail_outbox_delete, "(\"bob\", " + message + ")", USER_B);

  // In a shared mailbox, a download is its member's alone: another member can
  // neither read its chunks, renew it nor end it, and waits for it to end
  {
    const std::string shared = "another member's download";
    const std::string bobs =
        CALL(shared, mail_export_freeze, "(\"team\", null)", USER_B);
    const std::string begun = field(bobs, "started_ns");
    TRAPS("another member reads no chunk", mail_export_chunk,
          in("team", chunk("0", "10")), USER_A, "no download is under way");
    TRAPS("another member renews no download", mail_export_freeze,
          "(\"team\", opt " + begun + ")", USER_A, "the download has ended");
    TRAPS("another member starts none meanwhile", mail_export_freeze,
          "(\"team\", null)", USER_A, "a download is already under way");
    TRAPS("another member's writes wait", mail_send,
          in("team", Send{.client_id = "team-held"}.args()), USER_A,
          "downloading:");
    CALL(shared, mail_export_thaw, "(\"team\", " + begun + ")", USER_A);
    expect_equal(shared,
                 field(CALL(shared, mail_export_chunk,
                            in("team", chunk("0", "10")), USER_B),
                       "started_ns"),
                 begun);
    CALL(shared, mail_export_thaw, "(\"team\", " + begun + ")", USER_B);
    TRAPS("its member's thaw ends it", mail_export_chunk,
          in("team", chunk("0", "10")), USER_B, "no download is under way");
  }
  {
    // No one else could end it, so it would hold every member's writes
    const std::string removed = "removing a member ends their download";
    CALL(removed, mail_export_freeze, "(\"team\", null)", USER_B);
    CALL(removed, admin_remove_member,
         "(\"team\", principal \"" + USER_B + "\")", CONTROLLER);
    const std::string next =
        CALL(removed, mail_export_freeze, "(\"team\", null)", USER_A);
    CALL(removed, mail_export_thaw,
         "(\"team\", " + field(next, "started_ns") + ")", USER_A);
    CALL(removed, admin_add_member,
         "(\"team\", principal \"" + USER_B + "\", null)", CONTROLLER);
  }
}
