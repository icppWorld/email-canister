# How email-canister is built

email-canister runs email for one domain on Internet Computer canisters: a C++ backend that receives, stores, indexes and sends mail, and a webmail served from an asset canister. Users sign in with Internet Identity, so there are no passwords.

## Why not port an existing mail server

Postfix, Dovecot, Exim, OpenSMTPD, Sendmail, Courier, Cyrus and similar servers rely on forked processes or threads, listening sockets and blocking I/O. A canister has none of these: it runs one message at a time, has no sockets, and every call has an instruction limit. A port would keep only their parsers. email-canister is instead a small message-driven C++20 program that links portable libraries:

| Need | Choice | Licence |
|---|---|---|
| RFC 5322 and MIME parsing | libetpan's low-level parsers | BSD-3-Clause |
| Index and search | SQLite with FTS5, on stable memory | Public domain |

GPL and AGPL mail libraries are deliberately not used.

## Architecture

```
Sender --SMTP--> DFINITY SMTP gateway --smtp_request--> backend canister
Browser (Internet Identity) --Candid--> backend canister      webmail asset canister
backend canister --inter-canister call--> relay bridge (a Caffeine app) --HTTPS--> mail gateway --SMTP--> recipient
```

- **One domain per deployment.** Each domain has its own backend and webmail canister. The backend stores its domain and the principal of its relay bridge, and answers 550 for any other recipient domain.
- **Inbound** goes through the DFINITY SMTP gateway. The domain's MX records point at the gateway, and the bare domain serves `/.well-known/ic-smtp-canister-id`, naming the backend canister. For a domain bought through Caffeine the Caffeine app serves it. For a domain registered elsewhere, Caffeine serves only `www` and rewrites its site's `/.well-known/ic-domains` at every deploy, so a domain canister the deployment owns serves the bare domain: the file for the gateway, the domain list for the IC's custom-domain service, and a redirect to `www` for browsers (`domain/domain.mjs`). Messages over about 2 MB, or about 1.4 MB of attachments, are refused by the gateway.
- **Outbound** goes through a relay bridge: a small Motoko method, `relaySend`, in a Caffeine app on the same domain, which calls Caffeine's mail gateway. The bridge accepts calls only from the backend canister. The backend cannot call the gateway itself, because the gateway's key is held by the Caffeine app.
- **Sign-in:** Internet Identity. Principals depend on the derivation origin, so the webmail's origin is fixed before the first user is added; changing it later gives every user a new principal and locks them out of their mailbox. The webmail can also answer on custom domains: the derivation origin lists them in `/.well-known/ii-alternative-origins`, so users keep the same principal on each address.

## Access model

- **Controllers** of the backend canister are its administrators. Every admin method checks `is_controller` on the backend; the webmail hides the Admin screen from others, but that is only cosmetic.
- Admins create a mailbox (the local part of its address, and optionally its first member and quota), add and remove members, name people, disable a mailbox, purge a disabled one, set quotas, check a mailbox's file, retry mail that could not be moved into its mailbox, and see totals. No admin method returns message content, subjects or senders.
- **Members.** A mailbox has members: up to 100 principals, all equal, download included. A principal can be a member of several mailboxes, and one sign-in shows every one of them that is enabled. A disabled mailbox answers its members as if it did not exist. Only admins manage membership.
- Every mailbox method takes the mailbox's local part and acts only if the caller is a member of that mailbox and it is enabled. A non-member and an unknown address get the same error. Controllers have no access to a mailbox's mail unless they are its members.
- **Access is granted only by naming it.** `admin_create_mailbox` refuses an address in use and never adds anyone to an existing mailbox: the new mailbox's first member, if the admin names one, is added in the same call, and a refusal leaves no mailbox. `admin_add_member` names the mailbox, and the Admin panel confirms it, saying the member can read, delete and send from it. It also takes the mailbox's `uidvalidity` as listed, and the Admin panel always passes it, so a list read before a purge cannot add a member to the address created again since. A command-line call may pass `null`, which skips that check.
- A controller can add any principal to a mailbox, their own included, and then read its mail. That is the same trust as the code upgrade below: choose controllers as carefully as whoever runs your mail server.
- Removing a member takes effect at their next call, and ends their download.
- Read state is shared by the members. Opening a message records who opened it, and when, once per member; the reader lists them as "Seen by". Each sent message records the member who sent it.
- Any member can download the mailbox's file. The download belongs to the member who started it: only they can read its chunks, renew it or end it.
- Sending always uses the address of the mailbox the caller sends from, which they must be a member of, never an address from the request.
- **Onboarding:** the user signs in, sees a "not activated" screen with their principal, and gives it to an admin. The admin creates a mailbox with them as its first member, or adds them to an existing one, and can give them a name, which other members see. The user's next load shows their mailboxes; someone who is not an admin and whose only mailboxes are disabled sees the "not activated" screen again.
- **What this does not protect against:** a controller can upgrade the canister's code, and node operators can read canister memory. Mail is stored as plain text.

