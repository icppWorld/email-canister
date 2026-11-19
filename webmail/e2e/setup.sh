#!/usr/bin/env bash
# Puts fresh test canisters, the e2e webmail build and the normal webmail
# build on the local replica.
# Erases what those canisters hold. Build the test canisters first, with
# make build-test build-relay-stub. TEST_IDENTITY names a local identity that
# holds no funds.
set -euo pipefail
cd "$(dirname "$0")/../.."
identity=${TEST_IDENTITY:-email-canister-test}
env_args=(--environment local --identity "$identity")

icp deploy email-canister-test relay_stub --mode reinstall --yes "${env_args[@]}"
backend=$(icp canister status email-canister-test --id-only "${env_args[@]}")
stub=$(icp canister status relay_stub --id-only "${env_args[@]}")

(cd webmail && npm run build:e2e)
node webmail/brand/brand.mjs --dist webmail/dist --out build/webmail --brand webmail/e2e/brand --backend "$backend" --network local
icp deploy webmail --mode reinstall --yes "${env_args[@]}"
webmail=$(icp canister status webmail --id-only "${env_args[@]}")

# The normal build signs in through the network's own Internet Identity. Its
# own folder keeps webmail/dist the e2e build; make webmail-type typechecks.
(cd webmail && node node_modules/vite/bin/vite.js build --outDir ../build/webmail-real-dist --emptyOutDir)
node webmail/brand/brand.mjs --dist build/webmail-real-dist --out build/webmail-real --backend "$backend" --network local
icp deploy webmail-real --mode reinstall --yes "${env_args[@]}"
real=$(icp canister status webmail-real --id-only "${env_args[@]}")

port=$(icp network status --json --environment local | python3 -c 'import json,sys,urllib.parse as u; print(u.urlparse(json.load(sys.stdin)["gateway_url"]).port)')
cat > webmail/e2e/env.json <<JSON
{"url": "http://$webmail.localhost:$port", "real_url": "http://$real.localhost:$port", "backend": "$backend", "stub": "$stub", "identity": "$identity"}
JSON
cat webmail/e2e/env.json
