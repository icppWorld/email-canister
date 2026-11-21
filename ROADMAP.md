# Roadmap

email-canister grows in small releases, driven by running it for real mailboxes. Two tracks share one codebase: **self-hosting**, where anyone runs email for their own domain, and a **managed service**, where one deployment sells mailboxes on a shared domain.

## Done

- Receiving through the DFINITY SMTP gateway, with deduplication, quarantine and charset decoding.
- Mail storage and full-text search in SQLite on stable memory.
- Sending through a relay bridge, with an idempotent outbox and an `UNKNOWN` state for lost outcomes.
- Webmail with Internet Identity sign-in, an Admin screen, sandboxed HTML and brand settings.
- Release mechanics (v0.1.0): a webmail built once per release and configured per deployment by a brand script, reproducible wasm builds in Docker, a release workflow with build provenance, and a setup guide for deployment repos that vendor a release.
- Reader fixes (v0.1.1): plain mail in the brand's colours, and the delivering domain shown as "via" instead of a sender warning.
- A domain canister for a domain registered outside Caffeine (v0.1.2): it serves the bare domain, where the SMTP gateway looks for the backend, and sends browsers to `www`.
- Webmail on custom domains with the same principals, and plain mail on the brand's page despite a mail service's tracking pixel (v0.1.3).
- Relay bridge fixes (v0.1.4): a rate-limited or lost send retried within the mail gateway's replay window, `#rejected` only for mail certainly not sent, strict JSON escaping, and bridge keys that a deleted outbox message never hands on. The storage design for v0.2.0.
- One SQLite database per mailbox (v0.2.0), as [docs/storage-per-mailbox.md](docs/storage-per-mailbox.md) recommends: a `control.db` beside one file per mailbox, delivery queued in one commit and moved into each recipient's file, search that costs only the mailbox's own mail, a consistency check per mailbox, a download of the mailbox's file, purge by truncation, outbox ids that never repeat, file schema versions upgraded by the ingest timer, and a relay bridge that removes the results it keeps after 7 days. Deployments are reinstalled: there is no migration from v0.1.x's `mail.db`.
- Shared mailboxes and several mailboxes per person (v0.2.0): members, all equal and managed by admins; shared read state with who opened each message; who sent each message; a mailbox list in the webmail; and names for people.
- An upgrade path for mailbox files (v0.3.0): a schema step that fails holds its mailbox only on its third failure in a row, upgrades take turns with incoming mail, and a file newer than the release is left alone until a release that knows it runs. Upgrades keep the mail.
- The mailbox experience (v0.3.0): Trash and Spam folders; Delete with no confirmation and an Undo, Restore, and mail in Trash and Spam deleted after 30 days, in steps of 20 messages as mail arrives or is moved; row actions on hover and checkboxes to act on several messages at once; stars in the list; blocked senders, shared by the mailbox's members, whose mail is filed in Spam; the folder shown stays after a send; a compose window at the bottom right that can be minimised or made full screen; and at phone width, the list and the open message taking turns.
- A simpler mailbox (v0.4.0): the reader's toolbar keeps Reply, Delete, a star and Spam in view, with the rest in ⋮ menus; Spam offers to block the sender in its note; Blocked senders, Download a copy and Admin in a header menu; the selected folder bold with a bar in a new brand role, `action-text`.
- Faster CI: a run takes about 6 minutes instead of 27. The toolchain, the built libraries and `icp`'s downloads come from caches; the test build is made once and handed to the native, replica and webmail tests, which run side by side, the webmail tests split by area over three jobs, each area on a backend of its own, and the replica tests in three parts. A pull request that changes only docs skips the build and the native, replica, webmail and bridge tests, and a push to `main` reuses the passed run of the pull request it merges, against `main` and for the same tree, which the release accepts; a merge that changes `.github/` or `scripts/passed-tree.sh` runs the tests again.
- Spam in one click (v0.5.0): Spam, in the reader or on ticked messages, files the mail and blocks each sender's `From` address, Not spam lifts the block, and one Undo puts back both; Spam never blocks an address of the mailbox's own domain or its subdomains; the Spam folder links to Blocked senders; the message list gives each message's `From` address.
- Fixes from a review of the code since v0.2.0 (v0.6.0): expired Trash and Spam mail deleted by a turn of the ingest timer, in a write of its own, so Restore and Not spam never delete the mail they move, a full mailbox frees its expired mail for the sender's retry, and one message that cannot be deleted no longer stops delivery; Spam's 30 days counted from the mail's arrival, so mail marked as Spam more than 30 days after it arrived is deleted at once, and the note says so; an index of the Inbox's own; Not spam that the parse no longer undoes; `mail_move`, `mail_block` and `mail_unblock` replying what they did, so the notes say what the canister did and Undo takes back only the mail it moved and the blocks it made; at 1,000 blocked addresses a new block replacing the oldest; a quota of at most 4 GiB, so the Inbox's index of a full mailbox builds in one call; sign-in in a popup window, so a slow sign-in with a security key no longer times out; and webmail fixes for lagging pages, notes and search.
- A compact mailbox (v0.7.0): every webmail button an icon with a tooltip, so the list's toolbar fits on one line; a divider between the message list and the reader that can be dragged, kept per browser; Sent with checkboxes, a hover Delete, a bulk Delete and Empty Sent, through `mail_outbox_delete_many`, keeping mail being sent; and Attach adding files, listed in the compose window, each with Remove.
- A quieter reader (v0.7.1): remote images load only after the reader's Show images, for that message; a message's links that connect ahead, metas, templates and frames are left out, so opening it tells its sender nothing; a reload after a deploy shows the new webmail.

