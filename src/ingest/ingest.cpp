#include "ingest.h"

#include <algorithm>
#include <cstdint>
#include <map>

#include "allowlist.h"
#include "api.h"
#include "dev_hooks.h"
#include "ic_api.h"
#include "ic_async.h"
#include "ingest_limits.h"
#include "mail_store.h"
#include "outbox.h"
#include "queue_store.h"

namespace {

const int64_t k_max_attempts = 3;
// A file's failed upgrades before its mailbox is held: a canister low on
// cycles fails every upgrade for a while
const int64_t k_max_upgrade_failures = 3;
const int64_t k_merge_every = 64;
const int64_t k_merge_pages =
    2000; // about 10B instructions, measured (docs/design.md)
const uint64_t k_retry_delay_ns = 5'000'000'000;
// How long a mailbox whose file cannot be opened waits before the next try
const uint64_t k_defer_ns = 60'000'000'000;
// When a pump that trapped before it re-armed is started again
const uint64_t k_watchdog_ns = 60'000'000'000;
// A pump still marked as running after this trapped after its call: a call to
// this canister itself returns much sooner
const uint64_t k_stuck_ns = 600'000'000'000;

std::string g_self;
bool g_armed = false;
uint64_t g_armed_at = 0;
uint64_t g_timer_id = 0;
bool g_pumping = false;
uint64_t g_pumping_since = 0;
uint64_t g_pump_generation = 0; // a pump the watchdog gave up on ends quietly
bool g_paused = false;
// By mailbox, until its upgrade or its hold; the heap does not survive an
// upgrade, so a new release starts counting afresh
std::map<int64_t, int64_t> g_upgrade_failures;
// Upgrades take turns with parses and moves
bool g_upgrade_turn = true;
// Cleanups take turns with the rest
bool g_clean_turn = false;
#ifdef EMAIL_CANISTER_TEST_HOOKS
bool g_trap_moves = false;
#endif

void arm_after(uint64_t delay_ns);
void schedule(uint64_t delay_ns);

void on_timer() {
  g_armed = false;
  if (g_paused) return;
  if (g_pumping) {
    // A trap after the call leaves the flag set: nothing else would clear it
    if (IC_API::time() - g_pumping_since < k_stuck_ns) {
      schedule(k_watchdog_ns);
      return;
    }
    g_pumping = false;
    ++g_pump_generation;
  }
  IC_CallResult<void> sent =
      IC_Call::bounded_wait(CandidTypePrincipal{g_self}, "ingest_pump")
          .oneway();
  // The pump replaces this with its own choice, unless it traps first
  arm_after(sent ? k_watchdog_ns : k_retry_delay_ns);
}

void arm_after(uint64_t delay_ns) {
  if (g_pumping || g_paused) return;
  schedule(delay_ns);
}

// An earlier time replaces a later one, so that new mail never waits for a
// deferred mailbox's retry
void schedule(uint64_t delay_ns) {
  const uint64_t at = IC_API::time() + delay_ns;
  if (g_armed) {
    if (g_armed_at <= at) return;
    IC_API::cancel_timer(g_timer_id);
  }
  g_armed = true;
  g_armed_at = at;
  g_timer_id = IC_API::set_timer(delay_ns, on_timer);
}

void disarm() {
  if (g_armed) IC_API::cancel_timer(g_timer_id);
  g_armed = false;
}

// A stopping canister refuses its calls to itself with the same code as a
// trap
bool running(IC_API &ic_api) {
  return ic_api.get_canister_status() == IC_API::CanisterStatus::Running;
}

// Holds the mailbox for `why` once its file's upgrade failed
// k_max_upgrade_failures times, else leaves it to wait before the next try
void upgrade_failed(int64_t mailbox, const std::string &why) {
  int64_t &failures = g_upgrade_failures[mailbox];
  if (++failures >= k_max_upgrade_failures &&
      store::set_needs_repair(mailbox, store::k_upgrade_failed + why)) {
    g_upgrade_failures.erase(mailbox);
    return;
  }
  // A hold that could not be written is tried again after the wait
  const auto now = static_cast<int64_t>(IC_API::time());
  store::defer_pump(mailbox, now + static_cast<int64_t>(k_defer_ns));
}

void require_self(IC_API &ic_api) {
  if (ic_api.get_caller().get_text() != g_self) {
    IC_API::trap("only this canister can call this method");
  }
}

IC_Async ingest_pump_async() {
  IC_API ic_api(CanisterUpdate{"ingest_pump"}, false);
  require_self(ic_api);
  ic_api.from_wire();

  if (g_pumping) {
    ic_api.to_wire();
    co_return;
  }

  // Until its upgrade nothing uses a file, and a parse or a move leaves its
  // mailbox alone. Upgrades take turns with the rest, so that mailboxes
  // already upgraded keep receiving while the others wait. Parsing goes
  // before moving, so that a message is searchable soon after its move. A
  // mailbox whose parse cannot be claimed does not hold up the moves.
  // Cleanups take turns with the rest too, so that a mailbox refused mail for
  // its quota is cleaned while others receive.
  int64_t mailbox = 0;
  int64_t id = 0;
  int64_t due = 0; // the cleanup's marks
  const auto now = static_cast<int64_t>(IC_API::time());
  const auto defer = static_cast<int64_t>(k_defer_ns);
  enum class Work { Upgrade, Parse, Move, Clean } work = Work::Move;
  store::Claim claim = store::Claim::Empty;
  bool failed = false;
  bool not_run = false; // a call that the IC never ran
  // The first that has work wins; with none, a failed claim retries later
  const auto take = [&](store::Claim found, Work what) {
    if (found == store::Claim::Claimed || found == store::Claim::Again) {
      claim = found;
      work = what;
      return true;
    }
    failed = failed || found == store::Claim::Failed;
    return false;
  };
  const auto upgrade = [&] {
    return take(store::claim_upgrade(now, defer, mailbox), Work::Upgrade);
  };
  const auto receive = [&] {
    return take(store::claim_parse(k_max_attempts, now, defer, mailbox, id),
                Work::Parse) ||
           take(store::claim_move(k_max_attempts, now, defer, id), Work::Move);
  };
  const auto clean = [&] {
    return take(store::claim_clean(now, defer, mailbox, due), Work::Clean);
  };
  const auto rest = [&] {
    return g_upgrade_turn ? upgrade() || receive() : receive() || upgrade();
  };
  if (g_clean_turn ? clean() || rest() : rest() || clean()) {
    // A cleanup leaves the upgrades' turn as it was: were it to hand it back,
    // upgrades and cleanups would take every turn between them
    if (work != Work::Clean) g_upgrade_turn = work != Work::Upgrade;
    g_clean_turn = work != Work::Clean;
  } else if (failed) {
    claim = store::Claim::Failed;
  }
  if (claim == store::Claim::Claimed) {
    g_pumping = true; // the co_await commits this and the recorded attempt
    g_pumping_since = IC_API::time();
    const uint64_t generation = g_pump_generation;
    const CandidTypePrincipal self = ic_api.get_canister_self();
    // Whether a failed call counts as an attempt
    const auto ran = [&ic_api](const IC_CallError &error) {
      return ingest::may_have_run(error, running(ic_api));
    };
    if (work == Work::Upgrade) {
      IC_CallResult<IC_CallReply> result =
          co_await IC_Call::unbounded_wait(self, "ingest_upgrade_file")
              .with_arg(CandidTypeNat64{static_cast<uint64_t>(mailbox)});
      // A step that traps again and again holds the mailbox for repair. A
      // call that did not run the upgrade is tried again later.
      if (!result) {
        const IC_CallError &error = result.error();
        if (ran(error) && error.reject_code == IC_RejectCode::CanisterError) {
          upgrade_failed(mailbox, error.to_string());
        } else {
          store::defer_pump(mailbox, now + defer);
        }
      }
    } else if (work == Work::Parse) {
      CandidArgs args;
      args.append(CandidTypeNat64{static_cast<uint64_t>(mailbox)});
      args.append(CandidTypeNat64{static_cast<uint64_t>(id)});
      IC_CallResult<IC_CallReply> result =
          co_await IC_Call::unbounded_wait(self, "ingest_process")
              .with_args(args);
      if (!result) {
        const bool attempted = ran(result.error());
        not_run = !attempted;
        store::record_parse_failure(mailbox, id, result.error().to_string(),
                                    attempted);
      } else if (store::merge_due(mailbox, k_merge_every)) {
        IC_CallResult<IC_CallReply> merged =
            co_await IC_Call::unbounded_wait(self, "ingest_merge")
                .with_arg(CandidTypeNat64{static_cast<uint64_t>(mailbox)});
        (void)merged; // the next merge makes up for a failed one
      }
    } else if (work == Work::Clean) {
      IC_CallResult<IC_CallReply> result =
          co_await IC_Call::unbounded_wait(self, "ingest_clean")
              .with_arg(CandidTypeNat64{static_cast<uint64_t>(mailbox)});
      // One that failed after it ran waits for the next mark, so a message
      // that cannot be deleted never makes the pump loop; a mark made during
      // the call stays. One that never ran is tried again later.
      if (!result) {
        not_run = !ran(result.error());
        if (!not_run) store::stop_cleaning(mailbox, due);
      }
    } else {
      IC_CallResult<IC_CallReply> result =
          co_await IC_Call::unbounded_wait(self, "ingest_move")
              .with_arg(CandidTypeNat64{static_cast<uint64_t>(id)});
      if (!result) {
        const bool attempted = ran(result.error());
        not_run = !attempted;
        store::record_move_failure(id, result.error().to_string(), attempted);
      }
    }
    if (generation != g_pump_generation) {
      ic_api.to_wire();
      co_return; // another pump runs now, and decides what comes next
    }
    g_pumping = false;
  }

  int64_t deferred_until = 0;
  disarm(); // the watchdog
  if (claim != store::Claim::Empty) {
    // A call that never ran waits, like a failed claim, before the next try
    arm_after(claim == store::Claim::Failed || not_run ? k_retry_delay_ns : 0);
  } else if (store::deferred_until(now, deferred_until)) {
    arm_after(
        static_cast<uint64_t>(std::max<int64_t>(0, deferred_until - now)));
  }
  ic_api.to_wire();
}

} // namespace

