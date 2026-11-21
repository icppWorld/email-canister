"""The outbox against a stub of the bridge, on a local replica.

$ make build-test
$ make build-relay-stub
$ icp network start -d
$ pytest --network=local --identity=$TEST_IDENTITY test/canister/test_outbox.py

Reinstalls the email-canister-test and relay_stub canisters, which erases their state.
"""

# pylint: disable=missing-function-docstring, redefined-outer-name, unused-argument

import base64
import re
import time
from typing import Any, Dict, List, Optional

import pytest
from .toolchain import call_canister_api

from .support import (
    CANISTER_NAME,
    DOMAIN,
    ICP_YAML_PATH,
    add_mailbox,
    add_member,
    call,
    entry_line,
    icp,
    mail,
    number,
    purge,
    text,
)
from .test_mailbox import NO_MAILBOX, NOBODY, USER_A, USER_B, USER_C, principal_of

# The mailbox each user sends from: carol is nobody's, then user C's
MAILBOX = {USER_A: "alice", USER_B: "bob", NOBODY: "carol", USER_C: "carol"}

QUEUED, SENDING, SENT, REJECTED, UNKNOWN = 0, 1, 2, 3, 4
STUB = "relay_stub"
WEEK_NS = 7 * 24 * 3600 * 1_000_000_000
RETRY_NS, DEADLINE_NS, DAY_NS = 1_000_000_000, 600_000_000_000, 86_400_000_000_000
G_SERIAL = 0


def stub(method: str, argument: str = "()") -> str:
    return call_canister_api(
        icp_yaml_path=ICP_YAML_PATH,
        canister_name=STUB,
        canister_method=method,
        canister_argument=argument,
        network="local",
    )


def stats() -> Dict[str, int]:
    output = stub("stub_stats")
    return {
        name: number(output, name) for name in ("calls", "sends", "max_sends_per_key")
    }


def timing(retry_ns: int, deadline_ns: int, abandon_ns: int = DAY_NS) -> None:
    call(
        "dev_outbox_timing",
        f"({retry_ns} : nat64, {deadline_ns} : nat64, {abandon_ns} : nat64)",
    )


def crash(point: str) -> None:
    call("dev_outbox_crash", f'("{point}")')


def send_argument(
    client_id: str,
    subject: str = "Hello",
    to: str = "friend@example.org",
    attachment: Optional[bytes] = None,
    html: str = "<p>hi</p>",
) -> str:
    files = ""
    if attachment is not None:
        blob = "".join(f"\\{byte:02x}" for byte in attachment)
        files = f'record {{ filename = "a.bin"; content = blob "{blob}" }}'
    recipients = "; ".join(f'"{address}"' for address in to.split(",") if address)
    return (
        f'(record {{ client_id = "{client_id}"; to = vec {{ {recipients} }}; '
        "cc = vec {}; "
        f'bcc = vec {{}}; subject = "{subject}"; html_body = "{html}"; '
        f"attachments = vec {{ {files} }} }})"
    )


def client_id() -> str:
    global G_SERIAL  # pylint: disable=global-statement
    G_SERIAL += 1
    return f"client-{G_SERIAL}"


def send(user: str = USER_A, local: str = "", **kwargs: Any) -> int:
    output = mail(
        "mail_send",
        local or MAILBOX[user],
        send_argument(kwargs.pop("cid", client_id()), **kwargs),
        user,
    )
    found = re.search(r"\(([\d_]+)\s*(?::\s*nat64)?,?\s*\)", output)
    assert found, output
    return int(found.group(1).replace("_", ""))


def get(message: int, user: str = USER_A, local: str = "") -> str:
    return mail("mail_outbox_get", local or MAILBOX[user], f"({message} : nat64)", user)


def state(message: int, user: str = USER_A, local: str = "") -> int:
    return number(get(message, user, local), "state")


def wait_for(
    message: int, wanted: int, user: str = USER_A, local: str = "", seconds: float = 40
) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if state(message, user, local) == wanted:
            return
        time.sleep(0.25)
    raise AssertionError(
        f"state {state(message, user)}, wanted {wanted}: {get(message, user)}"
    )