## Rules the implementation follows

- **SMTP handlers never trap.** A trap makes the sender's server retry for days. Requests are decoded without trapping, and a malformed request returns 451.
- Return 550 only for an unknown mailbox, and 530 unless the caller is the gateway or a controller.
- **One SQLite database per mailbox**, as [storage-per-mailbox.md](storage-per-mailbox.md) recommends. Each mailbox has its own file, `m/<id / 100>/<id>/mail.db`, and `control.db` beside them holds the settings, the mailbox registry with each mailbox's members, people's names, the queue of incoming mail, recent dedupe keys and sends, and the work index. Timers find their work in `control.db` alone. A search, a check, a download and a purge each touch only the mailbox's own file.
- `smtp_request` never awaits and writes only to `control.db`. In one transaction it deduplicates, reserves each recipient's quota, and queues the message once for all its recipients. The dedupe key is mailbox, sender and `Message-ID`, or a content hash without one; a key is kept for 7 days, and the mailbox's file recognizes a redelivery from then on. A mailbox with 100 messages in the queue answers 451, and the sender retries. So does every mailbox while 1,000 deliveries wait canister-wide that the timer can work on now, counting a message once per recipient: mail for a mailbox that is being downloaded, held for repair, or whose file cannot be opened, and quarantined moves, count only toward their own mailbox's cap.
- One timer, the ingest pump, does one item per call, each a call to the canister itself, so a call that traps rolls back on its own: it upgrades a mailbox file to the current schema (`ingest_upgrade_file`), parses and indexes one message (`ingest_process`), or moves the oldest queued message into its mailbox's file (`ingest_move`). Every 64 parsed messages, it merges that mailbox's search index (`ingest_merge`). A message whose move or parse fails three times is quarantined: a failed parse stays viewable, as plain text under a warning, and an admin can queue a failed move again with `admin_retry_moves`.
- Timers do not survive upgrades, so `post_upgrade` rearms them from `control.db`. Stop the canister before upgrading. `post_upgrade` refuses a canister that still holds v0.1.x's single `mail.db`, so an upgrade by mistake leaves v0.1.x running.
- SQLite runs with `journal_mode=MEMORY`, `synchronous=OFF`, no WAL, `locking_mode=EXCLUSIVE`, and automatic FTS merges off; merges run in budgeted steps of at most 2000 pages. No transaction is held across an await. Storage goes through a custom VFS on stable memory (`src/store/sqlite_vfs.c`, built with `SQLITE_OS_OTHER=1`).
- **At most one connection per file.** With `locking_mode=EXCLUSIVE`, a second connection would read stale pages. Only `src/store/db.cpp` opens a database, and a static check enforces it. A cache keeps up to 32 mailbox connections open, each with a 1 MiB page cache, and closes the least recently used; `control.db` keeps 16 MiB.
- **Bodies are stored in SQLite**, not as one file per message; see the measurements below.
- **Mailbox files have a schema version**, kept in the registry. The ingest pump upgrades each file before it moves or parses anything into it, and meanwhile the members' calls answer `busy:` and the webmail retries. Upgrades take turns with moves and parses, so mailboxes already upgraded keep receiving while the others wait. A step that fails holds its mailbox for repair only on its third failure in a row, a minute apart, so a passing fault holds none; a call the IC rejects before it runs, as when the canister is out of cycles, is not a failure. After a rollback, a file newer than the release keeps its version: nothing uses it, its members are told it needs a newer release, and `admin_check` says so without holding it, until a release that knows the version runs. A file out of step with its own registry is held as damage. Version 2, the first step, adds the Trash and Spam folders and the senders a mailbox blocks.
- **`admin_check(local, opt table)`** runs SQLite's `quick_check` on a mailbox's file, or on one of its tables. A whole-file check also compares the file's version and counters with the registry. A whole-file check that finds a problem holds the mailbox for repair: nothing uses its file, its mail waits in the queue, and its members can still download the file. A whole-file check that finds the file sound, or a purge, releases it. A step of a schema upgrade that fails three times holds the mailbox too.
- **A download** freezes the mailbox: new mail waits in the queue, and every member's changes answer `downloading:`. The webmail renews the freeze every 2 minutes, and a freeze that is not renewed lapses after 5. No download lasts more than 2 hours. The file is read in chunks of up to 1.9 MB by a query, which answers only while a download is under way and names that download, so the webmail notices when its download ended and another began.
- **A purge** truncates the mailbox's file by at most 1 GiB per `admin_purge` call, then deletes the file and its directory. Its first call removes the members and ends any download. The registry keeps the mailbox's uid and outbox counters, so a mailbox created again at the address never meets an old uid or bridge key, and its `uidvalidity` rises.
- **Folders.** Each message is in the Inbox, Trash or Spam. `mail_move` moves up to 200 messages at a time, and a message keeps the time it left the Inbox, also when it moves between Trash and Spam. Mail in Trash or Spam for 30 days is deleted, up to 20 messages per write, in the write that moves new mail into the mailbox and in `mail_move`; so it waits only while the mailbox neither receives mail nor has mail moved. `mail_delete` deletes for good, and only the messages still in the folder it names, checked in the same write, so mail another member restored meanwhile stays. The unread count, in the registry and in the file, counts the Inbox only. Search covers one folder. Every change of folder raises the message's change counter.
- **Blocked senders** are per mailbox: every member sees the same list, up to 1,000 addresses, and any member can unblock one. Addresses are compared with A to Z lowered. Mail from a blocked address is accepted and filed in Spam: the move puts it there when its envelope sender is blocked, and the parse moves it there when its `From` address is, taking it out of the unread count. Mail already received stays where it is.
- The outbox is a persisted state machine, one per mailbox, keyed by the outbox id. Ids come from a counter in the registry that only rises, so a deleted message's id, and with it its key, never goes to a new one. The bridge key is `<prefix>-<mailbox>-<id>-<generation>`, where the prefix is the time the canister was installed, so a reinstalled canister never reuses a key either, and the generation rises only when a member sends the message again; automatic retries keep the key. The bridge keeps a sent, rejected or unknown result by key for 7 days, and derives the gateway's idempotency key from it, so a retried call never sends twice. The bridge posts again with the same key only in the first eight minutes of the gateway's 10-minute replay window, so every post reaches the gateway while it still holds the key. If a message may have been sent and has no final result by then, it moves to `UNKNOWN` and the user decides; it is never resent automatically. A message still sending after a day becomes `UNKNOWN` without asking the bridge, well inside the 7 days it keeps the result.
- A send's `client_id` is kept in `control.db` per sender for 7 days from the first send. A retry from the same mailbox gets the first message back, even after it was deleted, once it was tried. A retry from another of the sender's mailboxes is refused, even after the message was deleted, because it may have gone out already. A resend from Sent does not renew the 7 days. A message deleted while queued and never tried frees its `client_id`, unless it was a resend.
- Bounces do not reach the canister, and the mail gateway only reports that it accepted a message, so the webmail says "accepted for delivery", never "delivered".
- The webmail renders mail HTML in a `sandbox=""` iframe with its own strict content security policy, and blocks remote content, because a script in a message could otherwise steal the sign-in.
- The webmail shows the delivering domain, as "via example.com", when it differs from the `From` domain, and "via an unnamed domain" when the envelope sender is empty, as it is for delivery reports and some automatic replies. The gateway passes no SPF, DKIM or DMARC result to the canister, and mail services commonly send from their own bounce domain, so a differing domain is no evidence of forgery. Verifying DKIM in the canister would make a real warning possible.
- Every mailbox has a `uidvalidity`, and every message a stable, increasing UID, flags and a change counter, for syncing and for a later IMAP bridge.
- Nothing secret uses libc randomness, which is seeded deterministically; use `raw_rand`.
- Quotas per mailbox, a backlog cap that returns 451, and a long freezing threshold, because a canister that runs out of cycles is eventually deleted with its mail.

