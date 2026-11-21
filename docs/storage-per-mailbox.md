# Storage: one SQLite database per mailbox

The result of a design sprint, 2026-11-14. It answers whether each mailbox should get its own SQLite database, instead of one `mail.db` for the whole canister. Every number comes from a prototype measured on a local replica, unless it cites design.md or a price.

## What v0.2.0 built

v0.2.0 follows this recommendation, with one change: **there is no migration from `mail.db`.** The deployments were small and early, so they are reinstalled and their mailboxes recreated. Answer 10, the migration's caps in answer 1, ATTACH, M12 and the legacy read path below therefore do not apply, and `post_upgrade` refuses a canister that still holds a `mail.db`. [design.md](design.md) describes what was built.

The items this document left to the implementation design were settled as follows:

| Item                                        | Settled                                                                                                                                                                                                             |
|---------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| A queued message whose move was quarantined | It stays in the queue, charged to the quota and counted against the mailbox's cap. Admins see it counted apart from failed parses, and `admin_retry_moves` queues it again. A purge deletes it.                     |
| A file waiting for a schema change          | The registry keeps each file's version. The ingest pump upgrades a file before it moves or parses into it, and meanwhile the owner's calls answer `busy:`. A step failing thrice holds the mailbox.                 |
| The quota of a mailbox not migrated yet     | Does not arise: there is no migration.                                                                                                                                                                              |
| A migration step that traps every time      | Does not arise. A move or parse that traps three times quarantines its message, and the pump goes on.                                                                                                               |
| The export freeze's maximum                 | Each freeze or renewal holds for 5 minutes, the webmail renews every 2, and no download lasts more than 2 hours from its start.                                                                                     |
| Purge                                       | One path for every size: each call truncates the file by at most 1 GiB, then the file and its directory are deleted.                                                                                                |
| The consistency check                       | `admin_check`, a controller-only update call: `quick_check` of the file or of one table. A whole-file check also compares the file's counters with the registry.                                                    |

One more difference from answer 1: the canister-wide backlog cap counts only mail the pumps can work on now. Mail for a mailbox that is being downloaded, held for repair, or whose file cannot be opened counts only against that mailbox's cap, and so do its quarantined moves.

