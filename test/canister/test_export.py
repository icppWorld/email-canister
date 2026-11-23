"""A member's download of a mailbox file, on a local replica.

$ make build-test
$ icp network start -d
$ pytest --network=local --identity=$TEST_IDENTITY test/canister/test_export.py

Reinstalls the email-canister-test canister, which erases its mail.
"""

# pylint: disable=missing-function-docstring, redefined-outer-name, unused-argument

import re
import sqlite3
import time
from pathlib import Path
from typing import Dict, Iterator, Tuple

import pytest

from .support import (
    CANISTER_NAME,
    DOMAIN,
    OK,
    add_mailbox,
    add_member,
    blob_of,
    call,
    deliver,
    icp,
    mail,
    number,
    purge,
    search,
    stats,
    wait_until_drained,
)
from .test_mailbox import USER_A, USER_B, USER_C, principal_of

MAILBOX = {USER_A: "alice", USER_B: "bob", USER_C: "carol"}

HOLD_NS, LIMIT_NS = 300_000_000_000, 7_200_000_000_000
CHUNK = 30_000


@pytest.fixture(scope="module")
def users(network: str, identity: str) -> Dict[str, str]:
    return {name: principal_of(name) for name in (USER_A, USER_B, USER_C)}


@pytest.fixture(scope="module", autouse=True)
def canister(network: str, identity: str, users: Dict[str, str]) -> None:
    icp("deploy", CANISTER_NAME, "--mode", "reinstall", "--yes", identity=identity)
    call("admin_set_domain", f'("{DOMAIN}")')
    add_mailbox("alice", users[USER_A])
    add_mailbox("bob", users[USER_B])
    add_mailbox("carol", users[USER_C])


@pytest.fixture(autouse=True)
def thawed() -> Iterator[None]:
    yield
    call("dev_set_export_timing", f"({HOLD_NS} : nat64, {LIMIT_NS} : nat64)")
    for user in (USER_A, USER_B, USER_C):
        live = chunk(user, 0, 1)
        if "started_ns" in live:
            thaw(user, number(live, "started_ns"))


def freeze(user: str, local: str = "") -> Tuple[int, int, int]:
    output = mail("mail_export_freeze", local or MAILBOX[user], "(null)", user)
    return (
        number(output, "size"),
        number(output, "started_ns"),
        number(output, "until_ns"),
    )


def renewal(user: str, started: int, local: str = "") -> str:
    return mail(
        "mail_export_freeze",
        local or MAILBOX[user],
        f"(opt ({started} : nat64))",
        user,
    )


def thaw(user: str, started: int, local: str = "") -> None:
    mail("mail_export_thaw", local or MAILBOX[user], f"({started} : nat64)", user)


def chunk(user: str, offset: int, length: int = CHUNK, local: str = "") -> str:
    return mail(
        "mail_export_chunk",
        local or MAILBOX[user],
        f"(record {{ offset = {offset} : nat64; length = {length} : nat64 }})",
        user,
    )


def download(user: str) -> bytes:
    size, started, _ = freeze(user)
    data = b""
    while len(data) < size:
        output = chunk(user, len(data))
        assert number(output, "started_ns") == started
        part = blob_of(output, "data")
        assert 0 < len(part) <= min(CHUNK, size - len(data)), len(part)
        data += part
    return data


def found(local: str, query: str) -> bool:
    return any(mailbox == local for mailbox, _ in search(query))


def wait_for(local: str, query: str, seconds: float = 30) -> None:
    deadline = time.time() + seconds
    while not found(local, query):
        assert time.time() < deadline, f"{query} never reached {local}"
        time.sleep(0.5)


def test__a_download_is_the_mailbox_file(tmp_path: Path) -> None:
    for n in range(3):
        assert re.search(OK, deliver(f"Kept walrus {n}", f"<walrus{n}@sender.example>"))
    wait_until_drained()
    data = download(USER_A)
    assert data.startswith(b"SQLite format 3\x00")
    path = tmp_path / "alice.sqlite"
    path.write_bytes(data)
    with sqlite3.connect(path) as copy:
        assert copy.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert copy.execute("SELECT count(*) FROM messages").fetchone() == (3,)
        assert copy.execute("SELECT message_count FROM counters").fetchone() == (3,)
        # The index's contentless_delete option needs SQLite 3.43
        if sqlite3.sqlite_version_info >= (3, 43, 0):
            hits = copy.execute(
                "SELECT count(*) FROM fts WHERE fts MATCH 'walrus'"
            ).fetchone()
            assert hits == (3,)