def wait_for_sends(wanted: int, seconds: float = 40, name: str = "sends") -> None:
    """Until the stub's count `name` reaches `wanted`"""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if stats()[name] >= wanted:
            return
        time.sleep(0.25)
    raise AssertionError(f"{name}: {stats()}")


def used(local: str = "alice") -> int:
    return number(entry_line(local), "used_bytes")


def delete_many(messages: List[int], user: str = USER_A, local: str = "") -> str:
    ids = "; ".join(f"{message} : nat64" for message in messages)
    return mail(
        "mail_outbox_delete_many", local or MAILBOX[user], f"(vec {{ {ids} }})", user
    )


def deleted_ids(output: str) -> List[int]:
    """The ids in a vec nat64 reply, which may span several lines"""
    return [
        int(n.replace("_", "")) for n in re.findall(r"([\d_]+)\s*:\s*nat64", output)
    ]


@pytest.fixture(scope="module", autouse=True)
def canister(network: str, identity: str) -> None:
    icp(
        "deploy", CANISTER_NAME, STUB, "--mode", "reinstall", "--yes", identity=identity
    )
    call("admin_set_domain", f'("{DOMAIN}")')
    add_mailbox("alice", principal_of(USER_A))
    add_mailbox("bob", principal_of(USER_B))


@pytest.fixture(autouse=True)
def fresh(request: Any, identity: str) -> None:
    if "before_bridge" not in request.node.name:
        stub_id = icp(
            "canister", "status", STUB, "--id-only", identity=identity
        ).strip()
        call("admin_set_bridge", f'(principal "{stub_id}")')
    stub("stub_reset")
    timing(RETRY_NS, DEADLINE_NS)
    crash("")


def test__before_bridge_sending_is_refused() -> None:
    before = used()
    output = mail("mail_send", MAILBOX[USER_A], send_argument(client_id()), USER_A)
    assert "not configured" in output
    assert used() == before


def test__message_is_sent_from_the_callers_own_address() -> None:
    message = send(subject="Direct", to="one@example.org,two@example.org")
    wait_for(message, SENT)
    output = stub("stub_stats")
    assert text(output, "last_from") == "alice"
    assert text(output, "last_subject") == "Direct"
    assert "one@example.org" in output and "two@example.org" in output
    assert stats()["sends"] == 1


def test__repeated_client_id_sends_once() -> None:
    cid = client_id()
    first = send(cid=cid, subject="Once")
    second = send(cid=cid, subject="Once")
    assert first == second
    wait_for(first, SENT)
    time.sleep(2)
    assert stats()["sends"] == 1


def test__same_client_id_is_separate_per_mailbox() -> None:
    cid = client_id()
    first = send(USER_A, cid=cid)
    second = send(USER_B, cid=cid)
    wait_for(first, SENT)
    wait_for(second, SENT, USER_B)
    assert stats()["sends"] == 2


def test__a_file_that_cannot_be_opened_holds_up_no_other_mailbox() -> None:
    call("dev_hide_file", '("alice", true)')  # alice is now due first, and fails
    try:
        message = send(USER_B)
        wait_for(message, SENT, USER_B)
    finally:
        call("dev_hide_file", '("alice", false)')


@pytest.mark.parametrize(
    "to,fragment",
    [
        ("", "no recipients"),
        ("nobody", "invalid address"),
        ("a@b@c.example", "invalid address"),
        ("a b@c.example", "invalid address"),
        ("<a@b.example>", "invalid address"),
    ],
)
def test__bad_recipients_are_refused(to: str, fragment: str) -> None:
    before = used()
    assert fragment in mail(
        "mail_send", MAILBOX[USER_A], send_argument(client_id(), to=to), USER_A
    )
    assert used() == before


def test__too_many_recipients_are_refused() -> None:
    to = ",".join(f"r{n}@example.org" for n in range(51))
    assert "too many" in mail(
        "mail_send", MAILBOX[USER_A], send_argument(client_id(), to=to), USER_A
    )


def test__header_injection_in_the_subject_is_refused() -> None:
    output = mail(
        "mail_send",
        MAILBOX[USER_A],
        send_argument(client_id(), subject="x\\r\\nBcc: evil@example.org"),
        USER_A,
    )
    assert "invalid subject" in output


