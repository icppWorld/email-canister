"""A push to main skips its tests only when the run of the pull request it
merges passed its tree: scripts/passed-tree.sh, against a git merge and a
stand-in for gh that answers from JSON files with jq.

$ pytest test/test_passed_tree.py
"""

import json
import os
import subprocess
from pathlib import Path

import pytest

# pylint: disable=missing-function-docstring,redefined-outer-name

ROOT = Path(__file__).parent.parent
SCRIPT = ROOT / "scripts" / "passed-tree.sh"
WORKFLOW = ".github/workflows/cicd.yml"

# Answers `gh api [--paginate] <url> --jq <filter>` from $FAKE_GH/<file>.json
FAKE_GH = """#!/usr/bin/env python3
import os, re, subprocess, sys
args = [a for a in sys.argv[1:] if a not in ("api", "--paginate")]
url, jq = args[0], args[args.index("--jq") + 1]
run = re.search(r"actions/runs/([0-9]+)$", url)
name = "run-" + run.group(1) if run else "artifacts"
path = os.path.join(os.environ["FAKE_GH"], name + ".json")
if not os.path.exists(path):
    sys.exit("gh: not found")
sys.exit(subprocess.run(["jq", "-r", jq, path]).returncode)
"""


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def commit(repo: Path, name: str) -> str:
    path = repo / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(name)
    git(repo, "add", name)
    git(repo, "commit", "-qm", name)
    return git(repo, "rev-parse", "HEAD")


def merged(tmp_path: Path, changed: str = "src/code.cpp") -> tuple[Path, str]:
    """A repo whose HEAD merges a pull request that changed `changed`; and
    that pull request's head"""
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "test")
    commit(repo, "README.md")
    git(repo, "switch", "-qc", "pr")
    pr_head = commit(repo, changed)
    git(repo, "switch", "-q", "main")
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request", "pr")
    return repo, pr_head


def artifact(run_id: int, head_sha: str, fork: bool = False) -> dict[str, object]:
    return {
        "expired": False,
        "workflow_run": {
            "id": run_id,
            "repository_id": 1,
            "head_repository_id": 2 if fork else 1,
            "head_sha": head_sha,
        },
    }


def passing_run(head_sha: str) -> dict[str, str]:
    return {
        "path": WORKFLOW,
        "event": "pull_request",
        "conclusion": "success",
        "head_sha": head_sha,
    }


@pytest.fixture
def answers(tmp_path: Path) -> Path:
    """The directory the stand-in gh answers from"""
    folder = tmp_path / "gh"
    folder.mkdir()
    (tmp_path / "bin").mkdir()
    fake = tmp_path / "bin" / "gh"
    fake.write_text(FAKE_GH)
    fake.chmod(0o755)
    return folder


def answer(
    answers: Path, artifacts: list[dict[str, object]], runs: dict[int, object]
) -> None:
    (answers / "artifacts.json").write_text(json.dumps({"artifacts": artifacts}))
    for run_id, run in runs.items():
        (answers / f"run-{run_id}.json").write_text(json.dumps(run))


def decide(repo: Path, answers: Path) -> str:
    env = {
        **os.environ,
        "PATH": f"{answers.parent / 'bin'}{os.pathsep}{os.environ['PATH']}",
        "FAKE_GH": str(answers),
        "GITHUB_REPOSITORY": "owner/repo",
    }
    tree = git(repo, "rev-parse", "HEAD^{tree}")
    result = subprocess.run(
        [str(SCRIPT), tree],
        cwd=repo,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def test__the_merged_pull_requests_run_skips_the_tests(
    tmp_path: Path, answers: Path
) -> None:
    repo, pr_head = merged(tmp_path)
    answer(answers, [artifact(7, pr_head)], {7: passing_run(pr_head)})
    assert decide(repo, answers) == "run-tests=false"


def test__a_marker_from_another_branchs_run_runs_the_tests(
    tmp_path: Path, answers: Path
) -> None:
    # Any branch's run can upload a marker named for a tree it never tested
    repo, _ = merged(tmp_path)
    other = "1" * 40
    answer(answers, [artifact(8, other)], {8: passing_run(other)})
    assert decide(repo, answers) == "run-tests=true"


def test__a_run_that_names_another_head_runs_the_tests(
    tmp_path: Path, answers: Path
) -> None:
    repo, pr_head = merged(tmp_path)
    answer(answers, [artifact(9, pr_head)], {9: passing_run("2" * 40)})
    assert decide(repo, answers) == "run-tests=true"


@pytest.mark.parametrize("changed", [".github/actions/x.yml", "scripts/passed-tree.sh"])
def test__a_merge_that_changes_the_decision_runs_the_tests(
    tmp_path: Path, answers: Path, changed: str
) -> None:
    repo, pr_head = merged(tmp_path, changed)
    answer(answers, [artifact(7, pr_head)], {7: passing_run(pr_head)})
    assert decide(repo, answers) == "run-tests=true"


def test__a_forks_marker_runs_the_tests(tmp_path: Path, answers: Path) -> None:
    repo, pr_head = merged(tmp_path)
    answer(answers, [artifact(7, pr_head, fork=True)], {7: passing_run(pr_head)})
    assert decide(repo, answers) == "run-tests=true"


def test__a_push_that_merges_nothing_runs_the_tests(
    tmp_path: Path, answers: Path
) -> None:
    repo, pr_head = merged(tmp_path)
    commit(repo, "src/direct.cpp")
    answer(answers, [artifact(7, pr_head)], {7: passing_run(pr_head)})
    assert decide(repo, answers) == "run-tests=true"


def test__an_api_call_that_fails_runs_the_tests(tmp_path: Path, answers: Path) -> None:
    repo, pr_head = merged(tmp_path)
    answer(answers, [artifact(7, pr_head)], {})  # the run cannot be read
    assert decide(repo, answers) == "run-tests=true"
