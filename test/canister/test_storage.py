"""One database file per mailbox, on a local replica.

$ make build-test
$ icp network start -d
$ pytest --network=local --identity=$TEST_IDENTITY test/canister/test_storage.py

Reinstalls the email-canister-test canister, which erases its mail.
"""

# pylint: disable=missing-function-docstring, redefined-outer-name, unused-argument

import re
import time
from typing import Optional

import pytest

from .support import (
    CANISTER_NAME,
    DOMAIN,
    OK,
    add_mailbox,
    call,
    deliver,
    entry_line,
    fake_principal,
    icp,
    run_icp,
    number,
    purge,
    request,
    search,
    stats,
    wait_until_drained,
)

WEEK_NS = 7 * 24 * 3600 * 1_000_000_000


def stat(path: str) -> Optional[int]:
    found = re.search(r"opt \(?([\d_]+)", call("dev_stat", f'("{path}")'))
    return int(found.group(1).replace("_", "")) if found else None


def nat(output: str) -> int:
    found = re.search(r"\(([\d_]+)", output)
    assert found, output
    return int(found.group(1).replace("_", ""))


def cost(method: str) -> int:
    return nat(call("dev_last_cost", f'("{method}")'))


def assert_cost(method: str, label: str, bound: int) -> None:
    spent = cost(method)
    print(f"{label}: {spent:,} instructions")
    assert spent < bound, f"{label}: {spent:,} instructions"


def database_bytes() -> int:
    return number(call("admin_storage_totals"), "database_bytes")


@pytest.fixture(scope="module", autouse=True)
def canister(network: str, identity: str) -> None:
    icp("deploy", CANISTER_NAME, "--mode", "reinstall", "--yes", identity=identity)
    call("admin_set_domain", f'("{DOMAIN}")')
    add_mailbox("alice", fake_principal(1))  # mailbox 1
    add_mailbox("bob", fake_principal(2))  # mailbox 2


def test__each_mailbox_has_its_own_file() -> None:
    assert stat("control.db")
    assert stat("m/0/1/mail.db")
    assert stat("m/0/2/mail.db")
    assert stat("m/0/3/mail.db") is None


def test__a_purge_deletes_the_file_and_uids_continue_after_it() -> None:
    add_mailbox("erin", fake_principal(3))  # mailbox 3
    assert re.search(
        OK, deliver("Before purge kiwi", "<kiwi1@sender.example>", to="erin")
    )
    wait_until_drained()
    [(_, before)] = search("kiwi")

    purge("erin")
    assert stat("m/0/3/mail.db") is None
    assert stat("m/0/3") is None
    assert stat("m/0") is not None, "other mailboxes share the bucket"

    add_mailbox("erin", fake_principal(4))
    assert re.search(
        OK, deliver("After purge kiwi", "<kiwi2@sender.example>", to="erin")
    )
    wait_until_drained()
    [(_, after)] = search("kiwi")
    assert after > before, "a new owner never reuses a uid"


def test__a_file_that_cannot_be_opened_holds_up_no_other_mailbox() -> None:
    # Two of them, which must not hand the pump to each other and starve the moves
    call("dev_hide_file", '("alice", true)')
    call("dev_hide_file", '("erin", true)')
    quarantined = stats()["quarantined"]
    try:
        # Waits for the file instead of using up its attempts
        assert re.search(
            OK, deliver("Hidden plum", "<plum@sender.example>", to="alice")
        )
        for n in range(5):
            assert re.search(
                OK, deliver("Hidden fig", f"<fig{n}@sender.example>", to="bob")
            )
        # A failed claim must not cost the retry delay, 5 s, on each pass
        deadline = time.time() + 15
        while len(search("fig")) < 5:
            assert time.time() < deadline, f"bob's mail was not parsed: {stats()}"
            time.sleep(0.5)
    finally:
        call("dev_hide_file", '("alice", false)')
        call("dev_hide_file", '("erin", false)')
    wait_until_drained()
    assert len(search("plum")) == 1
    assert stats()["quarantined"] == quarantined


def test__no_more_than_32_files_stay_open_and_a_mailbox_is_small() -> None:
    # The file system's own overhead does not show here: it grows stable
    # memory in chunks larger than 40 empty mailboxes need
    before = database_bytes()
    locals_ = [f"box{n}" for n in range(40)]
    for n, local in enumerate(locals_):
        add_mailbox(local, fake_principal(100 + n))
    per_mailbox = (database_bytes() - before) // len(locals_)
    print(f"\nfile bytes per new mailbox: {per_mailbox:,}")
    assert per_mailbox < 128 * 1024

    for start in range(0, len(locals_), 10):
        recipients = ",".join(locals_[start : start + 10])
        assert re.search(
            OK,
            deliver(f"Fanout {start}", f"<fan{start}@sender.example>", to=recipients),
        )
    wait_until_drained()
    assert len(search("fanout")) == len(locals_)
    assert nat(call("dev_cache")) <= 32