def test__oversize_is_refused_before_it_is_queued() -> None:
    before = used()
    done = mail(
        "mail_send",
        MAILBOX[USER_A],
        send_argument(client_id(), attachment=b"x" * 1_500_000),
        USER_A,
    )
    assert "this message is too large to send" in done, done
    assert used() == before
    assert stats()["calls"] == 0


def test__oversize_is_counted_as_the_bridge_escapes_it() -> None:
    # 1 MB of quotes is 2 MB once escaped in the bridge's JSON
    done = mail(
        "mail_send",
        MAILBOX[USER_A],
        send_argument(client_id(), html='\\"' * 1_000_000),
        USER_A,
    )
    assert "this message is too large to send" in done, done
    assert stats()["calls"] == 0


def test__large_attachment_reaches_the_bridge_intact() -> None:
    content = bytes(n * 37 % 256 for n in range(1_400_000))
    message = send(attachment=content)
    wait_for(message, SENT)
    assert (
        text(stub("stub_stats"), "last_attachment")
        == base64.b64encode(content).decode()
    )


def test__full_mailbox_is_refused_before_it_is_queued() -> None:
    call("admin_set_quota", f'("alice", {used()} : nat64)')
    try:
        before = used()
        assert "full" in mail(
            "mail_send", MAILBOX[USER_A], send_argument(client_id()), USER_A
        )
        assert used() == before
    finally:
        call("admin_set_quota", '("alice", 2147483648 : nat64)')


def test__crash_after_enqueue_leaves_nothing_and_can_be_retried() -> None:
    cid = client_id()
    before = used()
    crash("after_enqueue")
    assert "crash" in mail("mail_send", MAILBOX[USER_A], send_argument(cid), USER_A)
    assert used() == before
    crash("")
    message = send(cid=cid)
    wait_for(message, SENT)
    assert stats()["sends"] == 1


def test__crash_before_the_call_keeps_the_message_unsent() -> None:
    crash("before_call")
    message = send()
    time.sleep(3)
    assert state(message) == QUEUED
    assert number(get(message), "attempts") == 0
    assert stats()["calls"] == 0
    crash("")
    wait_for(message, SENT)
    assert stats()["sends"] == 1


def test__crash_after_the_call_retries_without_sending_twice() -> None:
    crash("after_call")
    message = send()
    wait_for_sends(1)
    time.sleep(3)
    assert state(message) == SENDING
    calls = stats()["calls"]
    assert calls >= 2, "the retries are what this test is about"
    crash("")
    wait_for(message, SENT)
    assert stats()["sends"] == 1
    assert stats()["max_sends_per_key"] == 1


def test__lost_reply_is_retried_without_sending_twice() -> None:
    stub("stub_set_mode", '("drop")')
    message = send()
    wait_for_sends(1)
    stub("stub_set_mode", '("sent")')
    wait_for(message, SENT)
    assert stats()["sends"] == 1


def test__bridge_trap_is_retried_until_it_recovers() -> None:
    stub("stub_set_mode", '("trap")')
    message = send()
    time.sleep(3)
    assert state(message) == SENDING
    assert "out of cycles" in text(get(message), "last_error")
    stub("stub_set_mode", '("sent")')
    wait_for(message, SENT)
    assert stats()["sends"] == 1


def test__sending_at_the_bridge_is_polled_until_it_finishes() -> None:
    stub("stub_set_mode", '("sending")')
    message = send()
    wait_for_sends(1)
    time.sleep(2.5)
    assert state(message) == SENDING
    stub("stub_finish", '("sent")')
    wait_for(message, SENT)
    assert stats()["sends"] == 1


def test__bridge_unknown_is_final_until_the_owner_decides() -> None:
    stub("stub_set_mode", '("unknown")')
    message = send()
    wait_for(message, UNKNOWN)
    calls = stats()["calls"]
    time.sleep(3)
    assert stats()["calls"] == calls, "unknown mail must never be retried by itself"

    stub("stub_set_mode", '("sent")')
    mail("mail_outbox_resend", MAILBOX[USER_A], f"({message} : nat64)", USER_A)
    wait_for(message, SENT)
    key_two = text(stub("stub_stats"), "last_key")
    assert key_two.endswith("-1")
    assert stats()["max_sends_per_key"] == 1


