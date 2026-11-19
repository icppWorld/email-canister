#!/usr/bin/env bash
# Builds the generic webmail in the pinned Node image: the `webmail` service in
# docker/docker-compose.yml. Copies the sources first, because the repo's
# webmail folder is mounted read-only and node_modules must be the image's own.
set -euo pipefail
export LC_ALL=C

rm -rf /tmp/webmail
mkdir /tmp/webmail
cd /src/webmail
# ._* are macOS metadata files, present when the repo is on a drive such as exFAT
tar --exclude=./node_modules --exclude=./dist --exclude=./test-results --exclude=./playwright-report \
  --exclude='._*' --exclude=.DS_Store -cf - . | tar -xf - -C /tmp/webmail
cd /tmp/webmail
npm ci --no-audit --no-fund
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build --outDir dist --emptyOutDir

out=/app/email-canister/out
rm -rf "$out/webmail"
mkdir -p "$out/webmail"
cp -R dist "$out/webmail/dist"
cp brand/brand.mjs brand/brand.d.mts brand/default.json brand/README.md "$out/webmail/"

# One hash for the whole build: the sorted list of every file and its sha256
(cd "$out/webmail/dist" && find . -type f ! -name '._*' -print0 | sort -z | xargs -0 sha256sum) >"$out/webmail/dist.sha256sums"
sha256sum "$out/webmail/dist.sha256sums" | cut -d ' ' -f 1 >"$out/webmail/dist.sha256"
echo "webmail_sha256=$(cat "$out/webmail/dist.sha256")" >"$out/webmail/PROVENANCE.txt"
echo "node=$(node --version)" >>"$out/webmail/PROVENANCE.txt"
echo "webmail_commit=${SOURCE_COMMIT:?SOURCE_COMMIT is not set: run make docker-build-webmail}" >>"$out/webmail/PROVENANCE.txt"

# Not -R: the host may add metadata files here, which root cannot change
find "$out/webmail" ! -name '._*' -exec chmod a+rX {} +
echo "webmail sha256: $(cat "$out/webmail/dist.sha256")"
