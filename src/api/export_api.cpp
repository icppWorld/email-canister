// A member's download of a mailbox's SQLite file (see owner.h). A download
// freezes the file: nothing writes to it until the freeze ends, so the chunks
// read from it fit together. Only the member who started it reads its chunks,
// renews it or ends it.

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "allowlist.h"
#include "api.h"
#include "ic_api.h"
#include "ingest.h"
#include "outbox.h"
#include "owner.h"

namespace {

// The webmail renews the freeze every 2 minutes; a closed tab lets it lapse
int64_t g_hold_ns = 300'000'000'000;
// However often it is renewed, one download holds mail back no longer than this
int64_t g_limit_ns = 7'200'000'000'000;
// Fits a query's reply, with room for the rest of it
const uint64_t k_max_chunk = 1'900'000;

CandidTypeNat64 nat64(int64_t value) {
  return CandidTypeNat64{static_cast<uint64_t>(value)};
}

} // namespace

// Starts a download, or renews the one it names. A closed tab's download
// lapses after the hold, and a new one can start.
void mail_export_freeze() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  std::optional<uint64_t> renew;
  const store::Entry entry = read_mailbox(ic_api, {CandidTypeOptNat64{&renew}});
  std::optional<int64_t> renew_ns;
  if (renew) renew_ns = static_cast<int64_t>(*renew);
  store::Export current;
  const std::string refused =
      store::export_freeze(entry.id, ic_api.get_caller().get_text(),
                           static_cast<int64_t>(IC_API::time()), g_hold_ns,
                           g_limit_ns, renew_ns, current);
  if (!refused.empty()) IC_API::trap(refused);
  CandidTypeRecord r;
  r.append("size", nat64(current.size));
  r.append("started_ns", nat64(current.started_ns));
  r.append("until_ns", nat64(current.until_ns));
  ic_api.to_wire(r);
}

// Ends the download it names, so that mail moves into the file again at once
void mail_export_thaw() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  uint64_t started_ns = 0;
  const store::Entry entry =
      read_mailbox(ic_api, {CandidTypeNat64{&started_ns}});
  if (!store::export_thaw(entry.id, ic_api.get_caller().get_text(),
                          static_cast<int64_t>(started_ns))) {
    IC_API::trap("the download could not end");
  }
  ingest::arm();
  outbox::arm();
  ic_api.to_wire();
}

// Bytes of the file, only while the caller's own download holds it
void mail_export_chunk() {
  IC_API ic_api(CanisterQuery{std::string(__func__)}, false);
  uint64_t offset = 0;
  uint64_t length = 0;
  CandidTypeRecord in;
  in.append("offset", CandidTypeNat64{&offset});
  in.append("length", CandidTypeNat64{&length});
  const store::Entry entry = read_mailbox(ic_api, {in});
  if (length > k_max_chunk) {
    IC_API::trap("a chunk is at most " + std::to_string(k_max_chunk) +
                 " bytes");
  }
  if (!store::downloading_for(entry, ic_api.get_caller().get_text())) {
    IC_API::trap("no download is under way: start it again");
  }
  std::vector<uint8_t> data;
  const int64_t size = db::read_mailbox(entry.id, static_cast<int64_t>(offset),
                                        static_cast<int64_t>(length), data);
  if (size < 0) IC_API::trap("the file could not be read");
  CandidTypeRecord r;
  r.append("data", CandidTypeVecNat8{std::move(data)});
  r.append("size", nat64(size));
  r.append("started_ns", nat64(entry.export_started_ns));
  ic_api.to_wire(r);
}

#ifdef EMAIL_CANISTER_TEST_HOOKS
void dev_set_export_timing() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  if (!ic_api.is_controller(ic_api.get_caller()))
    IC_API::trap("controllers only");
  uint64_t hold = 0;
  uint64_t limit = 0;
  CandidArgs args;
  args.append(CandidTypeNat64{&hold});
  args.append(CandidTypeNat64{&limit});
  ic_api.from_wire(args);
  g_hold_ns = static_cast<int64_t>(hold);
  g_limit_ns = static_cast<int64_t>(limit);
  ic_api.to_wire();
}
#endif
