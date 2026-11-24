"""Mailboxes and their members, the mailbox API and search at scale, on a local
replica.

$ make build-test
$ icp network start -d
$ pytest --network=local --identity=$TEST_IDENTITY test/canister/test_mailbox.py

Reinstalls the email-canister-test canister, which erases its mail. Creates two
local plaintext identities that hold nothing, to act as ordinary users.
"""

# pylint: disable=missing-function-docstring, redefined-outer-name, unused-argument

import re
import subprocess
from pathlib import Path
from typing import Dict, List, Optional

import pytest

from .support import (
    CANISTER_NAME,
    DOMAIN,
    OK,
    add_mailbox,
    add_member,
    call,
    clean_due,
    create_mailbox,
    deliver,
    entry_line,
    fake_principal,
    icp,
    mail,
    number,
    purge,
    record_with,
    stats,
    text,
    wait_until,
    wait_until_drained,
)

DID = (Path(__file__).parent.parent.parent / "src" / "email-canister.did").read_text()
USER_A = "email-canister-test-user-a"
USER_B = "email-canister-test-user-b"
USER_C = "email-canister-test-user-c"
NOBODY = "email-canister-test-nobody"

# The mailbox each user reads; NOBODY's is alice's, from when it is theirs
MAILBOX = {USER_A: "alice", USER_B: "bob", USER_C: "large", NOBODY: "alice"}

ADMIN_CALLS = {
    "admin_set_domain": '("x.example")',
    "admin_set_bridge": '(principal "aaaaa-aa")',
    "admin_settings": "()",
    "admin_create_mailbox": (
        '(record { local = "x"; quota_bytes = null; first_member = null })'
    ),
    "admin_add_member": '("x", principal "aaaaa-aa", null)',
    "admin_remove_member": '("x", principal "aaaaa-aa")',
    "admin_set_name": '(principal "aaaaa-aa", "x")',
    "admin_set_disabled": '("x", true)',
    "admin_set_quota": '("x", 1 : nat64)',
    "admin_purge": '("x")',
    "admin_retry_moves": '("x")',
    "admin_check": '("x", null)',
    "admin_list_entries": "()",
    "admin_ingest_stats": "()",
    "admin_storage_totals": "()",
}
MAILBOX_CALLS = {
    "mail_list": "(record { folder = 0 : nat64; cursor = null; limit = 10 : nat64 })",
    "mail_get": "(1 : nat64)",
    "mail_search": '(record { "query" = "x"; folder = 0 : nat64; cursor = null; '
    "limit = 10 : nat64 })",
    "mail_set_flags": "(vec { 1 : nat64 }, 1 : nat64, 0 : nat64)",
    "mail_delete": "(vec { 1 : nat64 }, 0 : nat64)",
    "mail_move": "(vec { 1 : nat64 }, 1 : nat64)",
    "mail_block": '("x@example.com")',
    "mail_unblock": '("x@example.com")',
    "mail_blocked": "()",
    "mail_send": (
        '(record { client_id = "c"; to = vec { "a@b.example" }; '
        "cc = vec {}; bcc = vec {}; "
        'subject = "s"; html_body = "b"; attachments = vec {} })'
    ),
    "mail_outbox_list": "(record { cursor = null; limit = 10 : nat64 })",
    "mail_outbox_get": "(1 : nat64)",
    "mail_outbox_resend": "(1 : nat64)",
    "mail_outbox_delete": "(1 : nat64)",
    "mail_outbox_delete_many": "(vec { 1 : nat64 })",
    "mail_export_freeze": "(null)",
    "mail_export_thaw": "(0 : nat64)",
    "mail_export_chunk": "(record { offset = 0 : nat64; length = 10 : nat64 })",
    "mail_cal_list": (
        "(record { from = 0 : nat64; to = 1 : nat64; cursor = null; "
        "limit = 10 : nat64 })"
    ),
    "mail_cal_put": (
        '(record { uid = "x"; vevent = "BEGIN:VEVENT\\r\\nUID:x\\r\\nEND:VEVENT"; '
        "starts = 0 : nat64; ends = 0 : nat64; vtimezones = vec {} })"
    ),
    "mail_cal_delete": '("x")',
    "mail_cal_feed": "()",
    "mail_cal_feed_reset": "()",
    "mail_cal_feed_stop": "()",
}


