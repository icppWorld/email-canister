"""A mailbox file's check, the mailbox held for repair, and file schema
upgrades by the pump, on a local replica.

$ make build-test
$ icp network start -d
$ pytest --network=local --identity=$TEST_IDENTITY test/canister/test_check.py

Reinstalls the email-canister-test canister, which erases its mail. With
MEASURE=1, the check's cost is measured on a mailbox of about 100 MB.
"""

# pylint: disable=missing-function-docstring, redefined-outer-name, unused-argument

import os
import re
import time

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
    number,
    purge,
    search,
    stats,
    text,
    wait_until,
    wait_until_drained,
)
from .test_mailbox import seed
from .test_storage import nat, stat


@pytest.fixture(scope="module", autouse=True)
def canister(network: str, identity: str) -> None:
    icp("deploy", CANISTER_NAME, "--mode", "reinstall", "--yes", identity=identity)
    call("admin_set_domain", f'("{DOMAIN}")')
    for n, local in enumerate(("alice", "bob", "carol"), start=1):
        add_mailbox(local, fake_principal(n))


def check(local: str, table: str = "null") -> str:
    output = call("admin_check", f'("{local}", {table})')
    assert "instructions" in output, output
    return text(output, "result")


def test__a_schema_step_reaches_every_file_through_the_pump() -> None:
    for local in ("alice", "bob"):
        assert re.search(
            OK, deliver(f"Before pika {local}", f"<pika-{local}@x.example>", to=local)
        )
    wait_until_drained()
    assert len(search("pika")) == 2

    call("dev_schema_step", '("CREATE TABLE extra(x)")')
    # Mail that arrives meanwhile waits for its mailbox's upgrade
    assert re.search(OK, deliver("During vole", "<vole@x.example>", to="alice"))
    wait_until(
        lambda: len(search("pika")) == 2 and len(search("vole")) == 1, "the upgrade"
    )
    for local in ("alice", "bob", "carol"):
        call("dev_file_exec", f'("{local}", "INSERT INTO extra VALUES(1)")')
        assert check(local) == "ok"


def test__a_damaged_file_is_held_until_a_purge_and_holds_up_no_other() -> None:
    assert re.search(OK, deliver("Doomed tapir", "<tapir@x.example>", to="carol"))
    wait_until_drained()
    call("dev_damage_file", '("carol", "messages")')
    assert check("carol", 'opt "outbox"') == "ok"
    assert "needs_repair = null" in entry_line("carol"), "a table check holds nothing"
    found = check("carol")
    assert found != "ok"
    assert f'needs_repair = opt "{found[:20]}' in entry_line("carol")

    # Mail for carol waits in the queue; alice's goes on
    queued = stats()["queued"]
    assert re.search(OK, deliver("Held okapi", "<okapi@x.example>", to="carol,alice"))
    wait_until(lambda: len(search("okapi")) == 1, "alice's delivery")
    time.sleep(3)
    assert stats()["queued"] == queued + 1
    assert search("tapir") == [], "a held mailbox is not searched"

    # Held mail does not count toward the canister-wide backlog cap
    call("dev_set_backlog_cap", "(100 : nat64, 1 : nat64)")
    try:
        assert re.search(OK, deliver("Free numbat", "<numbat2@x.example>", to="alice"))
    finally:
        call("dev_set_backlog_cap", "(100 : nat64, 1000 : nat64)")
    wait_until(lambda: len(search("numbat")) == 1, "alice's second delivery")

    purge("carol")
    assert stats()["queued"] == queued
    add_mailbox("carol", fake_principal(3))
    assert check("carol") == "ok"
    assert "needs_repair = null" in entry_line("carol")


def test__a_failed_query_does_not_end_the_upgrades() -> None:
    # bob's file cannot be opened, so the pump defers him and finds no other
    # file waiting. Its check whether any file still waits then fails: were
    # that read as "none", the pump would never look for bob again.
    pending = '("SELECT 1 FROM mailboxes WHERE retry_after_ns <")'
    call("dev_hide_file", '("bob", true)')
    call("dev_fail_statements", pending)
    try:
        call("dev_schema_step", '("CREATE TABLE later(x)")')
        wait_until(
            lambda: nat(call("dev_fail_statements", pending)) > 0, "the failed query"
        )
    finally:
        call("dev_fail_statements", '("")')
        call("dev_hide_file", '("bob", false)')
    wait_until(
        lambda: "Failed"
        not in call("dev_file_exec", '("bob", "INSERT INTO later VALUES(1)")'),
        "bob's upgrade",
    )


def test__a_check_of_a_large_mailbox_fits_in_one_call() -> None:
    count = 100_000 if os.environ.get("MEASURE") == "1" else 10_000
    seed("bob", count)
    file_bytes = stat("m/0/2/mail.db")
    assert file_bytes, "no file for bob"
    output = call("admin_check", '("bob", null)')
    assert text(output, "result") == "ok", output
    spent = number(output, "instructions")
    per_mb = spent / (file_bytes / 1e6)
    print(
        f"admin_check of {file_bytes / 1e6:.0f} MB: {spent:,} instructions, "
        f"{per_mb:,.0f} per MB, so about {40e9 / per_mb / 1e3:.1f} GB in one call"
    )
    # A file of 2 GiB must fit in the 40B limit. A mailbox at the default 2 GiB
    # quota of small mail is a larger file, about 3 GB, which does not
    assert per_mb * 2_147 < 40e9, f"{per_mb:,.0f} instructions per MB"

    output = call("admin_check", '("bob", opt "fts")')
    assert text(output, "result") == "ok", output
    per_mb = number(output, "instructions") / (file_bytes / 1e6)
    print(
        f"the search index's check: {per_mb:,.0f} instructions per MB of the "
        f"file, so about {40e9 / per_mb / 1e3:.1f} GB in one call"
    )