## Measurements

Local replica, with limits of 40B instructions per update and 5B per query.

**SQLite and FTS5 on stable memory**, on a 1.09 GB database of 100,000 messages:

| Operation | Instructions |
|---|---|
| Store 2 KB text and 2 KB body, one transaction | 6M to 64M |
| Store 100 KB text and 100 KB body | 73M to 943M |
| Store 100 KB text and a 2 MB body | 138M to 177M |
| List 50 messages (query) | 16M to 40M |
| Search, 50 rows (query) | 191M to 630M |
| FTS merge of 2000 pages | 7.5B to 9.6B |
| Delete 500 messages | 130M |

- Traps injected inside a transaction and after a commit left the database unchanged, and an upgrade left row counts unchanged.
- Deleted pages are reused.
- One file per message was measured and rejected: 37,018 messages of 2 KB used 1.44 GB of canister memory for an 85 MB database, about 36 KB of overhead per file.
- A `quick_check` of the whole 1 GiB database, and FTS5's integrity check, exceed 40B instructions; a `quick_check` of a 200 MB `bodies` table took 21B. This is what one database per mailbox fixes: see the next table.

**One database per mailbox** (v0.2.0), from `test/canister/test_storage.py` and `test_check.py`; the design's prototype measurements are in [storage-per-mailbox.md](storage-per-mailbox.md):

