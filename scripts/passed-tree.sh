#!/usr/bin/env bash
# Whether a push to main can skip its tests: only when the pull request it
# merges passed this tree, in a run against main. Run on main's checkout, with
# GITHUB_REPOSITORY and GH_TOKEN set. Prints run-tests=true or run-tests=false.
# Usage: passed-tree.sh <tree>
#
# This keeps a marker from any other branch's run from skipping main's tests.
# It does not guard against someone who can push: they can push to main
# directly, and the push that merges their change runs their copy of this
# script. Reviews and branch protection guard that.
set -uo pipefail
tree=$1

decide() {
  # A merge commit's second parent is the head of the pull request it merges
  local pr_head files id run_of
  pr_head=$(git rev-parse -q --verify 'HEAD^2') || {
    echo "Not a merge of a pull request" >&2
    return 1
  }
  # A merge that changes how this is decided runs the tests, and so does a
  # diff that cannot be read
  files=$(git diff --no-renames --name-only 'HEAD^1' HEAD) || return 1
  if grep -qE '^(\.github/|scripts/passed-tree\.sh$)' <<<"$files"; then
    echo "The merge changes .github/ or this script" >&2
    return 1
  fi
  # Only that pull request's run against main counts: any other branch's run,
  # or a run of this pull request against another branch, could upload a
  # marker for a tree it never tested. From this repository only: a fork's
  # run could upload any marker. An API call that fails runs the tests
  for id in $(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/artifacts?name=passed-tree-$tree&per_page=100" \
      --jq ".artifacts[] | select(.expired | not) | select(.workflow_run.head_repository_id == .workflow_run.repository_id) | select(.workflow_run.head_sha == \"$pr_head\") | .workflow_run.id"); do
    run_of=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id" \
      --jq '[.path, .event, .conclusion, .head_sha, ([.pull_requests[] | select(.base.ref == "main")] | length > 0)] | map(tostring) | join(" ")' || true)
    if [ "$run_of" = ".github/workflows/cicd.yml pull_request success $pr_head true" ]; then
      echo "Run $id of the merged pull request passed this tree" >&2
      return 0
    fi
  done
  return 1
}

if decide; then echo "run-tests=false"; else echo "run-tests=true"; fi
