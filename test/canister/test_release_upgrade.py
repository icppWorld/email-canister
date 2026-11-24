"""An upgrade from the last release keeps the mail, on a local replica: the
release's wasm, from GitHub and checked by its sha256, takes mail, and is then
upgraded to this build, which takes control.db to its schema, and whose pump
takes each mailbox file to schema 5. The mail, its folders and flags, and the
blocks stay, the pump cleans out expired mail with the upgraded registry, and
the mailbox gains a calendar.

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

import pytest

from .support import (
    CANISTER_NAME,
    DOMAIN,
    OK,
    add_mailbox,
    call,
    deliver,
    icp,
    mail,
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

RELEASE = "v0.5.0"
RELEASE_WASM_SHA256 = "093dee53a3c369bd4b345f74f2d5d141bc4882b05a1d73183a27d076e7b39882"
REPO = "icppWorld/email-canister"


@pytest.fixture(scope="module")
def release_wasm(tmp_path_factory: pytest.TempPathFactory) -> Path:
    folder = tmp_path_factory.mktemp("release")
    subprocess.run(
        ["gh", "release", "download", RELEASE, "--repo", REPO]
        + ["--pattern", "email-canister.wasm", "--dir", str(folder)],
        check=True,
    )
    wasm = folder / "email-canister.wasm"
    assert hashlib.sha256(wasm.read_bytes()).hexdigest() == RELEASE_WASM_SHA256
    return wasm


def busy() -> bool:
    return "busy:" in page(USER_A)


def test__an_upgrade_from_the_last_release_keeps_the_mail(
    identity: str, release_wasm: Path
) -> None:
    icp(
        "canister",
        "install",
        CANISTER_NAME,
        "--mode",
        "reinstall",
        "--yes",
        "--wasm",
        str(release_wasm),
        identity=identity,
    )
    call("admin_set_domain", f'("{DOMAIN}")')
    assert "error" not in add_mailbox("alice", principal_of(USER_A)).lower()
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
