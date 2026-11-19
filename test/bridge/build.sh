#!/usr/bin/env bash
# Builds the test app from bridge/ into build/, with relayCaller set to the
# given principal. Run in the test container (run.sh) after mops install.
#   build.sh <relay caller principal>
set -euo pipefail
caller=${1:?usage: build.sh <relay caller principal>}
here=$(cd "$(dirname "$0")" && pwd)
bridge="$here/../../bridge"
out="$here/build"

moc=$(mops toolchain bin moc)
cd "$here"

# Builds the app from a bridge folder and a main.mo into a folder of build/
build() {
  local from=$1 main=$2 to=$3
  mkdir -p "$to/src"
  cp -R "$from/lib" "$from/mixins" "$from/types" "$to/src/"
  cp "$main" "$to/src/main.mo"
  # What a downstream repo changes, and nothing else
  placeholder='let relayCaller = "SET-TO-YOUR-BACKEND-CANISTER-ID";'
  grep -qF "$placeholder" "$to/src/lib/relay.mo" || { echo "relayCaller placeholder not found in $from/lib/relay.mo" >&2; exit 1; }
  sed -i "s/SET-TO-YOUR-BACKEND-CANISTER-ID/$caller/" "$to/src/lib/relay.mo"
  # A Caffeine app's moc arguments (its mops.toml [moc] and [build] args)
  "$moc" --implicit-package=core -no-check-ir -E=M0254 -W=M0235,M0223,M0236,M0237 -A=M0241 --release \
    $(mops sources) "$to/src/main.mo" -o "$to/bridge.wasm" --idl --stable-types
}

rm -rf "$out"
build "$bridge" "$here/main.mo" "$out"
# The bridge as v0.1.4 released it, which the apps upgrade from
build "$here/v0.1.4" "$here/v0.1.4/main.mo" "$out/v0.1.4"
"$moc" --stable-compatible "$out/v0.1.4/bridge.most" "$out/bridge.most" ||
  { echo "An app cannot upgrade from the v0.1.4 bridge to this one" >&2; exit 1; }
# The Candid the email-canister backend decodes must not change (comments may)
grep -v '^ *///' "$out/bridge.did" | diff -u "$here/bridge.did" - ||
  { echo "The bridge's Candid changed: the email-canister backend may no longer decode it" >&2; exit 1; }