def principal_of(name: str) -> str:
    listed = subprocess.run(
        ["icp", "identity", "list"], capture_output=True, text=True, check=True
    ).stdout
    if not re.search(rf"\b{name}\b", listed):
        subprocess.run(
            ["icp", "identity", "new", name, "--storage", "plaintext", "--quiet"],
            capture_output=True,
            check=True,
        )
    return subprocess.run(
        ["icp", "identity", "principal", "--identity", name],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


@pytest.fixture(scope="module")
def users(network: str, identity: str) -> Dict[str, str]:
    return {name: principal_of(name) for name in (USER_A, USER_B, USER_C, NOBODY)}


@pytest.fixture(scope="module", autouse=True)
def canister(network: str, identity: str, users: Dict[str, str]) -> None:
    icp("deploy", CANISTER_NAME, "--mode", "reinstall", "--yes", identity=identity)
    icp("canister", "top-up", "--amount", "20t", CANISTER_NAME, identity=identity)
    call("admin_set_domain", f'("{DOMAIN}")')
    assert "error" not in add_mailbox("alice", users[USER_A]).lower()
    assert "error" not in add_mailbox("bob", users[USER_B]).lower()


def page(
    user: str,
    cursor: Optional[int] = None,
    limit: int = 100,
    local: str = "",
    folder: int = 0,
) -> str:
    wanted = f"opt ({cursor} : nat64)" if cursor is not None else "null"
    return mail(
        "mail_list",
        local or MAILBOX[user],
        f"(record {{ folder = {folder} : nat64; cursor = {wanted}; "
        f"limit = {limit} : nat64 }})",
        user,
    )


def found(
    user: str,
    query: str,
    cursor: Optional[int] = None,
    limit: int = 50,
    folder: int = 0,
) -> str:
    wanted = f"opt ({cursor} : nat64)" if cursor is not None else "null"
    return mail(
        "mail_search",
        MAILBOX[user],
        f'(record {{ "query" = "{query}"; folder = {folder} : nat64; '
        f"cursor = {wanted}; "
        f"limit = {limit} : nat64 }})",
        user,
    )


def mailbox_of(user: str, local: str) -> str:
    """The MailboxInfo of `local` in the user's mail_me"""
    return record_with(call("mail_me", "()", user), local)


def uids(output: str) -> List[int]:
    return [int(n.replace("_", "")) for n in re.findall(r"\buid = ([\d_]+)", output)]


def cursor_of(output: str) -> Optional[int]:
    hit = re.search(r"\bcursor = opt \(?([\d_]+)", output)
    return int(hit.group(1).replace("_", "")) if hit else None


def test__record_with_skips_braces_in_quoted_text() -> None:
    reply = (
        'record { xlocal = "a" } record { name = opt "record { x}"; local = "a"; '
        'members = vec { record { name = opt "x} \\"}" } }; used_bytes = 1 } '
        'record { local = "b" }'
    )
    assert (
        record_with(reply, "a")
        == reply[reply.index("record { name") : reply.index(" record { local")]
    )
    assert record_with('vec {record {local = "d"}}', "d") == 'record {local = "d"}'
    with pytest.raises(AssertionError, match="no whole record"):
        record_with('record { local = "b"; name = "{"', "b")
    with pytest.raises(AssertionError, match="no whole record"):
        record_with('record { local = "c"; x = 1', "c")


def test__every_admin_method_is_listed() -> None:
    assert set(re.findall(r'"(admin_\w+)"', DID)) == set(ADMIN_CALLS)
    assert set(re.findall(r'"(mail_\w+)"', DID)) == set(MAILBOX_CALLS) | {"mail_me"}


@pytest.mark.parametrize("method", sorted(ADMIN_CALLS))
@pytest.mark.parametrize("caller", [USER_A, "anonymous"])
def test__admin_is_for_controllers_only(method: str, caller: str) -> None:
    assert "controllers only" in call(method, ADMIN_CALLS[method], caller)


@pytest.mark.parametrize(
    "method,argument",
    [
        ("outbox_pump", "()"),
        ("ingest_pump", "()"),
        ("ingest_move", "(1 : nat64)"),
        ("ingest_process", "(1 : nat64, 1 : nat64)"),
        ("ingest_merge", "(1 : nat64)"),
        ("ingest_clean", "(1 : nat64)"),
        ("ingest_upgrade_file", "(1 : nat64)"),
    ],
)
@pytest.mark.parametrize("caller", [None, USER_A])
def test__internal_methods_are_for_the_canister_only(
    method: str, argument: str, caller: Optional[str]
) -> None:
    assert "only this canister" in call(method, argument, caller)


NO_MAILBOX = "no such mailbox for this principal"


@pytest.mark.parametrize("method", sorted(MAILBOX_CALLS))
def test__a_controller_is_no_member(method: str) -> None:
    deliver("Private heron", "<ctrl@sender.example>")
    assert NO_MAILBOX in mail(method, "alice", MAILBOX_CALLS[method])


@pytest.mark.parametrize("method", sorted(MAILBOX_CALLS))
def test__a_stranger_has_no_mailbox(method: str) -> None:
    assert NO_MAILBOX in mail(method, "alice", MAILBOX_CALLS[method], NOBODY)


@pytest.mark.parametrize("method", sorted(MAILBOX_CALLS))
def test__another_mailbox_is_refused_like_an_unknown_address(method: str) -> None:
    other = mail(method, "bob", MAILBOX_CALLS[method], USER_A)
    unknown = mail(method, "nobody", MAILBOX_CALLS[method], USER_A)
    assert NO_MAILBOX in other and NO_MAILBOX in unknown


def test__me_shows_a_new_user_their_principal(users: Dict[str, str]) -> None:
    output = call("mail_me", "()", NOBODY)
    assert users[NOBODY] in output
    assert re.search(r"mailboxes = vec \{\s*\}", output)
    assert re.search(r"is_controller = false", output)


def test__me_shows_the_address_of_a_member() -> None:
    assert f'address = "alice@{DOMAIN}"' in mailbox_of(USER_A, "alice")


def test__controller_is_told_it_is_one() -> None:
    assert re.search(r"is_controller = true", call("mail_me"))


def test__one_principal_has_two_mailboxes(users: Dict[str, str]) -> None:
    assert "error" not in add_mailbox("alice2", users[USER_A]).lower()
    assert re.search(OK, deliver("Second fox", "<two@sender.example>", to="alice2"))
    wait_until_drained()
    assert "Second fox" in page(USER_A, local="alice2")
    assert "Second fox" not in page(USER_A)
    assert f'address = "alice2@{DOMAIN}"' in mailbox_of(USER_A, "alice2")
    assert number(mailbox_of(USER_A, "alice2"), "members") == 1


def test__a_mailbox_is_created_once() -> None:
    assert "already exists" in create_mailbox("alice")


def test__creating_never_gives_access_to_a_mailbox_that_exists(
    users: Dict[str, str],
) -> None:
    assert "already exists" in create_mailbox("alice", first_member=users[USER_B])
    alice = entry_line("alice")
    assert users[USER_A] in alice
    assert users[USER_B] not in alice


def test__a_refused_first_member_creates_no_mailbox() -> None:
    assert "anonymous" in create_mailbox("lone", first_member="2vxsx-fae")
    entries = call("admin_list_entries")
    assert 'local = "alice"' in entries
    assert 'local = "lone"' not in entries


def test__a_member_is_added_once(users: Dict[str, str]) -> None:
    assert "already a member" in add_member("alice", users[USER_A])


def test__anonymous_cannot_be_a_member() -> None:
    assert "anonymous" in add_member("alice", "2vxsx-fae")


def test__a_mailbox_has_at_most_100_members() -> None:
    create_mailbox("crowd")
    for n in range(100):
        assert "error" not in add_member("crowd", fake_principal(n)).lower()
    assert "the most members it can have, 100" in add_member(
        "crowd", fake_principal(100)
    )
    crowd = entry_line("crowd")
    assert all(fake_principal(n) in crowd for n in range(100))
    assert fake_principal(100) not in crowd


def open_as(user: str, local: str, uid: int) -> str:
    """Opens the message as the user: sets the seen flag"""
    return mail(
        "mail_set_flags",
        local,
        f"(vec {{ {uid} : nat64 }}, 1 : nat64, 0 : nat64)",
        user,
    )


def unread(user: str, local: str) -> int:
    return number(mailbox_of(user, local), "unseen")


def message_in(user: str, local: str, uid: int) -> str:
    return mail("mail_get", local, f"({uid} : nat64)", user)


def opened(output: str) -> List[str]:
    """The principals in a mail_get reply's seen_by, in the order they opened it"""
    seen_by = output[output.index("seen_by") :]
    return re.findall(r'"principal" = principal "([^"]+)"', seen_by)


def test__a_shared_mailbox_has_one_read_state_and_records_each_opening(
    users: Dict[str, str],
) -> None:
    add_mailbox("pond", users[USER_A])
    add_member("pond", users[USER_B])
    call("admin_set_name", f'(principal "{users[USER_A]}", "Alice A")')
    for n in range(3):
        assert re.search(
            OK, deliver(f"Pond heron {n}", f"<pond{n}@sender.example>", to="pond")
        )
    wait_until_drained()
    first, second, third = sorted(uids(page(USER_A, local="pond")))
    assert unread(USER_A, "pond") == unread(USER_B, "pond") == 3
    assert opened(message_in(USER_B, "pond", first)) == []

    # One member's opening reads it for both, and names who opened it
    open_as(USER_A, "pond", first)
    assert unread(USER_B, "pond") == 2
    got = message_in(USER_B, "pond", first)
    assert opened(got) == [users[USER_A]]
    assert 'name = opt "Alice A"' in got
    at_ns = number(got[got.index("seen_by") :], "at_ns")

    # Each member is recorded once, at their first opening
    open_as(USER_A, "pond", first)
    open_as(USER_B, "pond", first)
    got = message_in(USER_A, "pond", first)
    assert opened(got) == [users[USER_A], users[USER_B]]
    assert number(got[got.index("seen_by") :], "at_ns") == at_ns
    assert unread(USER_A, "pond") == 2

    # Unread again for both; who opened it stays known
    mail(
        "mail_set_flags",
        "pond",
        f"(vec {{ {first} : nat64 }}, 0 : nat64, 1 : nat64)",
        USER_B,
    )
    assert unread(USER_A, "pond") == 3
    assert len(opened(message_in(USER_A, "pond", first))) == 2
    assert "a flag both set and cleared" in mail(
        "mail_set_flags",
        "pond",
        f"(vec {{ {second} : nat64 }}, 1 : nat64, 1 : nat64)",
        USER_A,
    )
    assert opened(message_in(USER_A, "pond", second)) == []

    # Different flags from two members are both kept
    mail(
        "mail_set_flags",
        "pond",
        f"(vec {{ {third} : nat64 }}, 2 : nat64, 0 : nat64)",
        USER_A,
    )
    open_as(USER_B, "pond", third)
    assert number(message_in(USER_A, "pond", third), "flags") == 3

    # A deletion takes its unread count and its openings with it
    open_as(USER_A, "pond", first)
    assert unread(USER_B, "pond") == 1
    mail(
        "mail_delete",
        "pond",
        f"(vec {{ {first} : nat64; {second} : nat64 }}, 0 : nat64)",
        USER_B,
    )
    assert unread(USER_A, "pond") == 0
    assert re.search(r'result = "ok"', call("admin_check", '("pond", null)'))
    # abs() overflows, and fails the call, only while a row of theirs is left
    assert (
        call(
            "dev_file_exec",
            f'("pond", "SELECT abs(-9223372036854775807 - min(1, (SELECT count(*) '
            f'FROM seen_by WHERE uid IN ({first}, {second}))))")',
        ).strip()
        == "()"
    )


def test__a_removed_member_is_refused_like_a_stranger(users: Dict[str, str]) -> None:
    add_mailbox("marsh", users[USER_A])
    add_member("marsh", users[USER_C])
    assert re.search(OK, deliver("Marsh rail", "<marsh@sender.example>", to="marsh"))
    wait_until_drained()
    assert "Marsh rail" in page(USER_C, local="marsh")

    call("admin_remove_member", f'("marsh", principal "{users[USER_C]}")')
    for method, argument in sorted(MAILBOX_CALLS.items()):
        assert NO_MAILBOX in mail(method, "marsh", argument, USER_C), method
    assert 'local = "marsh"' not in call("mail_me", "()", USER_C)
    assert users[USER_C] not in entry_line("marsh")
    # The others go on as before
    assert "Marsh rail" in page(USER_A, local="marsh")
    assert number(mailbox_of(USER_A, "marsh"), "members") == 1


@pytest.mark.parametrize("local", ["", ".x", "x.", "a..b", "a b", "a@b", "x" * 65])
def test__invalid_addresses_are_refused(local: str) -> None:
    assert "invalid address" in create_mailbox(local)


def test__mailboxes_are_isolated_although_uids_overlap() -> None:
    assert re.search(
        OK, deliver("For alice alone", "<iso-a@sender.example>", to="alice")
    )
    assert re.search(OK, deliver("For bob alone", "<iso-b@sender.example>", to="bob"))
    wait_until_drained()

    mine = page(USER_A)
    theirs = page(USER_B)
    assert "For alice alone" in mine and "For bob alone" not in mine
    assert "For bob alone" in theirs and "For alice alone" not in theirs
    assert set(uids(mine)) & set(
        uids(theirs)
    ), "the test needs a uid both mailboxes use"

    assert "For bob alone" not in found(USER_A, "bob alone")

    # A uid that exists only for alice does nothing for bob, and stays hers
    only_alice = max(set(uids(mine)) - set(uids(theirs)))
    assert "no such message" in mail(
        "mail_get", MAILBOX[USER_B], f"({only_alice} : nat64)", USER_B
    )

    def alices_flags() -> int:
        return number(
            mail("mail_get", MAILBOX[USER_A], f"({only_alice} : nat64)", USER_A),
            "flags",
        )

    before = alices_flags()
    mail(
        "mail_set_flags",
        MAILBOX[USER_B],
        f"(vec {{ {only_alice} : nat64 }}, 2 : nat64, 0 : nat64)",
        USER_B,
    )
    assert alices_flags() == before
    assert re.search(
        r"\(0\b",
        mail(
            "mail_delete",
            MAILBOX[USER_B],
            f"(vec {{ {only_alice} : nat64 }}, 0 : nat64)",
            USER_B,
        ),
    )
    assert only_alice in uids(page(USER_A))


def test__read_returns_the_raw_message() -> None:
    assert re.search(
        OK, deliver("Whole marmot", "<raw@sender.example>", to="bob", body=b"bodytext")
    )
    wait_until_drained()
    uid = uids(found(USER_B, "marmot"))[0]
    output = mail("mail_get", MAILBOX[USER_B], f"({uid} : nat64)", USER_B)
    assert number(output, "state") == 1
    assert text(output, "subject") == "Whole marmot"
    assert (
        "bodytext" in output or "62 6f 64 79" in output or "\\62\\6f\\64\\79" in output
    )


def test__quarantined_mail_can_be_read_by_its_owner() -> None:
    poison = 'record { name = "X-Email-Canister-Test-Trap"; value = " 1\\r\\n" }; '
    assert re.search(
        OK, deliver("Poison", "<q@sender.example>", to="bob", extra_headers=poison)
    )
    wait_until_drained()
    listed = page(USER_B)
    uid = max(uids(listed))
    output = mail("mail_get", MAILBOX[USER_B], f"({uid} : nat64)", USER_B)
    assert number(output, "state") == 2
    assert number(output, "raw_bytes") > 0


def test__flags_are_stored_and_bump_the_change_counter() -> None:
    assert re.search(OK, deliver("Flag ibis", "<flag@sender.example>", to="bob"))
    wait_until_drained()
    hit = found(USER_B, "ibis")
    uid = uids(hit)[0]
    before = number(hit, "modseq")
    mail(
        "mail_set_flags",
        MAILBOX[USER_B],
        f"(vec {{ {uid} : nat64 }}, 3 : nat64, 0 : nat64)",
        USER_B,
    )
    after = found(USER_B, "ibis")
    assert number(after, "flags") == 3
    assert number(after, "modseq") > before
    assert "unknown flag" in mail(
        "mail_set_flags",
        MAILBOX[USER_B],
        f"(vec {{ {uid} : nat64 }}, 0 : nat64, 4 : nat64)",
        USER_B,
    )


def test__mail_from_a_blocked_sender_goes_to_spam() -> None:
    bob = MAILBOX[USER_B]
    # Blocked in any case: the envelope sender, and the From address
    assert "(true)" in mail("mail_block", bob, '("Spammy@Sender.example")', USER_B)
    assert "(false)" in mail("mail_block", bob, '("spammy@sender.example")', USER_B)
    mail("mail_block", bob, '("boss@other.example")', USER_B)
    before = unread(USER_B, bob)
    for subject, sender, from_address in [
        ("Blocked heron", "spammy", "sender@sender.example"),
        ("Blocked egret", "sender", "Boss@Other.example"),
        ("Welcome stork", "sender", "sender@sender.example"),
    ]:
        assert re.search(
            OK,
            deliver(
                subject,
                f"<{subject.split()[1]}@sender.example>",
                to=bob,
                sender=sender,
                from_address=from_address,
            ),
        )
    wait_until_drained()
    spam = page(USER_B, folder=2)
    assert "Blocked heron" in spam and "Blocked egret" in spam
    assert "Welcome stork" not in spam
    assert "Welcome stork" in page(USER_B)
    assert "Blocked" not in page(USER_B)
    assert not uids(found(USER_B, "heron"))
    assert unread(USER_B, bob) == before + 1
    assert 'result = "ok"' in call("admin_check", f'("{bob}", null)')

    # Not spam: back in the Inbox, and unread there
    heron = uids(found(USER_B, "heron", folder=2))[0]
    moved = mail("mail_move", bob, f"(vec {{ {heron} : nat64 }}, 0 : nat64)", USER_B)
    # The count, the uids moved, and none deleted
    assert re.search(
        rf"\(\s*1 : nat64,\s*vec \{{\s*{heron} : nat64;?\s*\}},\s*vec \{{\s*\}}",
        moved,
    ), moved
    assert unread(USER_B, bob) == before + 2

    # Unblocked, the sender's new mail stays in the Inbox
    assert "(true)" in mail("mail_unblock", bob, '("spammy@sender.example")', USER_B)
    assert "(false)" in mail("mail_unblock", bob, '("spammy@sender.example")', USER_B)
    assert "spammy" not in mail("mail_blocked", bob, "()", USER_B)
    assert re.search(
        OK,
        deliver("Unblocked crane", "<crane@sender.example>", to=bob, sender="spammy"),
    )
    wait_until_drained()
    assert "Unblocked crane" in page(USER_B)
    assert 'result = "ok"' in call("admin_check", f'("{bob}", null)')


def test__the_list_gives_each_messages_from_address() -> None:
    bob = MAILBOX[USER_B]
    expected = {
        # As the From header has it, case included
        "Named": ("Grebe Club <Grebe@Club.example>", "Grebe@Club.example"),
        "Bare": ("bare@club.example", "bare@club.example"),
        "Quoted": ('\\"Grebes <Ltd>\\" <quoted@club.example>', "quoted@club.example"),
        # One mail_block refuses is not given
        "Odd": ('\\"odd one\\"@club.example', ""),
    }
    for word, (from_header, _) in expected.items():
        assert re.search(
            OK,
            deliver(
                f"{word} grebe",
                f"<{word}@club.example>",
                to=bob,
                from_header=from_header,
            ),
        )
    wait_until_drained()
    for word, (_, address) in expected.items():
        hit = found(USER_B, word)
        assert len(uids(hit)) == 1, word
        assert f'sender_address = "{address}"' in hit, word


def test__delete_removes_mail_index_and_usage() -> None:
    assert re.search(OK, deliver("Delete jackal", "<del@sender.example>", to="bob"))
    wait_until_drained()
    before = entry_line("bob")
    hit = found(USER_B, "jackal")
    uid = uids(hit)[0]
    size = number(hit, "raw_bytes")
    assert "1" in mail(
        "mail_delete", MAILBOX[USER_B], f"(vec {{ {uid} : nat64 }}, 0 : nat64)", USER_B
    )
    assert uids(found(USER_B, "jackal")) == []
    assert uid not in uids(page(USER_B))
    after = entry_line("bob")
    assert number(after, "used_bytes") == number(before, "used_bytes") - size
    assert number(after, "message_count") == number(before, "message_count") - 1


def test__list_pages_are_stable_and_newest_first() -> None:
    for n in range(5):
        deliver(f"Paged {n}", f"<page{n}@sender.example>", to="bob")
    wait_until_drained()
    seen: List[int] = []
    cursor: Optional[int] = None
    while True:
        output = page(USER_B, cursor, 3)
        batch = uids(output)
        assert len(batch) <= 3
        seen += batch
        cursor = cursor_of(output)
        if cursor is None:
            break
    assert seen == sorted(seen, reverse=True)
    assert len(seen) == len(set(seen))
    # The count covers every folder: an earlier test left mail in Spam
    filed = sum(len(uids(page(USER_B, folder=folder))) for folder in (1, 2))
    assert len(seen) + filed == number(entry_line("bob"), "message_count")


@pytest.mark.parametrize(
    "query",
    [
        "OR",
        "AND NOT",
        "*",
        "NEAR(a b)",
        "subject:x",
        '\\"',
        "( ) -",
        "body : nope",
    ],
)
def test__search_input_is_never_query_syntax(query: str) -> None:
    output = found(USER_B, query)
    assert "items" in output, output


def test__quota_defers_mail_and_redelivery_is_free() -> None:
    assert re.search(OK, deliver("Quota first", "<quota1@sender.example>", to="bob"))
    wait_until_drained()
    used = number(entry_line("bob"), "used_bytes")
    call("admin_set_quota", f'("bob", {used} : nat64)')
    try:
        assert "code = 452" in deliver(
            "Quota second", "<quota2@sender.example>", to="bob"
        )
        assert re.search(
            OK, deliver("Quota first", "<quota1@sender.example>", to="bob")
        )
        # A full mailbox defers the message for the other recipient too
        assert "code = 452" in deliver(
            "Quota third", "<quota3@sender.example>", to="alice,bob"
        )
        assert "Quota third" not in page(USER_A)
        assert number(entry_line("bob"), "used_bytes") == used
    finally:
        call("admin_set_quota", '("bob", 2147483648 : nat64)')


def message_count(local: str) -> int:
    return number(entry_line(local), "message_count")


def spam_past_its_30_days(local: str, marked: List[int]) -> None:
    """Marks the messages as Spam, then backdates them: expired, and not yet
    deleted. The wait lets a cleanup still due from earlier end first, so that
    it cannot delete them."""
    listed = "; ".join(f"{uid} : nat64" for uid in marked)
    mail("mail_move", local, f"(vec {{ {listed} }}, 2 : nat64)", USER_A)
    wait_until(lambda: not clean_due(local), f"{local}'s earlier cleanup")
    where = ", ".join(str(uid) for uid in marked)
    call(
        "dev_file_exec",
        f'("{local}", "UPDATE messages SET folder_ns = 1, received_ns = 1 '
        f'WHERE uid IN ({where})")',
    )


def test__a_full_mailbox_frees_its_expired_mail_for_the_retry(
    users: Dict[str, str],
) -> None:
    add_mailbox("crowded", users[USER_A])
    for n in range(3):
        assert re.search(
            OK, deliver(f"Crowded egg{n}", f"<egg{n}@sender.example>", to="crowded")
        )
    wait_until_drained()
    spam_past_its_30_days("crowded", uids(page(USER_A, local="crowded"))[1:])
    used = number(entry_line("crowded"), "used_bytes")
    call("admin_set_quota", f'("crowded", {used} : nat64)')

    # Refused for the quota, the delivery has the pump delete the expired
    # mail, so the sender's retry finds room
    retry = ("Crowded egg3", "<egg3@sender.example>")
    assert "code = 452" in deliver(*retry, to="crowded")
    wait_until(lambda: message_count("crowded") == 1, "the expired mail's deletion")
    assert re.search(OK, deliver(*retry, to="crowded"))
    wait_until_drained()
    assert "Crowded egg3" in page(USER_A, local="crowded")
    assert 'result = "ok"' in call("admin_check", '("crowded", null)')


def test__mail_that_cannot_be_deleted_stops_neither_delivery_nor_the_pump(
    users: Dict[str, str],
) -> None:
    add_mailbox("damaged", users[USER_A])
    assert re.search(OK, deliver("Damaged rook", "<rook@sender.example>", to="damaged"))
    wait_until_drained()
    rook = uids(page(USER_A, local="damaged"))[0]
    spam_past_its_30_days("damaged", [rook])
    trigger = (
        f"CREATE TRIGGER damaged BEFORE DELETE ON messages WHEN old.uid = {rook} "
        "BEGIN SELECT RAISE(ABORT, 'damaged'); END"
    )
    call("dev_file_exec", f'("damaged", "{trigger}")')

    assert re.search(OK, deliver("Damaged jay", "<jay@sender.example>", to="damaged"))
    wait_until_drained()
    assert "Damaged jay" in page(USER_A, local="damaged")
    # The cleanup the move asked for failed, and stopped until the next mark
    wait_until(lambda: not clean_due("damaged"), "the end of the failed cleanup")
    assert "Damaged rook" in page(USER_A, local="damaged", folder=2)

    # Repaired, the mailbox is cleaned at its next mark
    call("dev_file_exec", '("damaged", "DROP TRIGGER damaged")')
    jay = uids(page(USER_A, local="damaged"))[0]
    mail("mail_move", "damaged", f"(vec {{ {jay} : nat64 }}, 1 : nat64)", USER_A)
    wait_until(lambda: message_count("damaged") == 1, "the repaired cleanup")
    assert "Damaged rook" not in page(USER_A, local="damaged", folder=2)
    assert 'result = "ok"' in call("admin_check", '("damaged", null)')


def test__reassigning_an_address_requires_a_purge(users: Dict[str, str]) -> None:
    assert re.search(
        OK, deliver("Old owner secret", "<old@sender.example>", to="alice")
    )
    wait_until_drained()

    assert "disable the entry" in call("admin_purge", '("alice")')
    listed = number(entry_line("alice"), "uidvalidity")
    call("admin_set_disabled", '("alice", true)')

    # Disabled: no access, no new mail, and the address stays taken
    assert NO_MAILBOX in page(USER_A)
    assert "code = 550" in deliver("Late", "<late@sender.example>", to="alice")
    assert "already exists" in create_mailbox("alice")

    # A purge takes the members with the mail
    purge("alice")
    assert "vacant = true" in entry_line("alice")
    assert "members = vec {}" in entry_line("alice")
    assert "no such mailbox" in add_member("alice", users[USER_A])

    assert "error" not in add_mailbox("alice", users[NOBODY]).lower()
    # A member added from the list read before the purge would get the new
    # owner's mail
    stale = f'("alice", principal "{users[USER_A]}", opt {listed})'
    assert "created again since it was listed" in call("admin_add_member", stale)
    assert number(entry_line("alice"), "uidvalidity") > listed
    assert users[USER_A] not in entry_line("alice")
    assert uids(page(NOBODY)) == []
    assert "Old owner secret" not in found(NOBODY, "secret")
    assert NO_MAILBOX in page(USER_A)
    assert number(mailbox_of(NOBODY, "alice"), "used_bytes") == 0


def test__re_enabling_restores_access() -> None:
    call("admin_set_disabled", '("bob", true)')
    assert NO_MAILBOX in page(USER_B)
    call("admin_set_disabled", '("bob", false)')
    assert "items" in page(USER_B)


SCALE = 50_000


def seed(local: str, count: int) -> None:
    stored = 0
    while stored < count:
        output = call(
            "dev_seed", f'("{local}", {stored} : nat64, {count - stored} : nat64)'
        )
        match = re.search(r"([\d_]+)", output)
        assert match and "(" in output and "rror" not in output, output
        added = int(match.group(1).replace("_", ""))
        assert added > 0, output
        stored += added


def cost(local: str, query: str) -> int:
    found = re.search(r"([\d_]+)", call("dev_search_cost", f'("{local}", "{query}")'))
    assert found, "dev_search_cost replied no number"
    return int(found.group(1).replace("_", ""))


@pytest.fixture(scope="module")
def large_mailbox(users: Dict[str, str]) -> str:
    add_mailbox("large", users[USER_C])
    seed("large", SCALE)
    assert stats()["queued"] == 0
    return "large"


def test__search_of_50k_messages_stays_within_limits(
    large_mailbox: str, capsys: object
) -> None:
    common = cost(large_mailbox, "seedcommon")
    rare = cost(large_mailbox, f"word{SCALE // 2}")
    other = cost("bob", "seedcommon")
    with capsys.disabled():  # type: ignore[attr-defined]
        print(
            f"\ninstructions for one page of 50 at {SCALE} messages: "
            f"common {common:,}, rare {rare:,}, other mailbox's word {other:,}"
        )
    assert max(common, rare) < 50_000_000
    assert other < 15_000_000  # it searches only its own file


def test__search_in_another_mailbox_returns_only_its_own_hits_and_finishes(
    large_mailbox: str,
) -> None:
    pages = 0
    cursor: Optional[int] = None
    while True:
        output = found(USER_B, "seedcommon", cursor)
        assert uids(output) == [], "another mailbox's mail must never appear"
        cursor = cursor_of(output)
        pages += 1
        assert pages < 200, "the search does not make progress"
        if cursor is None:
            break


SEARCH_BUDGET, PURGE_STEP = 3_000_000_000, 1 << 30


def set_budgets(search: int, purge_step: int) -> None:
    call("dev_set_budgets", f"({search} : nat64, {purge_step} : nat64)")


def test__search_out_of_budget_resumes_where_it_stopped(large_mailbox: str) -> None:
    wanted = uids(found(USER_C, "seedcommon", limit=20))
    assert len(wanted) == 20
    set_budgets(1, PURGE_STEP)  # every page then holds one hit
    try:
        seen: List[int] = []
        cursor: Optional[int] = None
        while len(seen) < 20:
            output = found(USER_C, "seedcommon", cursor, 20)
            batch = uids(output)
            assert (
                0 < len(batch) < 20
            ), "the budget never ran out, so this proved nothing"
            seen += batch
            following = cursor_of(output)
            assert following is not None and (cursor is None or following < cursor)
            cursor = following
        assert seen[:20] == wanted
    finally:
        set_budgets(SEARCH_BUDGET, PURGE_STEP)


def test__large_mailbox_lists_quickly(large_mailbox: str) -> None:
    assert number(call("admin_storage_totals"), "messages") >= SCALE
    assert number(entry_line("large"), "message_count") == SCALE


def test__large_mailbox_purges_in_steps(large_mailbox: str) -> None:
    call("admin_set_disabled", '("large", true)')
    set_budgets(SEARCH_BUDGET, 16 << 20)
    try:
        steps = 0
        remaining = 1 << 62
        while remaining > 0:
            output = call("admin_purge", '("large")')
            now = number(output, "remaining")
            assert now < remaining, output
            remaining = now
            steps += 1
    finally:
        set_budgets(SEARCH_BUDGET, PURGE_STEP)
    assert steps > 2, "the file fit in one step, so this proved nothing"
    print(f"purged {SCALE} messages in {steps} steps")
    assert "vacant = true" in entry_line("large")
    assert number(entry_line("large"), "used_bytes") == 0
    assert "vec {}" in call("dev_search", '("seedcommon")').replace("\n", " ").replace(
        "  ", ""
    )
