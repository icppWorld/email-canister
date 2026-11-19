#!/usr/bin/env bash
# Builds the backend wasm inside the reproducible image: the `wasm` service in
# docker/docker-compose.yml, started by `make docker-build-wasm`, which passes
# SOURCE_COMMIT. Do not run it on a host.
set -euo pipefail
# The link step's `*.o` order depends on the locale: keep it fixed
export LC_ALL=C
commit=${SOURCE_COMMIT:?SOURCE_COMMIT is not set: run make docker-build-wasm}

cd /app/email-canister
icpp_version=$(icpp --version | tr '\n' ' ')
# Exactly one of each, or the provenance would name the wrong compiler
clangs=("$HOME"/.icpp/wasi-sdk/wasi-sdk-*/bin/clang)
[[ ${#clangs[@]} -eq 1 && -x "${clangs[0]}" ]] || { echo "expected one wasi-sdk clang, found: ${clangs[*]}" >&2; exit 1; }
clang_version=$("${clangs[0]}" --version | head -1)
echo "icpp-pro: $icpp_version"

# --generate-bindings no: bindings do not affect the wasm and need another tool
icpp build-wasm --generate-bindings no

mkdir -p out
cp build/email-canister.wasm out/
cp src/email-canister.did out/
sha256sum out/email-canister.wasm | cut -d ' ' -f 1 >out/email-canister.wasm.sha256
sqlite=$(grep -m1 '#define SQLITE_VERSION ' vendor/sqlite3/sqlite3.h | cut -d '"' -f 2)
libetpan=$(cat vendor/libetpan/VERSION)
[[ -n "$sqlite" && -n "$libetpan" ]] || { echo "could not read the vendored library versions" >&2; exit 1; }

cat >out/BUILD-PROVENANCE.txt <<PROVENANCE
version=$(cat version.txt)
commit=$commit
wasm_sha256=$(cat out/email-canister.wasm.sha256)
icpp_pro=$icpp_version
wasi_sdk_clang=$clang_version
sqlite=$sqlite
libetpan=$libetpan
PROVENANCE

# The bind mount is written as root; let the host user read the results.
# Only these files: out/ may hold files the host added, which root cannot change.
chmod a+r out/email-canister.wasm out/email-canister.wasm.sha256 out/email-canister.did out/BUILD-PROVENANCE.txt
echo "wasm sha256: $(cat out/email-canister.wasm.sha256)"
