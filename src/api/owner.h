// A mailbox the caller is a member of. Every owner method names its mailbox
// by its local part, and a controller gets no override.

#pragma once

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <initializer_list>
#include <string>
#include <vector>

#include "allowlist.h"
#include "ic_api.h"

inline std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return s;
}

// An unknown address and a mailbox the caller is not a member of are refused
// alike, so that a stranger learns nothing about which addresses exist. Local
// parts are stored in lower case, so any case names the mailbox.
inline store::Entry require_mailbox(IC_API &ic_api, const std::string &local) {
  store::Entry entry;
  if (!store::member_mailbox(ic_api.get_caller().get_text(), lower(local),
                             entry)) {
    IC_API::trap("no such mailbox for this principal");
  }
  return entry;
}

// Reads a mailbox method's arguments, the mailbox's local part and then
// `rest`, and returns the mailbox once the caller is a member of it
inline store::Entry read_mailbox(IC_API &ic_api,
                                 std::initializer_list<CandidType> rest) {
  std::string local;
  CandidArgs args;
  args.append(CandidTypeText{&local});
  for (const CandidType &arg : rest)
    args.append(arg);
  ic_api.from_wire(args);
  return require_mailbox(ic_api, local);
}

inline store::Mailbox require_file(const store::Entry &entry) {
  const std::string why = store::unusable(entry);
  if (!why.empty()) IC_API::trap(why);
  const store::Mailbox box{entry.id, db::mailbox(entry.id)};
  if (box.file == nullptr)
    IC_API::trap("busy: the mailbox cannot be opened, try again");
  return box;
}

// For a write: refused while a download holds the file. Unlike busy, it can
// last minutes, so the webmail does not retry it.
inline store::Mailbox require_writable_file(const store::Entry &entry) {
  if (store::frozen(entry.export_until_ns)) {
    IC_API::trap(
        "downloading: the mailbox is being downloaded, try again once that ends");
  }
  return require_file(entry);
}

const size_t k_max_batch = 200; // messages deleted, moved or flagged at once

inline void require_batch(const std::vector<uint64_t> &ids) {
  if (ids.size() > k_max_batch) IC_API::trap("too many messages at once");
}
