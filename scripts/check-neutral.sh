#!/usr/bin/env bash
# Fails when the repo, or a folder such as an unzipped release, mentions a name
# that must stay out of this project. The names are not kept in the repo: they
# come from the file $NEUTRAL_DENYLIST (default ~/.config/email-canister/denylist)
# or, in CI, from the variable $NEUTRAL_DENYLIST_TEXT. One name per line,
# matched case-insensitively, toolchain names as whole words; blank lines and
# lines starting with # are skipped.
# A line "toolchain:<name>" names the build toolchain, which may appear only in
# the build files listed below, in ROADMAP.md (to compare with how its other
# projects check upgrades), and in at most one line of README.md.
#
# scripts/check-neutral.sh               tracked and new files in the repo
# scripts/check-neutral.sh --staged      the staged files (pre-commit hook)
# scripts/check-neutral.sh --message F   a commit message (commit-msg hook)
# scripts/check-neutral.sh DIR           every file under DIR
set -euo pipefail
LC_ALL=C
export LC_ALL

TOOLCHAIN_FILES=(
  requirements.txt icpp.toml icpp-test.toml test/relay_stub/icpp.toml Makefile
  scripts/build_wasm_docker.sh scripts/check-neutral.sh
  test/canister/toolchain.py test/test_build_config.py
  BUILD-PROVENANCE.txt ROADMAP.md
)
TOOLCHAIN_DIRS=(docker/ .github/workflows/ .github/actions/)

list_file=${NEUTRAL_DENYLIST:-$HOME/.config/email-canister/denylist}
if [[ -n "${NEUTRAL_DENYLIST_TEXT:-}" ]]; then
  denylist=$NEUTRAL_DENYLIST_TEXT
elif [[ -f "$list_file" ]]; then
  denylist=$(cat "$list_file")
else
  echo "check-neutral: no denylist; set NEUTRAL_DENYLIST_TEXT or create $list_file" >&2
  exit 2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
names=$work/names
tools=$work/tools
grep -v -e '^[[:space:]]*$' -e '^#' <<<"$denylist" | grep -v '^toolchain:' >"$names" || true
grep '^toolchain:' <<<"$denylist" | sed 's/^toolchain://' >"$tools" || true
if [[ ! -s "$names" && ! -s "$tools" ]]; then
  echo "check-neutral: the denylist is empty" >&2
  exit 2
fi

is_toolchain_file() {
  local file=$1 entry
  for entry in "${TOOLCHAIN_FILES[@]}"; do [[ "$file" == "$entry" ]] && return 0; done
  for entry in "${TOOLCHAIN_DIRS[@]}"; do [[ "$file" == "$entry"* ]] && return 0; done
  return 1
}

hits=0
report() { echo "$1"; hits=$((hits + 1)); }

# check NAME CONTENT-FILE: NAME is the path shown and checked against the lists
check() {
  local name=$1 content=$2 found
  if [[ -s "$names" ]]; then
    grep -qiF -f "$names" <<<"$name" && report "$name: the file name"
    found=$(grep -IinF -f "$names" "$content" || true)
    [[ -n "$found" ]] && while IFS= read -r line; do report "$name:$line"; done <<<"$found"
  fi
  if [[ -s "$tools" ]] && ! is_toolchain_file "$name"; then
    found=$(grep -IinwF -f "$tools" "$content" || true)
    if [[ -n "$found" ]]; then
      if [[ "$name" == README.md && $(wc -l <<<"$found") -eq 1 ]]; then return; fi
      while IFS= read -r line; do report "$name:$line"; done <<<"$found"
    fi
  fi
}

case "${1:-}" in
  --staged)
    while IFS= read -r -d '' file; do
      git show ":$file" >"$work/staged"
      check "$file" "$work/staged"
    done < <(git diff --cached --name-only --diff-filter=ACMR -z)
    ;;
  --message)
    check "commit message" "$2"
    ;;
  "")
    cd "$(git rev-parse --show-toplevel)"
    while IFS= read -r -d '' file; do
      [[ -f "$file" ]] && check "$file" "$file"
    done < <(git ls-files -z --cached --others --exclude-standard)
    ;;
  *)
    cd "$1"
    while IFS= read -r -d '' file; do
      check "${file#./}" "$file"
    done < <(find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -print0)
    ;;
esac

if ((hits > 0)); then
  echo "check-neutral: $hits mention(s) of names that must stay out of this project" >&2
  exit 1
fi
echo "check-neutral: clean"
