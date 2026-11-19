#!/usr/bin/env bash
# Sets a deployed backend's domain and relay bridge. Run as a controller.
#
#   scripts/configure.sh --backend <canister id> --domain example.com \
#       --bridge <bridge canister id> --identity <controller identity> [--network ic]
#
# Then add each user in the webmail's Admin screen, from the principal their
# "not activated" screen shows.
set -euo pipefail

network=ic
backend="" domain="" bridge="" identity=""
while (($#)); do
  case "$1" in
    --backend) backend=$2 ;;
    --domain) domain=$2 ;;
    --bridge) bridge=$2 ;;
    --identity) identity=$2 ;;
    --network) network=$2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift 2
done
for name in backend domain bridge identity; do
  [[ -n "${!name}" ]] || { echo "--$name is required" >&2; exit 2; }
done
[[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || {
  echo "--domain $domain: give a lower-case domain such as example.com" >&2; exit 2; }

call() { icp canister call "$backend" "$1" "$2" --network "$network" --identity "$identity"; }
call admin_set_domain "(\"$domain\")"
call admin_set_bridge "(principal \"$bridge\")"
call admin_settings "()"