The upstream stable-fs issue for a missing name is still open, with no fix under way, and its maintainers suggest folders for now (stable-fs#29). So the files fan out over small directories as rule 2 describes.

## Recommendation

**Adopt one database per mailbox, with a control database beside the mailbox files, in v0.2.0.** Do it before shared mailboxes are built, because both rework the same store code, and before the live mailboxes grow, because moving existing mail means indexing it again.

The gains:
- A search costs only the mailbox's own mail.
- A consistency check of one mailbox can fit in one call. A 50,000-message mailbox of 65 MB took a tenth of the limit. From that one point, the limit lies near a 650 MB file of small mail, which a mailbox reaches at about 460 MB of quota, a fifth of the default 2 GiB; it needs measuring before checks rely on it.
- A backup is the mailbox's own SQLite file.
- A purge is one file delete, for files up to a size still to be measured: about 2.4 GB by extrapolation.
- A mailbox can move to another canister as a file.

The costs:
- 112 KiB of stable memory per mailbox.
- Opening a mailbox that is not open yet: up to 3.6M instructions in an update call, 5M to 12M in a query.
- Each message is written twice: queued at delivery, then moved into its mailbox, at 7M to 16M per recipient. Mail for 10 recipients costs about 6 to 9 times today's delivery (con 3).
- A rewrite of the store layer.

The design must follow seven rules, each forced by a measurement below. The next section lays out the files in detail.

1. **A control database**, `control.db`, holds:
   - the settings;
   - the mailbox registry, with each mailbox's quota, usage, uid and outbox counters, and write generation;
   - the queue of incoming mail;
   - the dedupe keys of each mailbox's recent deliveries;
   - a work index: each mailbox's messages waiting to be indexed, its messages indexed since its last index merge, and when its outbox is next due.

   Timers schedule their work from this database alone, and the backlog cap and `post_upgrade` read only it, apart from the one-time migration from `mail.db` (answer 10). The work itself opens the mailbox files. The backlog cap stays canister-wide, and a cap per mailbox is added (answer 1).
2. **Mailbox files fan out over small directories:** `m/<id / 100>/<id>/mail.db`. stable-fs scans a whole directory to look up a name that does not exist, and SQLite looks up a `-journal` file on every open (M13). A file per mailbox in buckets of 100, `m/<id / 100>/<id>.db`, would save each mailbox's 16 KiB directory, but add about 2M to every open; the measurements used the directory.
3. **A file is open in one connection at a time,** its own or attached to another. With `locking_mode=EXCLUSIVE`, a second connection to a file never sees the first one's writes, and works on stale pages.
4. **A small cache of open connections,** each with a 1 MiB page cache. Today's 16 MiB per connection would cost 17 MB of heap for each open mailbox (M3).
5. **Delivery writes only to `control.db`.**
   - `smtp_request` queues the message for all its recipients in one transaction. Delivery therefore stays a single commit, all-or-nothing, without a trap.
   - The ingest timer then moves the message into each recipient's file, one call at a time (M14).
   - Parsing, indexing and quarantine run on the file, as they run on `mail.db` today.
6. **An export reads the live file while the mailbox is frozen** (answer 7). A `VACUUM INTO` snapshot would avoid the freeze, but one call holds only about 1.6 GB of ordinary mail, less than the default quota of 2 GiB (M8).
7. **Search index merges run per mailbox,** scheduled from the work index. Automatic merges stay off, as today.

These conditions would change the recommendation:
- **A target of millions of mailboxes per canister.** 112 KiB per mailbox is 107 GiB per million.
- **Purges of full mailboxes turning out costly.** One call deletes a file of about 2.4 GB of small mail (M7). A file is about 1.4 times the bytes its quota counts, because of the search index and the page overhead, so a mailbox of small mail at the default quota of 2 GiB is a file of about 3 GB. Its purge needs a paged truncate first, which was not measured.
- **Opening a mailbox turning out costly at real traffic.** Raise the connection cap first.

## The file layout in the canister

### From SQLite to stable memory

The canister has no disk. Each layer below hands its file calls to the next one:

| Layer                    | What it does                                                                     |
|--------------------------|----------------------------------------------------------------------------------|
| SQLite                   | one connection per open file, in the heap                                        |
| `src/store/sqlite_vfs.c` | the VFS: hands `open`, `pread`, `pwrite`, `unlink` and `stat` to the POSIX layer |
| ic-wasi-polyfill         | POSIX file calls for wasm                                                        |
| stable-fs 0.13.1         | a file system in stable memory: directories, files, a free list of chunks        |
| stable memory            | grows in 8 MiB buckets and never shrinks                                         |

stable-fs gives every file and every directory a 16 KiB metadata chunk, and stores file data in 16 KiB chunks. The chunk size is set once, before the first file exists, and ic-wasi-polyfill's init takes no chunk size (ic-wasi-polyfill#31), so every canister built today uses 16 KiB, and the figures in this document are at 16 KiB. stable-fs's maintainers chose 16 KiB to make chunk lookups faster, and suggest 4 KiB for many small files. Which size suits mailbox files, from an empty mailbox to about 3 GB, is to be measured in the build toolchain. A deleted file's chunks go to the free list, and any file can reuse them (M7). Today the canister keeps one file, `mail.db`.

### The tree

```text
/                         stable-fs root
├── control.db            the control database, one per canister
├── mail.db               today's database, only until the migration ends (answer 10)
└── m/                    the mailbox files
    ├── 0/                bucket 0: mailbox ids 0 to 99
    │   ├── 1/
    │   │   └── mail.db   mailbox 1
    │   └── 2/
    │       └── mail.db   mailbox 2
    ├── 1/                bucket 1: mailbox ids 100 to 199
    │   └── 100/
    │       └── mail.db   mailbox 100
    └── …
```

- **Path rule:** a mailbox's file is `m/<id / 100>/<id>/mail.db`, where `id` is its row id in the registry. A path is built only from that integer, never from the address or the principal. So no input can steer a path, and a renamed address keeps its file.
- **Buckets** hold at most 100 mailbox directories, and each mailbox directory holds one file. stable-fs scans a whole directory to look up a name that does not exist, at about 21K instructions per entry. SQLite looks up `mail.db-journal` on every open, and with `journal_mode=MEMORY` that file never exists. So the directory around each file is kept to one entry: the missing lookup costs 2.3M instead of 43M beside 2,000 files, or 204M beside 10,000 (M13).
- **The top level `m/`** gains one entry per 100 mailboxes: 100 entries at 10,000 mailboxes, 10,000 at a million. Only creating a new bucket looks up a missing name there, once per 100 mailboxes. One question is open: stable-fs's maintainers describe the lookup of an existing name as linear, with the name cached once its file is open (stable-fs#30), while its source finds an existing name through its `direntry_lookup` index and scans only when that misses (`find_entry_index`, traced in stable-fs#29). M13 looked up an entry near the front of its directory, so it does not settle this. The capacity measurement planned for v0.3.0 looks up the last bucket of a large `m/`.
- **A purge** first closes the file's cached connection, then deletes `mail.db` and its mailbox directory. The bucket stays. A new owner of the address gets the same registry row, so the same path, and a new file.

Layouts measured and rejected:

| Layout                     | Why not                                                                                      |
|----------------------------|----------------------------------------------------------------------------------------------|
| `m/<id>.db`, one directory | every open scans all mailbox files for the missing journal: 204M at 10,000 (M13)             |
| `m/<id / 100>/<id>.db`     | saves the 16 KiB mailbox directory, but every open scans 100 entries, about 2M more          |
| `m/<id>/snap.db` snapshots | `VACUUM INTO` holds only about 1.6 GB of small mail per call (M8); an export freezes instead |

### What `control.db` holds

It is open for the canister's lifetime, and it is the only file that timers, the backlog cap and `post_upgrade` read to decide what to do next.

| Table          | Rows                                       | Columns, and what they are for                                                                                                                                                                                                                                  |
|----------------|--------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `settings`     | one per key                                | domain, relay bridge principal, outbox prefix: as in `mail.db` today                                                                                                                                                                                            |
| `mailboxes`    | one per mailbox, kept after a purge        | the registry: `local`, `principal`, `disabled`, `quota_bytes`, `used_bytes`, `message_count`, `uidvalidity`, `next_uid`, `modseq`, the next outbox id, the write generation, the state (active, frozen with its reason and deadline, purging, not yet migrated) |
| (work index)   | columns of `mailboxes`, partial indexes    | messages queued, messages waiting to be parsed, messages indexed since the last merge, the next outbox time due                                                                                                                                                 |
| `queue_bodies` | one per incoming message                   | `raw` and the number of recipients still to move; deleted with the last one                                                                                                                                                                                     |
| `queue`        | one per message and recipient              | `mailbox_id`, `body_id`, `envelope_from`, `dedupe_key`, attempts; `UNIQUE(mailbox_id, envelope_from, dedupe_key)`                                                                                                                                               |
| dedupe keys    | one per recent delivery                    | `mailbox_id`, `envelope_from`, `dedupe_key`, time; kept longer than the gateway retries, then pruned                                                                                                                                                            |
| held results   | one per outbox result for a frozen mailbox | outbox id, generation, outcome; applied at the thaw                                                                                                                                                                                                             |

The spike built `settings`, `mailboxes` with the `queued` and `next_due_ns` columns of the work index, `queue_bodies` and `queue`. The other tables follow from the design questions.

### What a mailbox file holds

Today's schema, without `settings` and `mailboxes`, and without the `mailbox_id` column, because the file is the mailbox:

| Table                | Columns, and what they are for                                                                                                                                                                                                            |
|----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `counters`           | one row: `used_bytes`, `message_count`, `uidvalidity`, `next_uid`, `modseq`. The file's own mail only, written in the same call as the registry, which also counts the mail still queued for it. A downloaded file is complete on its own |
| `messages`           | as today: `uid` (`UNIQUE`), `state`, `flags`, `modseq`, the envelope, the parsed headers; `UNIQUE(envelope_from, dedupe_key)`                                                                                                             |
| `bodies`             | `raw` message bytes, by message id                                                                                                                                                                                                        |
| `fts`                | the FTS5 search index: contentless, automatic merges off                                                                                                                                                                                  |
| `outbox`             | as today, plus the stored key prefix (answer 4)                                                                                                                                                                                           |
| `outbox_bodies`      | the HTML of each sent message                                                                                                                                                                                                             |
| `outbox_attachments` | each sent attachment                                                                                                                                                                                                                      |

`PRAGMA user_version` records each file's schema version (answer 6).

### How each file is opened

Every file gets today's settings: `page_size=4096`, `locking_mode=EXCLUSIVE`, `journal_mode=MEMORY`, `synchronous=OFF` and `temp_store=MEMORY`. The page cache differs:

| File         | Page cache       | Connection                                                                                   |
|--------------|------------------|----------------------------------------------------------------------------------------------|
| `control.db` | 16 MiB, as today | always open                                                                                  |
| mailbox file | 1 MiB            | in a cache of 32 to 64 connections, least recently used out first; 1.06 MB of heap each (M3) |

At most one connection holds a file at a time, its own or an ATTACH to another (rule 3). With `locking_mode=EXCLUSIVE`, a second connection would read stale pages. Updates open a file for up to 3.6M, queries for 4.7M to 11.7M (M2). A query can use a connection that an update left open, but connections it opens itself are gone after the query.

### What a mailbox costs in stable memory

| Part                                    | Size                        |
|-----------------------------------------|-----------------------------|
| the mailbox directory's metadata chunk  | 16 KiB                      |
| `mail.db`'s metadata chunk              | 16 KiB                      |
| `mail.db` with its empty schema, 68 KiB | 80 KiB, in five data chunks |
| its share of its bucket's directory     | about 0.16 KiB              |
| **Measured per empty mailbox (M1)**     | **112 KiB**                 |

At 10,000 mailboxes that is 1.07 GiB of stable memory before any mail. A file grows in 16 KiB chunks as mail arrives, at about 1.4 times the bytes the quota counts, because of the search index and the page overhead.

## What was measured

The prototype is on branch `spike/per-mailbox-db`, commit `dc1b0c3`:
- `src/spike/spike_api.cpp` adds `spike_*` methods to the test build only.
- `test/canister/test_spike_storage.py` drives them.
- `test/canister/spike-storage-results.json` holds the raw results of the run quoted here.

To reproduce:

```bash
git checkout spike/per-mailbox-db
make build-test
icp network start -d
SPIKE_STORAGE=1 pytest -s --network=local --identity=email-canister-test test/canister/test_spike_storage.py
```

The run reinstalls the test canister, takes about four minutes, and writes its results to `build/spike-storage.json`.

The prototype has three parts:
- **`control.db`:** the registry, the queue and the work index.
- **10,000 empty mailbox files.**
- **Three larger mailboxes:**
  - 50,000 indexed messages of about 1 KB each, which made a 65 MB file;
  - 100 messages;
  - 1 GB of 1 MB bodies.

Each layout was seeded with the same 50,000 messages, through `dev_seed` for `mail.db` and `spike_seed` for a mailbox file. The limits are 40B instructions per update and 5B per query.

| #   | Measurement                                               | One database per mailbox                                                                                    | Today, one `mail.db`                                        |
|-----|-----------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------|
| M1  | Stable memory per empty mailbox, at 10,000                | 112 KiB, so 1.07 GiB for 10,000; the SQLite file itself is 68 KiB                                           | one row                                                     |
| M1  | Create a mailbox file with its schema                     | 12M                                                                                                         | one row                                                     |
| M13 | Look up a missing name in one flat directory              | 21K per entry: 12M at 500 files, 22M at 1,000, 43M at 2,000                                                 | one file                                                    |
| M13 | The same lookup in the fanned-out layout                  | 2.3M                                                                                                        |                                                             |
| M2  | Open a mailbox file, in a query                           | 4.7M empty; 11.7M at 50,000 messages, then 11.8M for its first query                                        | stays open                                                  |
| M2  | Open a mailbox file, in an update                         | up to 3.6M per file: 1.4M to 3.6M in M4, within noise in M14                                                | stays open                                                  |
| M3  | Heap per open connection                                  | 1.06 MB at a 1 MiB cache; 17 MB at today's 16 MiB                                                           | one connection                                              |
| M4  | Deliver 2 KB to 10 recipients, queued in control.db       | 3.8M                                                                                                        | 8.0M                                                        |
| M4  | Deliver 100 KB to 10 recipients, queued                   | 8.7M                                                                                                        | 28.7M                                                       |
| M4  | Deliver to 1 recipient, queued, 2 KB and 100 KB           | 2.4M and 9.4M                                                                                               | 2.8M and 6.0M                                               |
| M4  | Deliver 2 KB to 10, straight into each file               | 15.4M on open connections, 35.5M opening each, 90.7M by ATTACH                                              |                                                             |
| M14 | Move one queued message into its mailbox file             | 7.1M at 2 KB, 15.6M at 100 KB; 7.7M and 15.5M opening the file                                              |                                                             |
| M5  | Search a common word, 50 hits, 50,000 messages            | 22.6M with the open, 1.6M on an open connection                                                             | 18.1M                                                       |
| M5  | Search a rare word, 1 hit                                 | 23.0M with the open, 0.3M on an open connection                                                             | 12.1M                                                       |
| M5  | List the 50 newest messages                               | 14.0M with the open                                                                                         | 16M to 40M (design.md)                                      |
| M6  | Search a word only other mailboxes contain                | 8.5M with the open, 0.1M on an open connection                                                              | 566M next to 50,000 foreign hits: 11K per hit, in 3B pages  |
| M7  | Purge a 65 MB mailbox of 50,000 messages                  | 1.05B, one file delete                                                                                      | about 13B in paged steps (design.md: 130M per 500 messages) |
| M7  | Purge a 1 GB mailbox                                      | 14.8B for large bodies; for small mail 16B per GB, so a file of about 2.4 GB per call                       |                                                             |
| M7  | Reuse of freed memory                                     | refilling 500 MB after a 1 GB delete grew stable memory by 0 bytes                                          | free pages are reused within `mail.db`                      |
| M8  | Read a 1.9 MB export chunk                                | 12M per query; 1 GB is 553 queries                                                                          | needs a copy first (M12)                                    |
| M8  | Snapshot, `VACUUM INTO`                                   | 1.6B for 64 MB of small mail (25B per GB); 18.3B for 1 GB of large bodies                                   |                                                             |
| M8  | The downloaded backup, of the live file and of a snapshot | both open in SQLite 3.50.2: `integrity_check` ok, all 100 messages, search works                            |                                                             |
| M9  | Schema change (`ALTER TABLE ... ADD COLUMN`)              | 3.4M per file, on empty files                                                                               | one change                                                  |
| M10 | Re-arm the timers after an upgrade                        | 3.5M from the work index, the same for any number of mailboxes                                              | reads `mail.db`                                             |
| M10 | The same without a work index                             | 2.2M per file: 22B for 10,000 files, which fits `post_upgrade`'s larger limit, but grows with every mailbox |                                                             |
| M11 | `quick_check`                                             | 4.0B for 50,000 messages; 0.46B for 100 MB and 4.9B for 1 GB of large bodies                                | over 40B for a 1 GiB database (design.md)                   |
| M12 | Move mail from `mail.db` into a mailbox file              | 0.74B per 1,000 messages, copied and indexed again                                                          |                                                             |

Notes:
- **What the 112 KiB holds.** It includes the mailbox's directory and its share of its bucket.
  - stable-fs gives every file and every directory a 16 KiB metadata chunk.
  - It stores data in 16 KiB chunks.
  - It grows stable memory in 8 MiB buckets.
  - A fresh install already holds 72 MiB of stable memory.
- **Storage cost.** At 127,000 cycles per GiB per second on a 13-node subnet, 10,000 empty mailboxes cost about 4.3T cycles a year.
- **A flat directory of 10,000 files (M13).** An earlier run of the prototype kept all files in one directory. There, opening `control.db` beside 10,000 mailbox files cost 204M, in line with 21K per entry. That run's results were not kept, so the table's measurements stop at 2,000 files.
- **Cold costs vary between runs (M2, M5).** Opening the 65 MB file and searching it for a common word cost 12.7M, 26.0M and 22.6M in three runs. Costs on an open connection were steady.
- **Why opening costs more in a query (M2).** A query measured 4.7M to open an empty file. An update opening a file for a delivery added 1.4M to 3.6M per file (M4). The prototype does not explain the difference. In M14, a move that opened the file cost 0.6M more at 2 KB, and 0.1M less at 100 KB, so that difference is within the noise of one sample.
- **Why a query on a closed mailbox pays the open.** A query runs on a copy of the canister's state, so the connections it opens are gone afterwards. A query can use a connection that an update left open.
- **Queuing and today's delivery (M4).** The queue stores the body once for all recipients, and `mail.db` once per recipient. So the queuing call costs about the same for any number of recipients. At 100 KB, its one sample for 10 recipients (8.7M) even came out below the one for a single recipient (9.4M). Queuing is cheaper than today's delivery for several recipients, but dearer for one large message: 9.4M against 6.0M at 100 KB. The move comes on top (con 3).
- **What the move does (M14).** It reads the body from the queue, inserts it into the file after checking the file for a duplicate, then removes the queue row and, with the last recipient, the body. MIME extraction then runs as it does today. design.md does not measure it for small messages; a 2 MB message parsed in 264M.
- **What a real migration costs (M12).** The figure indexes plain text bodies. Real mail also needs MIME extraction. `mail.db`'s search index is contentless, so it cannot be copied over. The step ATTACHes the mailbox file to `mail.db`'s connection while no other connection holds it.
- **What `quick_check` costs (M11).** The cost grows with both the rows and the bytes: about 80K per small message, or 62B per GB of small mail, and about 5B per GB of large bodies. Neither figure covers FTS5's own integrity check.

## Pros

1. **A search costs only the mailbox's own mail (M5, M6).** Today one search index spans the canister, and a search checks every hit against the mailbox (`src/store/mail_store.cpp`, `search`).
   - A mailbox without hits paid 566M next to 50,000 foreign hits, about 11K per hit, so it grows with every other user's mail.
   - Above about 260,000 foreign hits, one page no longer fits its 3B budget.
   - In the mailbox's own file, the same search cost 8.5M with the open.
2. **A consistency check of one mailbox can fit in one call (M11).** The 50,000-message mailbox of 65 MB took 4.0B. Today a `quick_check` of the whole database exceeds 40B, and no check runs at all.

   A straight line through this one point reaches the 40B limit at about 500,000 small messages, a file of about 650 MB, with no margin. A file is about 1.4 times the bytes the quota counts: 46 MB of messages made the 65 MB file. A mailbox filled to the default quota of 2 GiB with small mail is then a file of about 3 GB and would need about 186B, so a full check fits only mailboxes up to about a fifth of their quota. Mail with large bodies costs far less, about 5B per GB.

   Where the limit lies is not settled, though. design.md measured 21B for one 200 MB `bodies` table, about 105B per GB, 1.7 times this prototype's rate. Measure the limit before checks rely on it.

   A bigger mailbox can be checked a table at a time with `PRAGMA quick_check(<table>)`, but such a partial check misses damage that spans the file, such as a page that two tables both use.
3. **A backup is the mailbox's own SQLite file (M8).** It is read in queries of 12M per 1.9 MB. The downloaded live file opened in SQLite 3.50.2, passed `integrity_check`, and searched like the original. This is the backlog item "Download a mailbox's SQLite database".
4. **A purge is one file delete (M7),** for files up to about 2.4 GB, and any mailbox can reuse the freed memory. Today's paged purge would cost about 12 times as much, scaled from design.md's 130M per 500 messages. That figure was measured on larger messages, and the prototype did not measure today's purge on its own mail, so the factor is rough.
5. **Isolation at the SQL level.** A mailbox's queries run on a connection that holds only its file. A query missing `mailbox_id = ?` can no longer reach another user's mail. This guards against bugs in queries. It does not guard against bugs in the canister as a whole: there is still one heap and one wasm.
6. **A mailbox moves to another canister as its file and its registry row.** That is the managed-service plan of several canisters behind one SMTP handoff canister. The target keeps the row's uidvalidity and counters, and gives the mailbox a new id. Its outbox rows keep their stored key prefixes (answer 4), and only new sends use the new id. The target talks to its own relay bridge, which holds no results for the source's keys, so a mailbox moves only when none of its sends is in flight or has an unknown outcome.
7. **Encryption at rest, keyed per user** (self-hosting track), becomes a key per file in the VFS.
8. **Schema changes run in pages (M9).** Each file carries its own version.
9. **The SMTP gateway's call may do less work for several recipients (M4).** The prototype's queuing stored one body for all of them: 3.8M instead of 8.0M for 10 recipients of 2 KB, and 8.7M instead of 28.7M at 100 KB. It skipped the dedupe keys, the backlog counts and the work index, which the real call adds, so the gain will be smaller. The moves that follow cost more in total (con 3).

## Cons

1. **Memory: 112 KiB per mailbox (M1).** That is 1.07 GiB for 10,000 mailboxes, empty, and about 4.3T cycles a year at that size.
2. **Opening costs (M2, M5).** A query on a mailbox with no open connection pays 4.7M to 11.7M to open it. A first search of a 65 MB mailbox cost 22.6M to 23.0M, against 12.1M to 18.1M in `mail.db`. On an open connection, it cost 0.3M to 1.6M. Every result stays far below the query limit.
3. **Each message is written twice (M14).** Moving a queued message into a recipient's file costs 7.1M to 15.6M. That comes on top of the MIME extraction ingest already does, and a message for 10 recipients pays it 10 times. 2 KB to 10 recipients costs about 75M in all, 3.8M to queue and 10 moves of 7.1M, against 8.0M today. At 100 KB it is 165M against 28.7M. The work moves out of the SMTP gateway's call into timer calls, but it grows about 6 to 9 times.

   These are lower bounds. The prototype's queuing skips the dedupe keys, the backlog counts and the work index, and its move skips the dedupe key, the registry's counters and the write generation.

   Writing each file at delivery would avoid the move, but it costs 15.4M to 90.7M for 10 recipients. It also cannot stay all-or-nothing without a trap, because one file's commit cannot be undone after another file's commit fails.
4. **A full consistency check still has a size limit (M11).** A file of about 650 MB of small mail, which a mailbox reaches at about a fifth of the default quota. Larger mailboxes need the partial checks of pro 2.
5. **Heap per open connection (M3).** That needs a cap on open connections and a 1 MiB page cache. At today's 16 MiB, 4 connections to the 65 MB mailbox took 65 MB of heap.
6. **stable-fs's lookup of a missing name scans its directory (M13).** That forces the fanned-out layout, and its directories take part of the 112 KiB. The fix belongs upstream, in stable-fs.
7. **One connection per file, enforced by the code.** A second connection, including an ATTACH, silently reads stale pages. Today's single connection never meets this.
8. **Limits per call (M7, M8).**
   - A snapshot holds about 1.6 GB of ordinary mail, so an export freezes the mailbox instead.
   - A file delete holds about 2.4 GB of small mail, less than a mailbox at the default quota. Larger files need a paged truncate, which was not measured.
9. **Deduplication changes beyond a window.** Today a redelivery is found as long as the first copy exists. With the queue, `smtp_request` sees only the recent keys in `control.db` (answer 1). An older duplicate is still dropped, but by the move, after its bytes were reserved: a nearly full mailbox may answer 452 to it.
10. **A larger store layer.** Every store function takes a connection.
   - Ids become (mailbox, id).
   - The bridge key gains the mailbox.
   - The registry and the work index must change in the same call as the file they describe, or they drift.
   - Each mailbox schedules its own index merges.
   - The live deployments need a paged migration that indexes their mail again, and until it ends, the store layer serves both layouts.

## The three options

| Question                 | (a) Keep `mail.db`, add a paged export  | (b) One database per mailbox (recommended) | (c) One canister per mailbox                             |
|--------------------------|-----------------------------------------|--------------------------------------------|----------------------------------------------------------|
| A search costs           | the mailbox plus every foreign hit (M6) | the mailbox only                           | the mailbox only                                         |
| Consistency check        | over the limit for the whole database   | 4.0B per 50,000 messages                   | as (b)                                                   |
| Backup as a SQLite file  | copy and index again: 0.74B per 1,000   | a read of the frozen file, 12M per 1.9 MB  | as (b)                                                   |
| Purge                    | paged SQL delete, about 13B per 50,000  | one file delete, 1.05B                     | delete the canister                                      |
| Isolation                | a `mailbox_id` filter in every query    | a connection per mailbox                   | separate memory and code                                 |
| Move to another canister | export, then import                     | copy the file                              | nothing to move                                          |
| Memory per mailbox       | a row                                   | 112 KiB                                    | a canister, with 72 MiB of stable memory after install   |
| Work to build            | small                                   | the store layer, and a migration           | a handoff canister, provisioning, N upgrades per release |

Option (c) gives the strongest isolation, but every mailbox pays a canister's creation fee and base memory. Every release also needs one upgrade per mailbox. It suits a paid tier more than the default. Option (a) is the cheapest to build, but it leaves search, checks and moves where they are today.

## Answers to the design questions

1. **Where queued mail waits: in `control.db`.**
   - **Deduplication comes first, as today.** `smtp_request` checks each recipient against `control.db`'s dedupe keys of recent deliveries, kept longer than the gateway retries, and against the queue, which is unique per mailbox, sender and key. A recipient that already has the message is skipped without reserving bytes, and a redelivery that skips every recipient answers 250.
   - It then checks each remaining recipient's quota against the registry, and answers 452 when one is full, as today.
   - **Two backlog caps.**
     - The canister-wide cap stays, as today, so a flood cannot run the canister out of cycles. It counts all queued mail, held or not, and the mail waiting to be parsed, with a limit that leaves room for the mail held for frozen mailboxes.
     - A cap per mailbox bounds the mail held for a frozen or unmigrated mailbox.
     - During the migration, the canister-wide cap leaves out the mail held for unmigrated mailboxes, so it cannot refuse all mail for the length of the migration. Their per-mailbox caps bound that mail instead, at the number of mailboxes times the cap.
     - Either cap answers 451. `smtp_request` answers once per message, so a message to a mailbox over its cap is refused for all its recipients, as a full mailbox's 452 refuses it today. So a mailbox over its cap blocks every message that includes it, and leaves messages that do not alone. The canister-wide cap refuses all mail, as today.
     - The migration's copies count against neither cap: the migration parses and indexes them itself (answer 10).
   - It stores the body once, with a row for each remaining recipient, in one transaction (M4). A body with no remaining recipient is not stored.
   - A failed `BEGIN`, insert or `COMMIT` answers 450 without a trap, as today.
   - **The ingest timer moves one recipient row per call** into that mailbox's file with `state = 0`, then removes the row. The body leaves the queue with its last recipient (M14).
   - The move checks the file for the message, as `insert_message` checks `mail.db` today. A duplicate found there is dropped, and its reserved bytes go back.
   - The move commits the file first and `control.db` second. If the second commit fails, the call traps, so both roll back and the move is retried.
   - Moves claim their row first, in a call of their own, as parsing does today, so a move that traps is counted. After three traps the row is quarantined in `control.db`, and the rows behind it move on.
   - Parsing and indexing then run on the file, as they do today, from the work index's count of waiting messages. After three failures a message is quarantined in its file and stays viewable, as today.
2. **Delivery to several recipients.**
   - The queue covers it: `smtp_request` writes only to `control.db`.
   - Each move uses its mailbox's cached connection, never ATTACH. ATTACH costs 1.8 to 2.6 times as much as opening each file (M4), and on a file that has its own connection it breaks rule 3. Only the migration ATTACHes, while the file has no other connection (answer 10).
   - A trap during a move or a parse rolls back that one call, as today, and the work is retried.
3. **Connections.**
   - Cache 32 to 64 connections, least recently used out first, each with `cache_size=-1024`. That is 35 to 70 MB of heap.
   - Updates reopen a file for up to 3.6M. The cache matters most to queries, which can use a connection an update left open.
   - `control.db` stays open.
   - No `pre_upgrade` is needed: each committed call leaves every file consistent.
4. **Ids and keys.**
   - `ingest_process` takes a mailbox and a message id. A move takes the id of a queue row.
   - **Each outbox row stores its key prefix**, `prefix-<mailbox>-<outbox id>`, when it is created, and each send appends the current generation. A resend raises the generation, as today, so it still gets a new key.
   - Today the key is not stored but built from the global outbox id: `prefix-<global id>-<generation>`, and from v0.1.4 `prefix-<global id>-<created ns>-<generation>` for messages created since. The migration stores each row's current key without its generation as the row's prefix, in whichever of the two forms the row has. Each mailbox's new outbox counter starts at v0.1.4's `outbox_next_id` or above the largest outbox id in `mail.db`, whichever is higher, so new ids never meet migrated or deleted ones. A send in flight or with an unknown outcome is then never sent twice under a new key.
   - Outbox ids from the registry's counter never repeat. Before v0.1.4 the global ids could: `outbox.id` has no `AUTOINCREMENT`, so the id of a deleted newest row, and with it its bridge key, went to the next send. v0.1.4 fixes that bug with a counter in `settings` that only rises, and adds the message's creation time to the key for the first message after the upgrade, which can still get such an id.
   - Message uids are already per mailbox. Outbox ids become per mailbox, which the webmail never compares across mailboxes.
   - **Uids and outbox ids come from counters in the registry row, which a purge keeps.** A new file continues from them, so a purged address that gets a new owner never reuses a uid or a bridge key. Otherwise the bridge would return the old owner's stored result for the new owner's first send. As today, a new owner also gets a higher uidvalidity.
   - The mailbox API keeps its Candid types. Only internal methods change.
5. **Quotas and totals.**
   - The registry row in `control.db` holds `used_bytes` and `message_count`. Delivery adds to them in the queue's transaction. A move charges nothing more; it gives the bytes and the count back only for a duplicate.
   - So quota checks, `smtp_request_validate` and the admin totals never open a mailbox file.
   - The mailbox file keeps its own counters. Moves, deletes, and the outbox's reservations and releases of quota update the file's counters, and the registry row where it changes, in the same call, committing the file first and trapping if `control.db`'s commit fails.
6. **Schema changes.**
   - Each file keeps its `user_version`.
   - A timer migrates the files right after an upgrade. An `ADD COLUMN` costs 3.4M on an empty file (M9). It does not rewrite the rows, so on a large file only the open adds to it, up to about 3.6M in an update (M2), and an update can migrate a file before it writes it. A change that adds an index or rebuilds a table costs in proportion to the file. It needs its own paging within a file, and pages of files sized from its own measurement, and only the timer runs it. An index whose whole build on a 2 GiB file fits in one call, as measured for the Inbox's index of version 4, needs no paging.
   - Until a file is migrated, a query on it, and an update that cannot migrate it, answers an error the webmail retries.
   - A file that fails to migrate marks only its mailbox as needing repair. The others continue.
7. **Export.**
   - **Freeze the mailbox.** No call writes its file while it is frozen:
     - moves leave its mail in the queue;
     - parsing, indexing and index merges skip it;
     - the outbox starts no send for it, and a result that comes back from a send already in flight waits in `control.db`;
     - its own changes (flags, deletes, sends) answer an error the webmail retries.
   - **The freeze is an update call**, which sets a deadline a few minutes ahead. A freeze records its reason. An export cannot freeze a mailbox the migration or a purge holds, and its deadline and thaw never release theirs. Renewals cannot extend a freeze past a fixed maximum, such as an hour. A query cannot record anything, so the chunk reads cannot keep the freeze alive. The client renews the deadline with an update call every few minutes, and thaws the mailbox with a last update call after the last chunk. A deadline that passes thaws the mailbox on its own, so an abandoned download cannot hold it.
   - The client reads the live file in 1.9 MB queries, 12M each (M8). 1 GB takes 553 queries.
   - **Each reply carries the file's write generation** from the registry. Every call that writes the file adds one to it, so a changed generation means a torn copy, and the client starts again. SQLite's own change counter in the file header cannot serve: with `locking_mode=EXCLUSIVE`, SQLite need not update it on every commit.
   - **Each reply also carries the chunk's sha256.** It catches a damaged transfer. It does not catch a faulty replica, which computes the hash of whatever it sends. A client that needs that assurance reads the chunks as replicated calls, which go through consensus and take longer.
   - A `VACUUM INTO` snapshot would avoid the freeze and compact the file, but it holds only about 1.6 GB of ordinary mail per call (M8).
8. **Purge.**
   - In one call, it removes everything `control.db` holds for the mailbox: its queue rows, the bodies no other recipient needs, its dedupe keys, its work-index entries and any held outbox results. It then resets the registry row's usage, keeping its uid and outbox counters and its uidvalidity (answer 4), commits `control.db`, and deletes the file and its directory. A failed delete traps, which rolls back the commit too. A purge ends any export freeze and advances the write generation, so a download in progress sees a torn copy.
   - Otherwise the ingest timer would move the old owner's queued mail into the file of whoever gets the address next.
   - One call deletes a file of up to about 2.4 GB of small mail. That is extrapolated from one 65 MB sample with no margin, and the call also clears `control.db`, so the cutoff must be measured and set well below it. Above that, the purge first marks the mailbox as purging, which nothing opens, then truncates the file in steps. The address cannot be given to a new owner until the purge has finished. A mailbox of small mail at the default quota is a file of about 3 GB.
   - Freed chunks are reused by every mailbox (M7).
9. **Isolation.** See pro 5: queries cannot reach other mailboxes; the canister's code still can.
10. **The live deployments.**
    - Their mail moves in a paged migration, one mailbox at a time, started from `post_upgrade` and continued by a timer.
    - **Until a mailbox has been migrated, moves skip it**, and its new mail waits in the queue. Its old mail therefore keeps the lower uids, and a gateway retry of a message that is already in `mail.db` is caught by the move's duplicate check once the old mail is in the file.
    - The migration takes mailboxes with held mail first. A mailbox whose held mail reaches its cap answers 451 until its turn, and the gateway retries.
    - The step that copies a mailbox's last page also adds its row's usage and message count to the registry row, which already counts the mail queued for it meanwhile, and copies the row's uid and outbox counters, modseq and uidvalidity into it, so mail moved in afterwards gets uids above the copied ones.
    - Purging a mailbox that has not been migrated yet copies its counters into the registry and marks it as migrated, with nothing to copy. A partial file from a migration in progress is deleted, and the migration's freeze ends. Its rows in `mail.db` go when `mail.db` is deleted, so a new owner of the address never receives them.
    - Until a mailbox has migrated, its mailbox API and its outbox run from `mail.db`, as today. The call that indexes its last copy also marks it migrated, so readers switch to the file only once it is complete and searchable. The migration's freeze, which has no deadline, keeps `mail.db`'s copy unchanged meanwhile.
    - Each mailbox is frozen, and its connection closed, while its mail moves. The step ATTACHes its file to `mail.db`'s connection, as M12 measured, which rule 3 allows while no other connection holds the file.
    - It copies the rows and bodies into the mailbox file, then parses and indexes them itself, page by page. M12's 0.74B per 1,000 messages leaves out that MIME extraction.
    - It resumes where it stopped after a trap or an upgrade.
    - `mail.db` is deleted only after every mailbox has moved.
    - Today's deployments are small, so this is cheap now and grows with every message.

## What it would take

- **Store layer** (`src/store/`):
  - a connection registry with `control.db` and the connection cache;
  - every function in `mail_store.cpp`, `outbox_store.cpp` and `allowlist.cpp` takes a connection;
  - the per-mailbox schema, and the control schema with the queue, the dedupe keys and the work index.
- **Callers:**
  - `smtp_request` queuing in `control.db`;
  - ingest moving each queued message into its mailbox's file, then parsing it there;
  - index merges per mailbox, scheduled from the work index;
  - the outbox scheduler driven by `next_due` in `control.db`;
  - the new bridge key;
  - admin totals from `control.db`;
  - purge as a file delete, after clearing the mailbox's rows in `control.db`.
- **New:**
  - the export methods with the freeze, and a download in the webmail;
  - the migration from `mail.db`;
  - paged schema migrations.
- **Tests:** the existing replica tests ported to the new layout, and the measurements above kept as a regression check.
- **Left to the implementation design:**
  - how the user sees, and gets back, a queued message whose move was quarantined, and whether it stays charged to the quota;
  - what moves and parses do with a file still waiting for a paged schema change, without quarantining good mail;
  - the quota accounting of a mailbox that is not migrated yet, with delivery still one commit in `control.db` (rule 5), and nothing lost between its last copy step and its switch to the file;
  - a migration step that traps every time, for example on a message whose parse traps: give up on that message, and let the migration go on;
  - the export freeze's maximum, sized against the largest file the quota allows, which is about 1,600 chunks at the default quota.
- **Upstream:** stable-fs should look up a missing name in its index instead of scanning the directory. Its maintainers suggest folders for now (stable-fs#29). Once that fix lands, the fanned-out layout is optional, not wrong.
- **Upstream:** a way to choose the stable-fs chunk size, in ic-wasi-polyfill's init (ic-wasi-polyfill#31) or in the build toolchain's own. The build toolchain is asked to add it and to measure 4, 16 and 64 KiB, for an empty mailbox's stable memory and for files of 1 to 3 GB.

## A correction to design.md and the explainer (v0.1.4)

This section describes v0.1.4. v0.2.0 adds `admin_check`, which design.md describes.

design.md and `how-it-works.html` said consistency checks are paged. No consistency check runs in the canister, paged or not, and a full `quick_check` of a large `mail.db` exceeds the instruction limit. Both now say so. With a database per mailbox, a check of a 50,000-message mailbox fits in one call (M11).