def test__mail_sending_for_a_day_becomes_unknown_without_a_call() -> None:
    crash("after_call")
    message = send()
    wait_for_sends(1)
    timing(RETRY_NS, DEADLINE_NS, 1)
    wait_for(message, UNKNOWN)
    calls = stats()["calls"]
    crash("")
    time.sleep(3)
    assert stats()["calls"] == calls, "the bridge may have forgotten its key by now"
    assert "no outcome for a day" in text(get(message), "last_error")


def test__no_outcome_by_the_deadline_becomes_unknown() -> None:
    timing(500_000_000, 2_000_000_000)
    stub("stub_set_mode", '("trap")')
    message = send()
    wait_for(message, UNKNOWN)
    assert number(get(message), "attempts") >= 2
    calls = stats()["calls"]
    time.sleep(2)
    assert stats()["calls"] == calls


def test__rejected_is_not_sent_and_can_be_resent() -> None:
    stub("stub_set_mode", '("rejected")')
    message = send()
    wait_for(message, REJECTED)
    assert stats()["sends"] == 0
    assert "HTTP 400" in text(get(message), "last_error")
    stub("stub_set_mode", '("sent")')
    mail("mail_outbox_resend", MAILBOX[USER_A], f"({message} : nat64)", USER_A)
    wait_for(message, SENT)
    assert stats()["sends"] == 1


def test__sent_mail_cannot_be_resent() -> None:
    message = send()
    wait_for(message, SENT)
    assert "only rejected or unknown" in mail(
        "mail_outbox_resend", MAILBOX[USER_A], f"({message} : nat64)", USER_A
    )


def test__mail_being_sent_cannot_be_deleted() -> None:
    stub("stub_set_mode", '("trap")')
    message = send()
    time.sleep(2)
    assert "being sent" in mail(
        "mail_outbox_delete", MAILBOX[USER_A], f"({message} : nat64)", USER_A
    )
    stub("stub_set_mode", '("sent")')
    wait_for(message, SENT)


def test__deleted_queued_mail_is_never_sent() -> None:
    before = used()
    crash("before_call")
    message = send()
    mail("mail_outbox_delete", MAILBOX[USER_A], f"({message} : nat64)", USER_A)
    crash("")
    # bob's later message is sent once the worker has passed alice's
    wait_for(send(USER_B), SENT, USER_B)
    assert stats()["calls"] == 1
    assert used() == before


def test__mail_deleted_many_at_once_is_never_sent() -> None:
    before = used()
    crash("before_call")
    first, second = send(), send()
    assert sorted(deleted_ids(delete_many([first, second]))) == [first, second]
    crash("")
    # bob's later message is sent once the worker has passed alice's
    wait_for(send(USER_B), SENT, USER_B)
    assert stats()["calls"] == 1
    assert used() == before


def test__a_download_holds_the_outbox_until_it_ends() -> None:
    crash("before_call")
    message = send()
    started = number(
        mail("mail_export_freeze", MAILBOX[USER_A], "(null)", USER_A), "started_ns"
    )
    crash("")
    # bob's later message is sent once the worker has passed alice's
    wait_for(send(USER_B), SENT, USER_B)
    assert state(message) == QUEUED
    assert stats()["calls"] == 1
    mail("mail_export_thaw", MAILBOX[USER_A], f"({started} : nat64)", USER_A)
    wait_for(message, SENT)
    assert stats()["sends"] == 2


def test__an_unreadable_bridge_reply_is_retried() -> None:
    stub("stub_set_mode", '("garbage")')
    message = send()
    wait_for_sends(2, name="calls")  # the retries are what this test is about
    assert state(message) == SENDING
    assert text(get(message), "last_error") != ""
    stub("stub_set_mode", '("sent")')
    wait_for(message, SENT)
    assert stats()["sends"] == 1


def test__delete_frees_the_quota() -> None:
    before = used()
    message = send()
    wait_for(message, SENT)
    assert used() > before
    mail("mail_outbox_delete", MAILBOX[USER_A], f"({message} : nat64)", USER_A)
    assert used() == before
    assert "no such message" in get(message)


