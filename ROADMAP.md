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

## Next: v0.3.0

- Aliases: several addresses for one mailbox, and a choice of sending address.
- Members a mailbox's own owners can manage, roles if they are wanted (`read`, `write`, `owner`), and an audit log of who was added and removed.
- The user's mailbox experience: plain mail from more mail services in the brand's colours, and the smaller webmail and Admin panel items noted during v0.2.0, among them every row action checking that the Admin panel's list is current.
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
- A paged rebuild of a mailbox's search index.
- A scheduled check that a domain's MX records still match the gateway's hosts.
- A consistency check of a mailbox file too large for one call: a whole-file check covers about 2.6 GB, the search index's own check about 0.8 GB.
- Upstream: a stable-fs that looks up a missing name without scanning its directory. Until then mailbox files fan out over small directories.
- Upstream: a choice of stable-fs chunk size, through the build toolchain, for new deployments, if its measurements favour another size for both empty mailboxes and files of 1 to 3 GB.

## Self-hosting track

- A setup guide that someone new to the Internet Computer can follow to a working domain, with a cost formula and worked examples.
- A deployment repo template that vendors a release.
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