void ingest_pump() { ingest_pump_async(); }

void ingest_move() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_self(ic_api);
  uint64_t id = 0;
  ic_api.from_wire(CandidTypeNat64{&id});
#ifdef EMAIL_CANISTER_TEST_HOOKS
  if (g_trap_moves) IC_API::trap("test hook: moves trap");
#endif
  const int64_t since =
      static_cast<int64_t>(IC_API::time()) - dedupe_window_ns();
  if (!store::move(static_cast<int64_t>(id), since)) {
    IC_API::trap("the message could not be moved");
  }
  dev_record_cost(__func__);
  ic_api.to_wire();
}

void ingest_process() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_self(ic_api);
  uint64_t mailbox = 0;
  uint64_t id = 0;
  CandidArgs args;
  args.append(CandidTypeNat64{&mailbox});
  args.append(CandidTypeNat64{&id});
  ic_api.from_wire(args);
  if (!store::process(static_cast<int64_t>(mailbox),
                      static_cast<int64_t>(id))) {
    IC_API::trap("the message could not be stored");
  }
  dev_record_cost(__func__);
  ic_api.to_wire();
}

void ingest_upgrade_file() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_self(ic_api);
  uint64_t mailbox = 0;
  ic_api.from_wire(CandidTypeNat64{&mailbox});
  const auto id = static_cast<int64_t>(mailbox);
  std::string problem;
  switch (store::upgrade_file(id, problem)) {
  case store::Upgraded::Done:
    g_upgrade_failures.erase(id);
    outbox::arm(); // the outbox leaves a file alone until its upgrade
    break;
  case store::Upgraded::NotDue:
    break;
  case store::Upgraded::Failed:
    upgrade_failed(id, problem);
    break;
  case store::Upgraded::Wait: {
    // Not a trap: the pump counts an upgrade that traps. A failed defer
    // leaves the upgrade due, so it is tried again at once.
    const auto now = static_cast<int64_t>(IC_API::time());
    store::defer_pump(id, now + static_cast<int64_t>(k_defer_ns));
    break;
  }
  }
  dev_record_cost(__func__);
  ic_api.to_wire();
}