## Next

- Aliases: several addresses for one mailbox, and a choice of sending address.
- Members a mailbox's own owners can manage, roles if they are wanted (`read`, `write`, `owner`), and an audit log of who was added and removed.
- The user's mailbox experience, further:
  - plain mail from more mail services in the brand's colours;
  - keyboard shortcuts, and the focus kept inside the compose window in full screen;
  - a note when a new webmail version is deployed, with a button to reload, so a tab left open never calls a backend whose interface changed under it;
  - at phone width, the device's back gesture returning from a message to the list;
  - an `Unopened` folder: Inbox mail that stays unopened for a week moves there, and mail in it moves to Trash 30 days after it arrived in the Inbox, as Spam is cleaned up, with a setting of its own;
  - the smaller webmail and Admin panel items noted during v0.2.0 and v0.3.0, among them every row action checking that the Admin panel's list is current, and errors shown without the agent's call details.
- Provisioner principals that may create and suspend mailboxes without being admins, for automated onboarding.
- Mailbox states: `active`, `suspended` (receives, cannot send) and `disabled`.
- Outbound rate limits per mailbox.
- While no domain is set, a canister answers 451 instead of 550 to a recipient in any domain other than its own `<id>.icp0.io`, so mail that arrives right after an install or a reinstall is retried by its sender instead of bouncing. An unknown recipient at `<id>.icp0.io` keeps 550, so a deployment that never sets a domain still bounces at once. Setting a canister up then creates its mailboxes first and sets the domain last.
- An onboarding link on the "not activated" screen, and a derivation origin shared with another site.
- Measured capacity per canister, including a lookup of the last bucket in a large `m/`.
- DKIM verification in the canister: the key fetched over DNS-over-HTTPS from several resolvers that must agree, the result stored per message, and a warning again for mail whose `From` domain no aligned signature covers.

## Operations

- Low-cycles mode that pauses sending, and alerts before the freezing threshold.
- Snapshot and restore drills.
- Only compatible Candid changes from now on: new methods, and new optional fields and arguments, never a changed or removed signature, so an upgrade from the last release passes `icp`'s compatibility check without `--yes`, and a webmail tab left open keeps working until it reloads. The release skill checks that the last release's deployment upgrades cleanly: the new interface against the last release's `.did`, and the upgrade test from the last release's wasm with mail in it. Before implementing it, compare how icpp-pro and llama_cpp_canister check their upgrades.
- Mail deleted for good overwritten in the mailbox file (`secure_delete`), and the search index merged after a delete, so a download cannot recover it.
- A paged rebuild of a mailbox's search index.
- A scheduled check that a domain's MX records still match the gateway's hosts.
- A consistency check of a mailbox file too large for one call: a whole-file check covers about 2.6 GB, the search index's own check about 0.8 GB.
- Upstream: a stable-fs that looks up a missing name without scanning its directory. Until then mailbox files fan out over small directories.
- Upstream: a choice of stable-fs chunk size, through the build toolchain, for new deployments, if its measurements favour another size for both empty mailboxes and files of 1 to 3 GB.

## Self-hosting track

- A setup guide that someone new to the Internet Computer can follow to a working domain, with a cost formula and worked examples.
- A deployment repo template that vendors a release.
- A strict mode for the brand script that fails the build when a brand's colours fall below the contrast it checks, instead of only warning.
- Reply threading, if the relay gains `In-Reply-To` and `References`.
- More charsets.
- An optional IMAP and SMTP bridge on the user's own computer, for desktop mail programs.
- Encryption at rest, keyed per user.

## Managed-service track

- A subscription site that pays for and provisions `<principal>@` mailboxes and aliases, paid with ckUSDC, ckBTC, ICP or a card.
- Grace periods: `suspended` on a lapsed payment, then `disabled`, then purge after export.
- Several canisters behind one SMTP handoff canister, which stores each message and forwards it to the right mailbox canister.
- Abuse handling for a shared sending domain.
- Terms of service and privacy wording that state who can read mail.
- Custom domains for customers, which means several domains per canister.

## Backlog

Priorities to be set later.

- Content-based spam filtering with private AI models. *To be designed.* The model could run at an endpoint the user provides, with or without an API key; in another canister, with llama_cpp_canister; in the browser, with llama_cpp_canister for the browser; or on a local AI runtime.
- Sending without an off-chain mail service. *To be explored.* Outbound mail leaves through the relay bridge and Caffeine's mail gateway, which uses Amazon SES. The question is whether the C++ backend canister can deliver mail to the recipients' mail servers itself. The exploration starts with what may block it: delivery over SMTP when a canister can make only HTTPS outcalls; finding the mail servers over DNS-over-HTTPS; sending IP addresses the deployment does not control, for reverse DNS, SPF and reputation; DKIM with the Internet Computer's threshold keys, which offer Ed25519 but not RSA; and bounces, which the DFINITY SMTP gateway would have to accept and the canister match to its outbox.
