#include "api.h"
#include "db.h"
#include "dev_hooks.h"
#include "ic_api.h"
#include "ingest.h"
#include "outbox.h"

// Timers and the heap do not survive an upgrade: the backlog and the outbox
// are in control.db, and the two starts pick them up again without opening a
// mailbox file.

void canister_init() {
  IC_API ic_api(CanisterInit{std::string(__func__)}, false);
  db::open();
  ingest::start(ic_api.get_canister_self().get_text());
  outbox::start(ic_api.get_canister_self().get_text());
}

void canister_post_upgrade() {
  IC_API ic_api(CanisterPostUpgrade{std::string(__func__)}, false);
  db::open(); // refuses a v0.1.x mail.db
  ingest::start(ic_api.get_canister_self().get_text());
  outbox::start(ic_api.get_canister_self().get_text());
  dev_record_cost(__func__);
}
