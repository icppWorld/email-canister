#!/usr/bin/env bash
# Packs out/email-canister_v<version>.zip from the reproducible build in out/
# (make docker-build) and the repository's docs, bridge, domain script and scripts.
#
# The zip is what a deployment vendors: it needs no compiler, only icp and
# Node.js to run webmail/brand.mjs and domain/domain.mjs.
set -euo pipefail
export LC_ALL=C
cd "$(git rev-parse --show-toplevel)"

version=$(cat version.txt)
name="email-canister_v$version"
[[ -f "docs/release-notes/v$version.md" ]] || { echo "docs/release-notes/v$version.md is missing" >&2; exit 1; }
for file in out/email-canister.wasm out/email-canister.wasm.sha256 out/email-canister.did out/BUILD-PROVENANCE.txt \
  out/webmail/dist/index.html out/webmail/dist.sha256 out/webmail/PROVENANCE.txt; do
  [[ -f "$file" ]] || { echo "$file is missing: run make docker-build" >&2; exit 1; }
done
grep -qx "version=$version" out/BUILD-PROVENANCE.txt || { echo "out/ was built from another version: rebuild" >&2; exit 1; }
# The provenance names the commit out/ was built from; it must be this one, committed
head=$(git rev-parse HEAD)
grep -qx "commit=$head" out/BUILD-PROVENANCE.txt && grep -qx "webmail_commit=$head" out/webmail/PROVENANCE.txt ||
  { echo "out/ was not built from $head without local changes: commit, then make docker-build" >&2; exit 1; }
[[ "$(sha256sum out/email-canister.wasm | cut -d ' ' -f 1)" == "$(cat out/email-canister.wasm.sha256)" ]] ||
  { echo "out/email-canister.wasm does not match its sha256" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
root="$stage/$name"
mkdir -p "$root/build" "$root/webmail" "$root/domain" "$root/scripts" "$root/docs/release-notes"

cp version.txt README.md README-Release-Guide.md LICENSE THIRD_PARTY.md ROADMAP.md "$root/"
cat out/BUILD-PROVENANCE.txt out/webmail/PROVENANCE.txt >"$root/BUILD-PROVENANCE.txt"
cp out/email-canister.wasm out/email-canister.wasm.sha256 out/email-canister.did "$root/build/"
cp -R out/webmail/dist "$root/webmail/dist"
cp out/webmail/dist.sha256 out/webmail/dist.sha256sums out/webmail/brand.mjs out/webmail/brand.d.mts \
  out/webmail/default.json out/webmail/README.md "$root/webmail/"
cp -R bridge "$root/bridge"
cp domain/domain.mjs "$root/domain/"
cp scripts/configure.sh scripts/check.sh "$root/scripts/"
cp docs/design.md docs/setup-guide.md docs/how-it-works.html "$root/docs/"
cp docs/release-notes/v*.md "$root/docs/release-notes/"
# macOS metadata files, present when the repo is on a drive such as exFAT
find "$root" \( -name '._*' -o -name .DS_Store \) -delete
# Fixed times and modes, so the same files give the same zip
find "$root" -type d -exec chmod 755 {} +
find "$root" -type f -exec chmod 644 {} +
chmod 755 "$root"/scripts/*.sh
find "$root" -exec env TZ=UTC touch -h -t 198001010000 {} +

# The zip must be as neutral as the repository
scripts/check-neutral.sh "$root"

rm -f "out/$name.zip"
# Sorted names and no extra attributes, so the same files give the same zip
(cd "$stage" && find "$name" -print | sort | TZ=UTC zip -X -q "$OLDPWD/out/$name.zip" -@)
sha256sum "out/$name.zip"