def test__nothing_changes_the_file_while_it_is_downloaded() -> None:
    size, started, _ = freeze(USER_A)
    for method, argument in [
        ("mail_set_flags", "(vec { 1 : nat64 }, 1 : nat64, 0 : nat64)"),
        ("mail_delete", "(vec { 1 : nat64 }, 0 : nat64)"),
        ("mail_move", "(vec { 1 : nat64 }, 1 : nat64)"),
        ("mail_block", '("x@example.com")'),
        ("mail_unblock", '("x@example.com")'),
        (
            "mail_send",
            '(record { client_id = "c"; to = vec { "x@y.example" }; cc = vec {}; '
            'bcc = vec {}; subject = "s"; html_body = "b"; attachments = vec {} })',
        ),
        (
            "mail_cal_put",
            '(record { uid = "x"; vevent = "BEGIN:VEVENT\\r\\nUID:x\\r\\n'
            'END:VEVENT"; starts = 0 : nat64; ends = 0 : nat64; vtimezones = vec {} })',
        ),
        ("mail_cal_delete", '("x")'),
        ("mail_cal_feed_reset", "()"),
        ("mail_cal_feed_stop", "()"),
    ]:
        assert "downloading:" in mail(method, "alice", argument, USER_A), method

    assert re.search(
        OK, deliver("Held otter", "<otter@sender.example>", to="alice,bob")
    )
    wait_for("bob", "otter")  # another mailbox goes on as usual
    time.sleep(2)
    assert not found("alice", "otter")
    assert stats()["queued"] == 1
    assert number(chunk(USER_A, 0, 10), "size") == size

    thaw(USER_A, started)
    wait_for("alice", "otter")
    assert "downloading:" not in mail(
        "mail_set_flags",
        MAILBOX[USER_A],
        "(vec { 1 : nat64 }, 1 : nat64, 0 : nat64)",
        USER_A,
    )


def test__a_lapsed_download_cannot_be_read_and_mail_moves_on_its_own() -> None:
    call("dev_set_export_timing", f"(3_000_000_000 : nat64, {LIMIT_NS} : nat64)")
    freeze(USER_A)
    assert re.search(OK, deliver("Late lynx", "<lynx@sender.example>"))
    time.sleep(4)
    assert "no download is under way" in chunk(USER_A, 0)
    wait_for("alice", "lynx")


def test__renewals_never_hold_the_file_past_the_limit() -> None:
    call("dev_set_export_timing", "(5_000_000_000 : nat64, 6_000_000_000 : nat64)")
    _, started, _ = freeze(USER_A)
    time.sleep(2)
    output = renewal(USER_A, started)
    renewed, until = number(output, "started_ns"), number(output, "until_ns")
    assert renewed == started
    assert until == started + 6_000_000_000
    time.sleep(5)
    assert "the download has ended" in renewal(USER_A, started)
    _, restarted, _ = freeze(USER_A)
    assert restarted > started, "a lapsed download starts again, under a new name"


def test__a_thaw_ends_only_the_download_it_names() -> None:
    _, started, _ = freeze(USER_A)
    thaw(USER_A, started - 1)
    assert "no download is under way" not in chunk(USER_A, 0, 10)
    thaw(USER_A, started)
    assert "no download is under way" in chunk(USER_A, 0, 10)

    # A tab whose download ended can neither renew nor end the next one
    _, later, _ = freeze(USER_A)
    assert later != started
    assert "the download has ended" in renewal(USER_A, started)
    thaw(USER_A, started)
    assert "no download is under way" not in chunk(USER_A, 0, 10)


def test__one_download_at_a_time() -> None:
    _, started, _ = freeze(USER_A)
    assert "a download is already under way" in mail(
        "mail_export_freeze", MAILBOX[USER_A], "(null)", USER_A
    )
    assert number(renewal(USER_A, started), "started_ns") == started


def test__a_download_reads_only_the_callers_own_mailbox() -> None:
    freeze(USER_A)
    assert "no download is under way" in chunk(USER_B, 0)
    assert "a chunk is at most" in chunk(USER_A, 0, 1_900_001)


def test__a_purge_ends_the_download(users: Dict[str, str]) -> None:
    freeze(USER_C)
    purge("carol")
    add_mailbox("carol", users[USER_C])
    assert "no download is under way" in chunk(USER_C, 0)
    assert freeze(USER_C)[0] > 0


def test__removing_a_member_ends_their_download_and_mail_moves_at_once(
    users: Dict[str, str],
) -> None:
    add_mailbox("crew", users[USER_A])
    add_member("crew", users[USER_B])
    freeze(USER_B, "crew")
    assert re.search(OK, deliver("Held gannet", "<gannet@sender.example>", to="crew"))
    time.sleep(2)
    assert not found("crew", "gannet")
    call("admin_remove_member", f'("crew", principal "{users[USER_B]}")')
    # Well before the download's own hold would have ended
    wait_for("crew", "gannet", 20)
    assert "downloading:" not in mail(
        "mail_delete", "crew", "(vec { 999 : nat64 }, 0 : nat64)", USER_A
    )


def test__in_a_shared_mailbox_a_download_is_its_members_alone(
    users: Dict[str, str],
) -> None:
    add_mailbox("team", users[USER_A])
    add_member("team", users[USER_B])
    _, started, _ = freeze(USER_A, "team")
    try:
        assert "no download is under way" in chunk(USER_B, 0, 10, "team")
        assert "the download has ended" in renewal(USER_B, started, "team")
        assert "already under way" in mail(
            "mail_export_freeze", "team", "(null)", USER_B
        )
        assert "downloading:" in mail(
            "mail_delete", "team", "(vec { 1 : nat64 }, 0 : nat64)", USER_B
        )
        thaw(USER_B, started, "team")  # ends nothing
        assert number(chunk(USER_A, 0, 10, "team"), "started_ns") == started
    finally:
        thaw(USER_A, started, "team")
    assert "no download is under way" in chunk(USER_A, 0, 10, "team")