def test__outbox_is_private_to_its_owner() -> None:
    message = send(subject="Mine alone")
    wait_for(message, SENT)
    # Ids are per mailbox: bob's must not reach this one
    theirs = mail(
        "mail_outbox_list",
        MAILBOX[USER_B],
        "(record { cursor = null; limit = 100 : nat64 })",
        USER_B,
    )
    assert all(
        int(n.replace("_", "")) < message
        for n in re.findall(r"\bid = ([\d_]+)", theirs)
    )
    assert "no such message" in get(message, USER_B)
    assert "only rejected" in mail(
        "mail_outbox_resend", MAILBOX[USER_B], f"({message} : nat64)", USER_B
    )
    assert "no such message" in mail(
        "mail_outbox_delete", MAILBOX[USER_B], f"({message} : nat64)", USER_B
    )
    listed = mail(
        "mail_outbox_list",
        MAILBOX[USER_B],
        "(record { cursor = null; limit = 100 : nat64 })",
        USER_B,
    )
    assert "Mine alone" not in listed
    assert state(message) == SENT


def test__outbox_deletes_many_for_its_owner_only() -> None:
    message = send(subject="Kept")
    wait_for(message, SENT)
    assert NO_MAILBOX in delete_many([message], USER_B, MAILBOX[USER_A])
    assert state(message) == SENT


def test__disabled_mailbox_stops_sending() -> None:
    crash("before_call")
    message = send(USER_B)
    call("admin_set_disabled", '("bob", true)')
    crash("")
    time.sleep(3)
    assert stats()["calls"] == 0
    call("admin_set_disabled", '("bob", false)')
    wait_for(message, SENT, USER_B)


def upgrade(identity: str) -> None:
    icp("canister", "stop", CANISTER_NAME, identity=identity)
    icp("deploy", CANISTER_NAME, "--mode", "upgrade", "--yes", identity=identity)
    icp("canister", "start", CANISTER_NAME, identity=identity)
    timing(RETRY_NS, DEADLINE_NS)


def test__queued_mail_survives_an_upgrade(identity: str) -> None:
    crash("before_call")
    messages: List[int] = [send() for _ in range(3)]
    time.sleep(1)
    assert stats()["calls"] == 0
    upgrade(identity)  # which also clears the crash point
    for message in messages:
        wait_for(message, SENT, seconds=120)
    assert stats()["sends"] == 3
    assert stats()["max_sends_per_key"] == 1


def test__mail_in_doubt_survives_an_upgrade_without_a_second_send(
    identity: str,
) -> None:
    crash("after_call")
    message = send()
    wait_for_sends(1)
    time.sleep(1)
    upgrade(identity)
    wait_for(message, SENT, seconds=120)
    assert stats()["sends"] == 1


def test__a_deleted_newest_message_never_lends_its_key() -> None:
    first = send()
    wait_for(first, SENT)
    first_key = text(stub("stub_stats"), "last_key")
    sends = stats()["sends"]
    mail("mail_outbox_delete", MAILBOX[USER_A], f"({first} : nat64)", USER_A)
    second = send()
    assert second > first, "a deleted newest id is not given out again"
    wait_for(second, SENT)
    assert (
        stats()["sends"] == sends + 1
    ), "the bridge must not answer with the old result"
    assert text(stub("stub_stats"), "last_key") != first_key


def test__key_names_the_mailbox_the_message_and_the_attempt() -> None:
    message = send()
    wait_for(message, SENT)
    key = text(stub("stub_stats"), "last_key").split("-")
    assert len(key) == 4 and key[2:] == [
        str(message),
        "0",
    ]  # prefix-mailbox-id-generation
    assert key[1] == "1", "alice was the first mailbox"


def test__purge_removes_sent_mail_too() -> None:
    nobody = NOBODY
    add_mailbox("carol", principal_of(nobody))
    message = send(nobody, subject="Carol wrote this")
    wait_for(message, SENT, nobody)
    assert used("carol") > 0
    purge("carol")
    assert used("carol") == 0
    assert NO_MAILBOX in get(message, nobody)
    assert "vacant = true" in entry_line("carol")

    # A new owner of the address never reuses an id, so never a bridge key
    owner = USER_C
    add_mailbox("carol", principal_of(owner))
    assert "vec {}" in mail(
        "mail_outbox_list",
        MAILBOX[owner],
        "(record { cursor = null; limit = 10 : nat64 })",
        owner,
    )
    sends = stats()["sends"]
    newer = send(owner, subject="The new carol")
    assert newer > message
    wait_for(newer, SENT, owner)
    assert (
        stats()["sends"] == sends + 1
    ), "the bridge must not answer with the old result"


