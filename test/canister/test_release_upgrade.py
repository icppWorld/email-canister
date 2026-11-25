"""An upgrade from a past release keeps the mail, on a local replica: the
release's wasm, from GitHub and checked by its sha256, takes mail, and is then
upgraded to this build.

From v0.5.0, this build takes control.db to its schema, and its pump takes each
mailbox file to schema 5. The mail, its folders and flags, and the blocks stay,
the pump cleans out expired mail with the upgraded registry, and the mailbox
gains a calendar.

From v0.12.0, the release the deployments run, nothing is migrated, but the
toolchain may change under the files: the mail, the calendar and its secret
address stay.

Both releases export over 2000 items. A replica with the IC's limit of 1100
exports refuses them, so on such a replica these tests skip.

$ make build-test
$ icp network start -d
$ pytest --network=local --identity=$TEST_IDENTITY test/canister/test_release_upgrade.py

Needs the gh CLI, signed in or with GH_TOKEN. Reinstalls the
email-canister-test canister, which erases its mail.
"""

# pylint: disable=missing-function-docstring, redefined-outer-name, unused-argument

import hashlib
import re
import subprocess
from pathlib import Path
from typing import Tuple

import pytest

from .support import (
    CANISTER_NAME,
    DOMAIN,
    OK,
    add_mailbox,
    call,
    deliver,
    mail,
    run_icp,
    wait_until,
    wait_until_drained,
)
from .test_mailbox import (
    USER_A,
    found,
    page,
    principal_of,
    uids,
    unread,
)
from .test_storage import upgrade

# Each release and its wasm's sha256
SCHEMA_RELEASE = (
    "v0.5.0",
    "093dee53a3c369bd4b345f74f2d5d141bc4882b05a1d73183a27d076e7b39882",
)
LAST_RELEASE = (
    "v0.12.0",
    "d865c1ce9a2930ebf0ed9e73adb2c69c5e638affcf2982585a9606cb972a31ab",
)
REPO = "icppWorld/email-canister"


def download(folder: Path, release: Tuple[str, str]) -> Path:
    tag, sha256 = release
    subprocess.run(
        ["gh", "release", "download", tag, "--repo", REPO]
        + ["--pattern", "email-canister.wasm", "--dir", str(folder)],
        check=True,
    )
    wasm = folder / "email-canister.wasm"
    assert hashlib.sha256(wasm.read_bytes()).hexdigest() == sha256
    return wasm