def test__accepting_mail_stays_cheap() -> None:
    recipients = ",".join(f"box{n}" for n in range(10))
    assert re.search(
        OK,
        deliver(
            "Ten recipients", "<ten@sender.example>", to=recipients, body=b"x" * 2000
        ),
    )
    assert_cost("smtp_request", "smtp_request to 10 recipients, 2 KB", 15_000_000)
    wait_until_drained()

    output = deliver(
        "Large move", "<move@sender.example>", to="alice", body=b"y" * 100_000
    )
    assert re.search(OK, output), output
    assert_cost("smtp_request", "smtp_request of 100 KB", 50_000_000)
    wait_until_drained()
    assert_cost("ingest_move", "ingest_move of 100 KB", 30_000_000)


def test__a_full_mailbox_defers_only_the_mail_for_it() -> None:
    call("dev_pause", "(true)")
    call("dev_set_backlog_cap", "(2 : nat64, 1000 : nat64)")
    try:
        for n in range(2):
            assert re.search(OK, deliver(f"Capped {n}", f"<capped{n}@sender.example>"))
        assert "code = 451" in deliver("Capped 2", "<capped2@sender.example>")
        # The gateway validates each recipient on its own: only alice waits
        assert "code = 451" in call("smtp_request_validate", request(to="alice"))
        assert re.search(OK, call("smtp_request_validate", request(to="bob")))
        assert "code = 451" in deliver(
            "Capped both quokka", "<capboth@sender.example>", to="bob,alice"
        )
        assert re.search(
            OK, deliver("Not capped", "<notcapped@sender.example>", to="bob")
        )
    finally:
        call("dev_set_backlog_cap", "(100 : nat64, 1000 : nat64)")
        call("dev_pause", "(false)")
    wait_until_drained()
    assert search("quokka") == [], "a deferred message is deferred for everyone"


def test__a_purge_clears_the_mail_still_queued_for_it() -> None:
    add_mailbox("gail", fake_principal(5))
    call("dev_pause", "(true)")
    try:
        before = stats()["queued"]
        for n in range(3):
            assert re.search(
                OK,
                deliver(
                    f"Queued wallaby{n}", f"<wallaby{n}@sender.example>", to="gail"
                ),
            )
        assert stats()["queued"] == before + 3
        purge("gail")
        assert stats()["queued"] == before
    finally:
        call("dev_pause", "(false)")
    wait_until_drained()
    add_mailbox("gail", fake_principal(6))
    for n in range(3):
        assert search(f"wallaby{n}") == []
    assert re.search(OK, deliver("New owner", "<gail-new@sender.example>", to="gail"))
    wait_until_drained()


def test__redelivery_after_the_dedupe_window_still_gives_one_copy() -> None:
    assert re.search(OK, deliver("Late echo", "<echo@sender.example>", to="bob"))
    wait_until_drained()
    used = number(entry_line("bob"), "used_bytes")
    call("dev_set_dedupe_window", "(1 : nat64)")
    try:
        assert re.search(OK, deliver("Late echo", "<echo@sender.example>", to="bob"))
        wait_until_drained()
    finally:
        call("dev_set_dedupe_window", f"({WEEK_NS} : nat64)")
    assert len(search("echo")) == 1
    assert (
        number(entry_line("bob"), "used_bytes") == used
    ), "the second copy's bytes go back"


def test__a_failing_move_is_quarantined_and_can_be_retried() -> None:
    before = stats()
    call("dev_trap_moves", "(true)")
    try:
        assert re.search(
            OK, deliver("Stuck quokka", "<quokka@sender.example>", to="bob")
        )
        current = wait_until_drained()
    finally:
        call("dev_trap_moves", "(false)")
    assert current["quarantined_moves"] == before["quarantined_moves"] + 1
    assert (
        current["quarantined"] == before["quarantined"]
    ), "a parse quarantine is separate"
    assert search("quokka") == []

    assert re.search(r"\(1\b", call("admin_retry_moves", '("bob")'))
    current = wait_until_drained()
    assert current["quarantined_moves"] == before["quarantined_moves"]
    assert len(search("quokka")) == 1


def upgrade(identity: str) -> str:
    """Returns the error of a failed upgrade, or an empty string"""
    icp("canister", "stop", CANISTER_NAME, identity=identity)
    done = run_icp(
        "deploy", CANISTER_NAME, "--mode", "upgrade", "--yes", identity=identity
    )
    icp("canister", "start", CANISTER_NAME, identity=identity)
    return done.stdout + done.stderr if done.returncode else ""


def test__an_upgrade_keeps_the_mail_and_picks_up_the_backlog(identity: str) -> None:
    call("dev_pause", "(true)")
    for n in range(3):
        assert re.search(OK, deliver(f"Upgrade wren{n}", f"<wren{n}@sender.example>"))
    totals = call("admin_storage_totals")
    assert upgrade(identity) == ""
    assert_cost("canister_post_upgrade", "post_upgrade", 10_000_000)
    wait_until_drained()  # the pause was on the heap: the re-armed timer drains it
    assert len(search("wren0")) == len(search("wren1")) == len(search("wren2")) == 1
    assert (
        number(call("admin_storage_totals"), "messages")
        == number(totals, "messages") + 3
    )
    assert len(search("kiwi")) == 1 and len(search("fanout")) == 40
