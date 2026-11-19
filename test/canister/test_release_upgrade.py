"""An upgrade from the last release keeps the mail, on a local replica: the
release's wasm, from GitHub and checked by its sha256, takes mail, and is then
upgraded to this build, whose pump upgrades each mailbox file.

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

RELEASE = "v0.2.0"
RELEASE_WASM_SHA256 = "1a938b60ed80f019c97599e64c28c925d9fa53930d6c4f2cece55d02da093fdc"
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
    for n, bird in enumerate(("puffin", "gannet", "shag")):
        assert re.search(OK, deliver(f"Kept {bird}", f"<kept{n}@sender.example>"))
    wait_until_drained()
    # The release's own interface: one uid, no folder
    listed = call(
        "mail_list", '("alice", record { cursor = null; limit = 10 : nat64 })', USER_A
    )
    first = min(uids(listed))
    call("mail_set_flags", f'("alice", {first} : nat64, 1 : nat64, 0 : nat64)', USER_A)
    assert unread(USER_A, "alice") == 2

    # This build: the pump takes alice's file to its schema, meanwhile her
    # calls answer busy
    assert upgrade(identity) == ""
    wait_until(lambda: not busy(), "alice's upgrade")
    inbox = page(USER_A)
    assert all(f"Kept {bird}" in inbox for bird in ("puffin", "gannet", "shag"))
    assert unread(USER_A, "alice") == 2
    assert uids(found(USER_A, "gannet"))
    assert 'result = "ok"' in call("admin_check", '("alice", null)')

    # The new folders and blocking work on the upgraded file
    shag = uids(found(USER_A, "shag"))[0]
    mail("mail_move", "alice", f"(vec {{ {shag} : nat64 }}, 1 : nat64)", USER_A)
    assert unread(USER_A, "alice") == 1
    assert "Kept shag" in page(USER_A, folder=1)
    mail("mail_block", "alice", '("sender@sender.example")', USER_A)
    assert re.search(OK, deliver("Blocked skua", "<skua@sender.example>"))
    wait_until_drained()
    assert "Blocked skua" in page(USER_A, folder=2)
    assert unread(USER_A, "alice") == 1
    assert 'result = "ok"' in call("admin_check", '("alice", null)')
