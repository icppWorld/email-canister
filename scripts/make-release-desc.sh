#!/usr/bin/env bash
# Prints the changes since the previous release tag, for a release's description.
#   scripts/make-release-desc.sh v0.2.0
# A final release counts from the previous final release, so its changelog
# includes what its release candidates brought; a candidate counts from any tag.
set -euo pipefail
tag=${1:?usage: make-release-desc.sh <tag>}
exclude=()
[[ "$tag" == *rc* ]] || exclude=(--exclude '*rc*')
previous=$(git describe --tags --abbrev=0 "${exclude[@]}" "$tag^" 2>/dev/null || true)
echo "## Changes"
echo
if [[ -n "$previous" ]]; then
  echo "Since $previous:"
  echo
  git log --no-merges --format='- %s (%h)' "$previous..$tag"
else
  echo "First release."
  echo
  git log --no-merges --format='- %s (%h)' "$tag"
fi
