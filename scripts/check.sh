#!/usr/bin/env bash
# Checks a live deployment: the backend runs the wasm you expect, the domain
# hands its mail to that backend, the domain is registered with the IC's
# custom-domain service, and its MX records match the SMTP gateway's.
#
#   scripts/check.sh --backend <canister id> --domain example.com \
#       [--wasm-sha256 <hex>] [--network ic] [--www]
#
# --www also checks that https://www.<domain>/ answers, for a domain whose
# website is served on www.
#
# Needs icp, curl and dig. Exits non-zero on the first difference.
set -euo pipefail

network=ic
backend="" domain="" pin="" www=""
while (($#)); do
  case "$1" in
    --www) www=1; shift; continue ;;
    --backend) backend=$2 ;;
    --domain) domain=$2 ;;
    --wasm-sha256) pin=$2 ;;
    --network) network=$2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift 2
done
[[ -n "$backend" && -n "$domain" ]] || { echo "--backend and --domain are required" >&2; exit 2; }

failed=0
ok() { echo "ok    $1"; }
bad() { echo "FAIL  $1"; failed=1; }

if [[ -n "$pin" ]]; then
  hash=$(icp canister status "$backend" --network "$network" --public |
    sed -n 's/.*[Mm]odule hash: *\(0x\)\{0,1\}\([0-9a-f]\{64\}\).*/\2/p')
  [[ "$hash" == "$pin" ]] && ok "backend runs wasm $pin" || bad "backend runs wasm ${hash:-unknown}, expected $pin"
fi

# Without following redirects, as the SMTP gateway reads it
handoff=$(curl -fsS "https://$domain/.well-known/ic-smtp-canister-id" | tr -d '[:space:]' || true)
[[ "$handoff" == "$backend" ]] && ok "https://$domain hands mail to $backend" ||
  bad "https://$domain/.well-known/ic-smtp-canister-id says '${handoff:0:80}', expected $backend"

registration=$(curl -sS "https://icp0.io/custom-domains/v1/$domain" || true)
if grep -Eq '"registration_status"[[:space:]]*:[[:space:]]*"registered"' <<<"$registration"; then
  ok "$domain is registered with the IC's custom-domain service, to $(sed -nE 's/.*"canister_id"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' <<<"$registration")"
else
  bad "$domain is not registered with the IC's custom-domain service: ${registration:0:200}"
fi

if [[ -n "$www" ]]; then
  status=$(curl -sSL -o /dev/null -w '%{http_code}' "https://www.$domain/" || true)
  [[ "$status" == 200 ]] && ok "https://www.$domain/ answers" || bad "https://www.$domain/ answers ${status/#000/nothing}, expected 200"
fi

hosts() { dig +short MX "$1" | awk '{print tolower($2)}' | sed 's/\.$//' | sort -u; }
expected=$(hosts boundary.dfinity.network)
actual=$(hosts "$domain")
if [[ -z "$actual" ]]; then
  bad "$domain has no MX records"
elif [[ "$actual" == "$expected" ]]; then
  ok "$domain's MX records match the SMTP gateway's $(wc -l <<<"$expected" | tr -d ' ') hosts"
else
  bad "$domain's MX records differ from the gateway's"
  diff <(echo "$expected") <(echo "$actual") | sed 's/^/      /' || true
fi

exit "$failed"