void ingest_clean() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_self(ic_api);
  uint64_t mailbox = 0;
  ic_api.from_wire(CandidTypeNat64{&mailbox});
  if (!store::clean_expired(static_cast<int64_t>(mailbox),
                            static_cast<int64_t>(IC_API::time()))) {
    IC_API::trap("the expired mail could not be deleted");
  }
  dev_record_cost(__func__);
  ic_api.to_wire();
}

void ingest_merge() {
  IC_API ic_api(CanisterUpdate{std::string(__func__)}, false);
  require_self(ic_api);
  uint64_t mailbox = 0;
  ic_api.from_wire(CandidTypeNat64{&mailbox});
  store::merge_index(static_cast<int64_t>(mailbox), k_merge_pages);
  ic_api.to_wire();
}

namespace ingest {

bool may_have_run(const IC_CallError &error, bool running) {
  return running && error.kind == IC_CallError::Kind::CallRejected &&
         !error.is_clean_reject();
}

void start(const std::string &canister_self) {
  g_self = canister_self;
  const auto now = static_cast<int64_t>(IC_API::time());
  int64_t deferred = 0;
  // -1, a failed count, arms too
  if (store::backlog(now) != 0 || store::deferred_until(now, deferred) ||
      store::upgrade_pending() || store::clean_pending())
    arm();
}

void arm() { arm_after(0); }

#ifdef EMAIL_CANISTER_TEST_HOOKS
void set_paused(bool paused) {
  g_paused = paused;
  if (!paused) arm();
}

void set_trap_moves(bool trap) { g_trap_moves = trap; }
#endif

} // namespace ingest
