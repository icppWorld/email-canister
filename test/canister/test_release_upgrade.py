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

RELEASE = "v0.4.0"
RELEASE_WASM_SHA256 = "05ff9ac7c22e1eacff68f5d3b40fff8316f3e10969889dda51df16e9b69401ca"
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
    # The From header in the other forms its sender text takes
    for subject, from_header in [
        ("Kept kittiwake", "kittiwake@birds.example"),
        ("Kept fulmar", '\\"Fulmars <Ltd>\\" <fulmar@birds.example>'),
    ]:
        assert re.search(
            OK,
            deliver(
                subject,
                f"<{subject.split()[1]}@birds.example>",
                from_header=from_header,
            ),
        )
    wait_until_drained()
    # Filed, read and blocked under the release
    shag = uids(found(USER_A, "shag"))[0]
    mail("mail_move", "alice", f"(vec {{ {shag} : nat64 }}, 1 : nat64)", USER_A)
    first = min(uids(page(USER_A)))
    mail(
        "mail_set_flags",
        "alice",
        f"(vec {{ {first} : nat64 }}, 1 : nat64, 0 : nat64)",
        USER_A,
    )
    mail("mail_block", "alice", '("skua@birds.example")', USER_A)
    assert unread(USER_A, "alice") == 3

    # This build: the pump takes alice's file to its schema, meanwhile her
    # calls answer busy
    assert upgrade(identity) == ""
    wait_until(lambda: not busy(), "alice's upgrade")
    inbox = page(USER_A)
    for bird in ("puffin", "gannet", "kittiwake", "fulmar"):
        assert f"Kept {bird}" in inbox
    assert "Kept shag" in page(USER_A, folder=1)
    assert unread(USER_A, "alice") == 3
    assert 'result = "ok"' in call("admin_check", '("alice", null)')

    # Each message's From address, from the sender text the release kept
    for bird, address in [
        ("gannet", "sender@sender.example"),
        ("kittiwake", "kittiwake@birds.example"),
        ("fulmar", "fulmar@birds.example"),
    ]:
        assert f'sender_address = "{address}"' in found(USER_A, bird), bird

    # The block still holds, and mail this build parses gets its From
    # address from the parser
    assert re.search(
        OK,
        deliver(
            "Blocked skua",
            "<skua@birds.example>",
            from_address="skua@birds.example",
        ),
    )
    wait_until_drained()
    assert 'sender_address = "skua@birds.example"' in found(USER_A, "skua", folder=2)
    assert unread(USER_A, "alice") == 3
    # The upgraded file takes changes: Not spam, and a block
    skua = uids(found(USER_A, "skua", folder=2))[0]
    mail("mail_move", "alice", f"(vec {{ {skua} : nat64 }}, 0 : nat64)", USER_A)
    mail("mail_block", "alice", '("gannet@birds.example")', USER_A)
    assert "Blocked skua" in page(USER_A)
    assert unread(USER_A, "alice") == 4
    assert 'result = "ok"' in call("admin_check", '("alice", null)')
