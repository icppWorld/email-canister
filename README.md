# email-canister

Email for your own domain, run from Internet Computer canisters you control.

- **Receive** mail through the DFINITY SMTP gateway, into a C++ canister that stores and indexes it in SQLite.
- **Read and send** in a webmail served from an asset canister, signed in with Internet Identity. There are no passwords.
- **Send** through a small relay app on Caffeine, which hands mail to its mail gateway.
- **Brand** the webmail with your own name, logo, fonts and colours.

> **Status: alpha.** Everything can still change between releases: the canister interface, the storage format, the webmail and the deployment steps. A new release may need a reinstall, which erases all mail, as v0.2.0 did. It runs real mailboxes, but read the risks in [docs/design.md](docs/design.md#known-limits) before relying on it, and keep your own copy of mail that matters.

## How it works

[How email-canister works](https://claude.ai/artifact/ToCBwEqQCT4fojJvNituFr) explains each component and mail path with diagrams, and the risks of relying on it. Its source is [docs/how-it-works.html](docs/how-it-works.html).

[docs/design.md](docs/design.md) explains the architecture, the access model, the rules the implementation follows and the measured limits. [ROADMAP.md](ROADMAP.md) lists what comes next.

## Repository layout

```
src/        the backend canister (C++20): SMTP handlers, ingest, storage, outbox, admin and mailbox API
shims/      charset conversion and small adapters for libetpan
vendor/     SQLite and libetpan, pinned (see THIRD_PARTY.md)
webmail/    the webmail (React, Vite), its brand system (webmail/brand) and end-to-end tests
test/       replica tests (pytest), charset tests, and a stub of the relay bridge
tools/      generators for checked-in tables
scripts/    repository checks
docs/       design notes
```

## Build and test

The backend is built with icpp-pro, pinned in `requirements.txt`. Every build and test command is a `make` target.

Setup, once:
- Python 3.11 with `pip install -r requirements.txt`
- Node.js 22 and the `icp` CLI
- `jq`, for the test of the CI's test reuse
- a local identity without funds for the tests: `icp identity new email-canister-test --storage plaintext`

```bash
make build-all build-relay-stub   # first build, including libraries (slow)
make build build-test             # after changing src/
icp network start -d              # a local replica, with Internet Identity at id.ai.localhost
                                  # (restart a network started before `ii: true` was in icp.yaml)
make test                         # Python, replica and webmail end-to-end tests
```

## Releases and deploying

Each release on GitHub is a zip with the backend wasm, built reproducibly in Docker, the generic webmail with its brand script, the relay bridge and the deploy scripts. A domain is deployed from a release, without building anything: see [docs/setup-guide.md](docs/setup-guide.md). How releases are made is in [README-Release-Guide.md](README-Release-Guide.md).

## Contributing

- Work on a branch and open a pull request into `main`.
- Enable the repository's git hooks once per clone: `git config core.hooksPath .githooks`.
- Before a pull request is merged:
  - a local CodeRabbit review of the branch against `main`;
  - a code review and a security review of the branch;
  - `scripts/check-neutral.sh` passes. CI skips it on a pull request from a fork, which gets no secrets, so a maintainer runs it before merging one;
  - all tests pass, locally and in CI.

  The pull request lists each review's findings and what was done about them.

## Licence

MIT, see [LICENSE](LICENSE). Third-party code is listed in [THIRD_PARTY.md](THIRD_PARTY.md).
