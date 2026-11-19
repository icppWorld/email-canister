# Making a release

A release is a zip that a deployment vendors: the backend wasm built reproducibly, the generic webmail with its brand script, the relay bridge, the deploy scripts and the docs. The release workflow builds it on GitHub from a commit on `main`, so what is published can be rebuilt by anyone.

## Version numbers

- `vX.Y.Z` for a release, `vX.Y.ZrcN` for a release candidate. A tag containing `rc` is published as a prerelease. So is every release while `STAGE` in `.github/workflows/release.yml` is set, now `alpha`, which also goes into the release's name.
- Raise the minor version for new features or a changed Candid API, the patch version for fixes only.
- A release that needs a data migration says so in its upgrade notes, and its migration is tested across an upgrade with mail in the canister.

## Steps

1. On a branch, set `version.txt` to the new version, without the `v`, and the same version in `webmail/package.json` (`npm version --no-git-tag-version X.Y.Z` in `webmail/`, with a release candidate written `X.Y.Z-rcN`) and wherever `docs/how-it-works.html` names the release. `make test-python` fails while they differ.
2. Copy `docs/release-notes/TEMPLATE.md` to `docs/release-notes/vX.Y.Z.md` and fill in every section. Write "None" where nothing changed, so a reader knows it was considered.
3. Check locally:
   ```bash
   scripts/check-neutral.sh
   make test
   make docker-build-base docker-build    # twice: the two wasm sha256 must match
   make release-zip
   ```
   The wasm build compiles many files in parallel and peaks at about 2.5 GB of memory in Docker; give Docker 4 GB or more. With too little, it stops with exit status 137.
4. Open a pull request and complete the reviews in [Contributing](README.md#contributing). Merge it once CI is green.
5. Wait for the `cicd` workflow on the merge commit to pass, then start the release:
   ```bash
   gh workflow run release.yml -f tag=vX.Y.Z
   ```
   The workflow refuses to run unless the tag matches `version.txt`, the release notes exist, it runs on `main`, and `cicd` passed on that commit.
6. Check the published release:
   - the title carries the wasm sha256;
   - the zip, the bare wasm and its `.sha256` are attached;
   - the sha256 in the title matches your local `out/email-canister.wasm.sha256` from step 3, and any wasm sha256 the upgrade notes name.
7. Upgrade a test deployment from the release, as in [docs/setup-guide.md](docs/setup-guide.md), before the production ones.
8. Upgrade every deployment you maintain, each through its deployment repo's update steps, redeploying only what the upgrade notes say changed. When the release changes `bridge/`, also copy the new bridge files into the domain's Caffeine app, keep its `relayCaller`, make any change to the app's actor that the upgrade notes ask for, check the copy, and deploy the app.

## What the release workflow does

1. Builds the toolchain image from `docker/Dockerfile.base`, pinned by digest, without the build cache.
2. Builds the wasm and the webmail in it (`make docker-build`).
3. Packs `out/email-canister_vX.Y.Z.zip` (`make release-zip`), which fails if the staged files mention any name on the denylist.
4. Writes the description: the release notes, the commits since the previous tag, and the two hashes.
5. Tags the commit and publishes the release.

## If something goes wrong

- A failed workflow publishes nothing. Fix the cause on a branch, merge, and start it again.
- A published release with a defect is never replaced under the same tag. Mark it in its description, and publish a new patch version.
