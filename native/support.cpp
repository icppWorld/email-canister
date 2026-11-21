#include "support.h"

#include "api.h"
#include "db.h"

#include <array>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <unistd.h> // mkdtemp

namespace native {
namespace {

MockIC *g_mock_ic = nullptr;
std::string g_did;
std::filesystem::path g_dir; // this run's, removed at exit
std::filesystem::path g_scratch;

[[noreturn]] void fail(const std::string &test, const std::string &why) {
  std::cout << "\nTest: '" << test << "' Failed\n" << why << '\n';
  g_mock_ic->test_summary();
  std::exit(1);
}

// Runs didc with `input` on stdin, and returns what it prints
std::string didc(const std::string &test, const std::string &options,
                 const std::string &input) {
  const std::filesystem::path in = g_scratch / "didc.in";
  std::ofstream(in) << input;
  const std::string command = "didc " + options + " < '" + in.string() + "'";
  FILE *pipe = popen(command.c_str(), "r");
  if (pipe == nullptr) fail(test, "cannot run: " + command);
  std::string out;
  std::array<char, 4096> buffer{};
  size_t n = 0;
  while ((n = fread(buffer.data(), 1, buffer.size(), pipe)) > 0) {
    out.append(buffer.data(), n);
  }
  if (pclose(pipe) != 0) fail(test, "didc failed on: " + input);
  while (!out.empty() && (out.back() == '\n' || out.back() == ' ')) {
    out.pop_back();
  }
  return out;
}

std::string encode(const std::string &test, const std::string &method,
                   const std::string &args, bool untyped) {
  return didc(test,
              untyped ? "encode" : "encode -d '" + g_did + "' -m " + method,
              args);
}

} // namespace

void setup(MockIC &mock_ic, const std::string &did) {
  g_mock_ic = &mock_ic;
  // Natively the counter is the steady clock, far past every instruction
  // budget; counting none lets a seed or a search run to its end
  mock_ic.set_performance_counter([](uint32_t) { return uint64_t{0}; });
  g_did = std::filesystem::absolute(did).string();
  // A directory of its own, so runs from two checkouts never share files
  std::string dir =
      (std::filesystem::temp_directory_path() / "email-canister-native-XXXXXX")
          .string();
  if (!mkdtemp(dir.data())) fail("setup", "no temporary directory: " + dir);
  g_dir = dir;
  std::atexit([] { std::filesystem::remove_all(g_dir); });
  std::filesystem::create_directories(g_dir / "scratch");
  std::filesystem::current_path(g_dir);
  g_scratch = g_dir / "scratch";
}

std::string call(const std::string &test, Method fn, const std::string &method,
                 const std::string &args, const std::string &caller,
                 bool untyped) {
  std::string reply;
  g_mock_ic->run_test(test, fn, encode(test, method, args, untyped), "", false,
                      caller, &reply);
  if (reply.empty()) return "";
  return didc(test, "decode -d '" + g_did + "' -m " + method, reply);
}

void traps(const std::string &test, Method fn, const std::string &method,
           const std::string &args, const std::string &caller,
           const std::string &trap) {
  g_mock_ic->run_trap_test(test, fn, encode(test, method, args, false), true,
                           caller, trap);
}

std::string field(const std::string &reply, const std::string &name,
                  size_t from) {
  // The whole name: "id" is not found in "uid = "
  size_t at = reply.find(name + " = ", from);
  while (at != std::string::npos && at > 0 &&
         (std::isalnum(static_cast<unsigned char>(reply[at - 1])) ||
          reply[at - 1] == '_')) {
    at = reply.find(name + " = ", at + 1);
  }
  if (at == std::string::npos) return "";
  size_t i = at + name.size() + 3;
  if (reply.compare(i, 4, "opt ") == 0) i += 4;
  if (i < reply.size() && reply[i] == '(') ++i;
  std::string digits;
  for (; i < reply.size() && (std::isdigit(reply[i]) || reply[i] == '_'); ++i) {
    if (reply[i] != '_') digits += reply[i];
  }
  return digits;
}

void expect(const std::string &test, const std::string &text,
            const std::string &part) {
  if (text.find(part) == std::string::npos) {
    fail(test, "Expected:\n  " + part + "\nin:\n  " + text);
  }
}

void check(const std::string &test, bool ok, const std::string &why) {
  if (!ok) fail(test, why);
}

void expect_equal(const std::string &test, const std::string &got,
                  const std::string &wanted) {
  check(test, !wanted.empty(), "nothing to compare with");
  check(test, got == wanted, "got \"" + got + "\", not \"" + wanted + "\"");
}

void expect_not(const std::string &test, const std::string &text,
                const std::string &part) {
  if (text.find(part) != std::string::npos) {
    fail(test, "Did not expect:\n  " + part + "\nin:\n  " + text);
  }
}

void add_mailbox(const std::string &test, const std::string &principal,
                 const std::string &local, const std::string &quota) {
  call(test, admin_create_mailbox, "admin_create_mailbox",
       "(record { local = \"" + local + "\"; quota_bytes = " + quota +
           "; first_member = opt principal \"" + principal + "\" })",
       CONTROLLER);
}

size_t count(const std::string &text, const std::string &part) {
  size_t n = 0;
  for (size_t at = text.find(part); at != std::string::npos;
       at = text.find(part, at + part.size())) {
    ++n;
  }
  return n;
}

int64_t control_integer(const std::string &sql) {
  db::Stmt select(db::control(), sql.c_str());
  return select && select.row() ? select.column_integer(0) : -1;
}

std::string me_of(const std::string &test, const std::string &caller,
                  const std::string &local) {
  const std::string me = CALL(test, mail_me, "()", caller);
  const size_t at = me.find("local = \"" + local + "\"");
  check(test, at != std::string::npos, "no " + local + " in: " + me);
  // Its whole record: didc orders the fields by their hashes
  const size_t start = me.rfind("record {", at);
  return me.substr(start, me.find('}', at) - start);
}

} // namespace native