| Operation                                              | Instructions                                      |
|--------------------------------------------------------|---------------------------------------------------|
| `smtp_request` to 10 recipients, 2 KB                  | 12.1M                                             |
| `smtp_request` of 100 KB                               | 22.1M                                             |
| Move a 100 KB message into its mailbox (`ingest_move`) | 16.9M                                             |
| `post_upgrade`                                         | 4.9M                                              |
| `admin_check` of a whole file                          | 15.3M per MB, so about 2.6 GB in one call         |
| `admin_check` of the search index                      | 47.5M per MB of file, so about 0.8 GB in one call |

- An empty mailbox file takes 72 KiB.
- The tests fail when one of the first four costs passes its bound (15M, 50M, 30M and 10M), or when a whole-file check of a 2 GiB file would no longer fit in one call.

**MIME parsing** with libetpan, on 5,000 generated messages, 10% of them malformed:

- All parsed in wasm, matching native results; 5,000 mutated messages caused no trap.
- 100,000 native mutations under AddressSanitizer and UndefinedBehaviorSanitizer found no error, and a leak check found none.
- A 1,996,800-byte message with a base64 attachment parsed in 264M instructions.
- Nesting of 200 and 5,000 levels is rejected cleanly.
- libetpan calls some functions through cast pointers, which WebAssembly rejects when the signatures differ; `vendor/libetpan/PATCHES.md` lists the fixes.

**Gateways, on mainnet:**

- Inbound mail was stored once, with the correct envelope sender and headers. Mail to an unknown address was refused with 550 and bounced to the sender. The gateway delivers headers and body separately, so the `Content-Type` header with the MIME boundary is stored with the body.
- Outbound mail through the relay bridge passed DKIM, SPF and DMARC at a large mail provider. A repeated `outboxId` returned the stored result and only one copy arrived. A 1,400,000-byte attachment arrived intact.
- The bridge builds the gateway's JSON itself, because a generated JSON client exceeded the instruction limit at that size, and a 2 MB request costs about 16 billion cycles, which a Caffeine engine pays.
- The mail gateway adds an open-tracking pixel to every message, and replaces the `Message-ID`, so replies may not thread in the recipient's mail program. Outbound mail is HTML only.

## Known limits

- The DFINITY SMTP gateway is labelled a proof of concept, with no service level agreement. Inbound mail depends on it.
- Spam protection is the gateway's SPF and DKIM checks plus allow and block rules, and each mailbox's blocked senders, whose mail goes to Spam; there is no content filtering.
- Node operators can read canister memory, and the mail gateway's operator can read outbound mail.
- Messages over about 2 MB are refused.
- A whole-file `admin_check` fits in one call for a mailbox file up to about 2.6 GB, and a check of the search index alone up to about 0.8 GB. The quota counts message bytes, and a file of small mail is about 1.4 times those, so a mailbox of small mail filled to the default 2 GiB quota is a file of about 3 GB, which one call cannot check. Mail with large attachments fills the quota with a file barely larger than its bytes.
- A downloaded mailbox file opens with any SQLite 3. Its search index, `fts`, uses FTS5's `contentless_delete=1`, so querying it needs SQLite 3.43 or newer.
- An empty mailbox file takes 72 KiB, and the file system adds its own overhead: the prototype measured 112 KiB of stable memory per mailbox. Delivering to several recipients costs several times as many instructions as in v0.1.x, because a message is written to the queue and then into each mailbox in a call of its own; the table above has the measured costs.
- The relay does not support `In-Reply-To`, `References`, `Reply-To`, custom headers, a text part, or delivery status.
- Charsets: UTF-8, US-ASCII, ISO-8859-1 to -16, Windows-1250 to -1258, KOI8-R, KOI8-U, ISO-2022-JP, Shift_JIS, EUC-JP, GB2312, GBK, GB18030, Big5 and EUC-KR are decoded (see `shims/charconv.c` and `test/test_charsets.py`); others fall back to ISO-8859-1.