def test__a_shared_mailbox_sends_from_its_own_address_and_names_the_sender() -> None:
    add_mailbox("team", principal_of(USER_A))
    add_member("team", principal_of(USER_B))
    call("admin_set_name", f'(principal "{principal_of(USER_A)}", "Alice")')
    message = send(USER_A, "team", subject="From us")
    wait_for(message, SENT, USER_B, "team")
    assert text(stub("stub_stats"), "last_from") == "team"
    listed = mail(
        "mail_outbox_list",
        "team",
        "(record { cursor = null; limit = 10 : nat64 })",
        USER_B,
    )
    assert f'sent_by = principal "{principal_of(USER_A)}"' in listed
    assert 'sent_by_name = opt "Alice"' in listed
    # Each member's own mailbox has none of it
    assert "From us" not in mail(
        "mail_outbox_list",
        "bob",
        "(record { cursor = null; limit = 10 : nat64 })",
        USER_B,
    )


def outbox_of(user: str, local: str = "") -> str:
    return mail(
        "mail_outbox_list",
        local or MAILBOX[user],
        "(record { cursor = null; limit = 0 : nat64 })",
        user,
    )


def test__a_retry_from_another_of_the_senders_mailboxes_is_refused() -> None:
    add_mailbox("crew", principal_of(USER_A))
    add_member("crew", principal_of(USER_B))
    cid = client_id()
    first = send(USER_A, "crew", cid=cid, subject="Crew first")
    # It may have gone out from crew, and a message cannot be recalled
    assert "already queued from crew@" in mail(
        "mail_send", MAILBOX[USER_A], send_argument(cid), USER_A
    )
    # Crew answers with the message it holds, as before
    assert send(USER_A, "crew", cid=cid) == first
    # Another member's client_id is theirs alone
    bobs = send(USER_B, cid=cid, subject="Bob own")
    assert "Bob own" in outbox_of(USER_B)
    assert outbox_of(USER_B, "crew").count("Crew first") == 1
    wait_for(first, SENT, USER_A, "crew")
    wait_for(bobs, SENT, USER_B)
    # Once it went out, deleting it changes none of that
    sends = stats()["sends"]
    mail("mail_outbox_delete", "crew", f"({first} : nat64)", USER_A)
    assert "already queued from crew@" in mail(
        "mail_send", MAILBOX[USER_A], send_argument(cid), USER_A
    )
    assert send(USER_A, "crew", cid=cid) == first
    assert "Crew first" not in outbox_of(USER_A, "crew")
    assert stats()["sends"] == sends


def test__a_client_id_is_free_again_after_the_window() -> None:
    add_mailbox("wing", principal_of(USER_A))
    cid = client_id()
    send(USER_A, "wing", cid=cid, subject="Wing window")
    call("dev_set_dedupe_window", "(1 : nat64)")
    try:
        send(USER_A, cid=cid, subject="Alice window")
    finally:
        call("dev_set_dedupe_window", f"({WEEK_NS} : nat64)")
    assert "Alice window" in outbox_of(USER_A)


def test__a_resend_deleted_before_its_try_keeps_its_client_id() -> None:
    # The first try may have gone out, though the resend's never started
    add_mailbox("tern", principal_of(USER_A))
    stub("stub_set_mode", '("unknown")')
    cid = client_id()
    message = send(USER_A, "tern", cid=cid)
    wait_for(message, UNKNOWN, USER_A, "tern")
    crash("before_call")
    try:
        assert (
            mail("mail_outbox_resend", "tern", f"({message} : nat64)", USER_A) == "()"
        )
        assert number(get(message, USER_A, "tern"), "attempts") == 0
        assert (
            mail("mail_outbox_delete", "tern", f"({message} : nat64)", USER_A) == "()"
        )
        assert "no such message" in get(message, USER_A, "tern")
    finally:
        crash("")
        stub("stub_set_mode", '("sent")')
    assert "already queued from tern@" in mail(
        "mail_send", MAILBOX[USER_A], send_argument(cid), USER_A
    )
