#!/usr/bin/env bash
# Builds the relay bridge into a test app and runs its PocketIC tests, in a
# pinned Linux container: moc 2.1.0 has no Intel-Mac build, and CI runs the
# same. Nothing is written to the checkout; downloads are cached in a Docker
# volume.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

image=node:24.22.3-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496
mops_version=3.7.0

docker run --rm --platform linux/amd64 \
  -v "$PWD:/repo:ro" -v email-canister-bridge-cache:/root/.cache \
  -e npm_config_cache=/root/.cache/npm -e MOPS_VERSION="$mops_version" \
  "$image" bash -euo pipefail -c '
    mkdir -p /work
    # macOS metadata files and local installs stay behind
    tar -C /repo --exclude="._*" --exclude=.DS_Store --exclude=node_modules --exclude=.mops --exclude=build \
      -cf - bridge test/bridge | tar -C /work -xf -
    cd /work/test/bridge
    npm install -g --no-fund --no-audit "ic-mops@$MOPS_VERSION" >/dev/null
    # PocketIC comes from mops.toml, not from the package install script
    npm ci --ignore-scripts --no-fund --no-audit
    mops install
    ./build.sh "$(node identities.mjs)"
    POCKET_IC_BIN=$(mops toolchain bin pocket-ic) npx vitest run
  '
