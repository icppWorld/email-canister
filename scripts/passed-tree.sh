#!/usr/bin/env bash
# Whether a push to main can skip its tests: only when the pull request it
# merges passed this tree. Run on main's checkout, with GITHUB_REPOSITORY and
# GH_TOKEN set. Prints run-tests=true or run-tests=false.
# Usage: passed-tree.sh <tree>
set -uo pipefail
tree=$1
run=true

# A merge commit's second parent is the head of the pull request it merges.
# Only that pull request's run counts: any other branch's run could upload a
# marker for a tree it never tested. A merge that changes how this is decided
# runs the tests, since its own run decided with its own copy
pr_head=$(git rev-parse -q --verify 'HEAD^2' || true)
if [ -z "$pr_head" ]; then
  echo "Not a merge of a pull request" >&2
elif git diff --no-renames --name-only 'HEAD^1' HEAD | grep -qE '^(\.github/|scripts/passed-tree\.sh$)'; then
  echo "The merge changes .github/ or this script" >&2
else
  # From this repository only: a fork's run could upload any marker. An API
  # call that fails runs the tests
  for id in $(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/artifacts?name=passed-tree-$tree&per_page=100" \
      --jq ".artifacts[] | select(.expired | not) | select(.workflow_run.head_repository_id == .workflow_run.repository_id) | select(.workflow_run.head_sha == \"$pr_head\") | .workflow_run.id"); do
    run_of=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id" --jq '[.path, .event, .conclusion, .head_sha] | join(" ")' || true)
    if [ "$run_of" = ".github/workflows/cicd.yml pull_request success $pr_head" ]; then
      run=false
      echo "Run $id of the merged pull request passed this tree" >&2
      break
    fi
  done
fi
echo "run-tests=$run"