@pytest.fixture(scope="module")
def release_wasm(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return download(tmp_path_factory.mktemp("release"), SCHEMA_RELEASE)


@pytest.fixture(scope="module")
def last_release_wasm(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return download(tmp_path_factory.mktemp("last_release"), LAST_RELEASE)


def reinstall(identity: str, wasm: Path) -> None:
    done = run_icp(
        "canister",
        "install",
        CANISTER_NAME,
        "--mode",
        "reinstall",
        "--yes",
        "--wasm",
        str(wasm),
        identity=identity,
    )
    output = done.stdout + done.stderr
    if done.returncode and "exported items" in output:
        pytest.skip(f"this replica refuses the release's wasm: {output[-200:]}")
    assert done.returncode == 0, output
    call("admin_set_domain", f'("{DOMAIN}")')
    assert "error" not in add_mailbox("alice", principal_of(USER_A)).lower()


def busy() -> bool:
    return "busy:" in page(USER_A)


def test__an_upgrade_from_the_schema_release_keeps_the_mail(
    identity: str, release_wasm: Path
) -> None:
    reinstall(identity, release_wasm)
    for n, bird in enumerate(("puffin", "gannet", "shag", "skua")):
        assert re.search(OK, deliver(f"Kept {bird}", f"<kept{n}@sender.example>"))
    wait_until_drained()
    # Filed, read and blocked under the release
    shag = uids(found(USER_A, "shag"))[0]
    mail("mail_move", "alice", f"(vec {{ {shag} : nat64 }}, 1 : nat64)", USER_A)
    skua = uids(found(USER_A, "skua"))[0]
    mail("mail_move", "alice", f"(vec {{ {skua} : nat64 }}, 2 : nat64)", USER_A)
    first = min(uids(page(USER_A)))
    mail(
        "mail_set_flags",
        "alice",
        f"(vec {{ {first} : nat64 }}, 1 : nat64, 0 : nat64)",
        USER_A,
    )
    mail("mail_block", "alice", '("tern@birds.example")', USER_A)
    assert unread(USER_A, "alice") == 1

    # This build: the pump takes alice's file to its schema, meanwhile her
    # calls answer busy
    assert upgrade(identity) == ""
    wait_until(lambda: not busy(), "alice's upgrade")
    # Schema 4's index of the Inbox
    assert "index messages_inbox already exists" in call(
        "dev_file_exec", '("alice", "CREATE INDEX messages_inbox ON messages(uid)")'
    )
    inbox = page(USER_A)
    assert "Kept puffin" in inbox and "Kept gannet" in inbox
    assert "Kept shag" in page(USER_A, folder=1)
    assert "Kept skua" in page(USER_A, folder=2)
    assert unread(USER_A, "alice") == 1
    assert "tern@birds.example" in mail("mail_blocked", "alice", "()", USER_A)
    assert 'result = "ok"' in call("admin_check", '("alice", null)')
    # Schema 5's calendar, and control.db's version 3: its feed
    event = "BEGIN:VEVENT\\r\\nUID:kept\\r\\nSUMMARY:Kept tern\\r\\nEND:VEVENT"
    assert (
        mail(
            "mail_cal_put",
            "alice",
            f'(record {{ uid = "kept"; vevent = "{event}"; starts = 0 : nat64; '
            "ends = 1 : nat64; vtimezones = vec {} })",
            USER_A,
        )
        == "()"
    )
    assert "Kept tern" in mail(
        "mail_cal_list",
        "alice",
        "(record { from = 0 : nat64; to = 2 : nat64; cursor = null; "
        "limit = 10 : nat64 })",
        USER_A,
    )
    assert re.search(
        r'"[0-9a-f]{32}"', mail("mail_cal_feed_reset", "alice", "()", USER_A)
    )

    # control.db's version 2: new mail finds the mail past its 30 days in
    # Trash, and has the pump delete it. The block still holds.
    call(
        "dev_file_exec",
        f'("alice", "UPDATE messages SET folder_ns = 1 WHERE uid = {shag}")',
    )
    assert re.search(
        OK,
        deliver(
            "Blocked tern",
            "<tern@birds.example>",
            from_address="tern@birds.example",
        ),
    )
    wait_until_drained()
    wait_until(lambda: "Kept shag" not in page(USER_A, folder=1), "the cleanup")
    spam = page(USER_A, folder=2)
    assert "Blocked tern" in spam and "Kept skua" in spam
    assert unread(USER_A, "alice") == 1
    assert 'result = "ok"' in call("admin_check", '("alice", null)')


def test__an_upgrade_from_the_last_release_keeps_the_mail_and_the_calendar(
    identity: str, last_release_wasm: Path
) -> None:
    reinstall(identity, last_release_wasm)
    for n, bird in enumerate(("razorbill", "fulmar")):
        assert re.search(OK, deliver(f"Kept {bird}", f"<last{n}@sender.example>"))
    wait_until_drained()
    fulmar = uids(found(USER_A, "fulmar"))[0]
    mail("mail_move", "alice", f"(vec {{ {fulmar} : nat64 }}, 1 : nat64)", USER_A)
    event = "BEGIN:VEVENT\\r\\nUID:kept\\r\\nSUMMARY:Kept kittiwake\\r\\nEND:VEVENT"
    put = (
        f'(record {{ uid = "kept"; vevent = "{event}"; starts = 0 : nat64; '
        "ends = 1 : nat64; vtimezones = vec {} })"
    )
    assert mail("mail_cal_put", "alice", put, USER_A) == "()"
    address = mail("mail_cal_feed_reset", "alice", "()", USER_A)
    assert re.search(r'"[0-9a-f]{32}"', address)

    assert upgrade(identity) == ""
    wait_until(lambda: not busy(), "alice's mailbox")
    assert "Kept razorbill" in page(USER_A)
    assert "Kept fulmar" in page(USER_A, folder=1)
    assert "Kept kittiwake" in mail(
        "mail_cal_list",
        "alice",
        "(record { from = 0 : nat64; to = 2 : nat64; cursor = null; "
        "limit = 10 : nat64 })",
        USER_A,
    )
    # The secret address is the one from before the upgrade
    token = re.search(r'"([0-9a-f]{32})"', address)
    assert token and token.group(1) in mail("mail_cal_feed", "alice", "()", USER_A)
    assert 'result = "ok"' in call("admin_check", '("alice", null)')
