"""Durable ingest, on a local replica.

$ make build-test
$ icp network start -d
$ pytest --network=local --identity=$TEST_IDENTITY test/canister/test_ingest.py

Reinstalls the email-canister-test canister, which erases its mail. Every call
crosses the real Candid wire, and a trap rolls back as it does on mainnet.
"""

# pylint: disable=missing-function-docstring, redefined-outer-name, unused-argument

import base64
import re
from typing import Dict

import pytest

from .support import (
    CANISTER_NAME,
    DOMAIN,
    INDEXED,
    OK,
    QUARANTINED,
    add_mailbox,
    call,
    deliver,
    icp,
    message,
    number,
    request,
    search,
    stats,
    text,
    wait_until_drained,
)


@pytest.fixture(scope="module", autouse=True)
def canister(network: str, identity: str) -> None:
    icp("deploy", CANISTER_NAME, "--mode", "reinstall", "--yes", identity=identity)
    call("admin_set_domain", f'("{DOMAIN}")')
    add_mailbox("alice", "rrkah-fqaaa-aaaaa-aaaaq-cai")
    add_mailbox("bob", "ryjl3-tyaaa-aaaaa-aaaba-cai")


def test__anonymous_caller_is_refused(identity_anonymous: Dict[str, str]) -> None:
    for method in ("smtp_request_validate", "smtp_request"):
        assert "code = 530" in call(method, request())


def test__admin_methods_refuse_non_controllers(
    identity_anonymous: Dict[str, str],
) -> None:
    for method, argument in (
        ("admin_set_domain", '("evil.example")'),
        (
            "admin_create_mailbox",
            '(record { local = "evil"; quota_bytes = null; first_member = null })',
        ),
        ("admin_add_member", '("alice", principal "aaaaa-aa", null)'),
        ("admin_ingest_stats", "()"),
    ):
        assert "controllers only" in call(method, argument)


def test__validate_accepts_only_known_mailboxes() -> None:
    assert re.search(OK, call("smtp_request_validate", request()))
    assert re.search(OK, call("smtp_request_validate", request(to="ALICE")))
    assert "code = 550" in call("smtp_request_validate", request(to="nobody"))
    assert "code = 550" in call(
        "smtp_request_validate", request(domain="other.example")
    )


def test__message_is_parsed_and_searchable() -> None:
    assert re.search(
        OK,
        deliver(
            "Quarterly zebrafish report",
            "<parse@sender.example>",
            body=b"The aardvark budget.\r\n",
        ),
    )
    wait_until_drained()
    ids = search("zebrafish")
    assert len(ids) == 1
    assert search("aardvark") == ids
    output = message(ids[0])
    assert number(output, "state") == INDEXED
    assert number(output, "attempts") == 1
    assert text(output, "subject") == "Quarterly zebrafish report"
    assert text(output, "sender") == "Sender <sender@sender.example>"
    assert text(output, "preview") == "The aardvark budget."
    assert text(output, "mailbox") == "alice"
    assert number(output, "sent_at") == 1794222000


def test__a_date_before_the_epoch_is_unknown() -> None:
    # Early on 1970-01-01 east of UTC is before the epoch, which no client
    # can show as a sent time
    assert re.search(
        OK,
        deliver(
            "Early ibis",
            "<early@sender.example>",
            date="Thu, 1 Jan 1970 00:30:00 +0100",
        ),
    )
    wait_until_drained()
    ids = search("ibis")
    assert len(ids) == 1
    assert number(message(ids[0]), "sent_at") == 0


def test__redelivery_gives_one_copy() -> None:
    for _ in range(3):
        assert re.search(OK, deliver("Duplicate wombat", "<dup@sender.example>"))
    wait_until_drained()
    assert len(search("wombat")) == 1


def test__the_same_message_from_two_senders_gives_two_copies() -> None:
    for sender in ("sender", "impostor"):
        assert re.search(
            OK, deliver("Twice sent numbat", "<numbat@sender.example>", sender=sender)
        )
    wait_until_drained()
    assert len(search("numbat")) == 2


def test__redelivery_without_message_id_gives_one_copy() -> None:
    for _ in range(2):
        assert re.search(OK, deliver("Anonymous platypus", None))
    wait_until_drained()
    assert len(search("platypus")) == 1


def test__each_recipient_gets_one_copy() -> None:
    for _ in range(2):
        assert re.search(
            OK, deliver("Shared capybara", "<two@sender.example>", to="alice,bob")
        )
    wait_until_drained()
    ids = search("capybara")
    assert len(ids) == 2
    assert sorted(text(message(i), "mailbox") for i in ids) == ["alice", "bob"]


def test__a_recipient_named_twice_gets_one_copy() -> None:
    assert re.search(
        OK, deliver("Twice tapir", "<twice@sender.example>", to="alice,ALICE")
    )
    wait_until_drained()
    assert search("tapir") == [("alice", search("tapir")[0][1])]


def test__uids_increase_per_mailbox() -> None:
    for n in range(3):
        deliver(f"Ordered narwhal{n}", f"<uid{n}@sender.example>", to="bob")
    wait_until_drained()
    uids = [number(message(search(f"narwhal{n}")[0]), "uid") for n in range(3)]
    assert uids == sorted(uids) and len(set(uids)) == 3


def test__unknown_recipients_are_skipped() -> None:
    assert re.search(
        OK, deliver("Partial ocelot", "<skip@sender.example>", to="nobody,bob")
    )
    wait_until_drained()
    ids = search("ocelot")
    assert len(ids) == 1
    assert text(message(ids[0]), "mailbox") == "bob"
    assert "code = 550" in deliver("Lost ocelot", "<lost@sender.example>", to="nobody")


def test__poison_message_is_quarantined_and_others_continue() -> None:
    poison = 'record { name = "X-Email-Canister-Test-Trap"; value = " 1\\r\\n" }; '
    before = stats()
    assert re.search(
        OK,
        deliver("Poison salamander", "<poison@sender.example>", extra_headers=poison),
    )
    assert re.search(OK, deliver("Healthy lemur", "<after-poison@sender.example>"))
    current = wait_until_drained()
    assert current["quarantined"] == before["quarantined"] + 1
    assert current["indexed"] == before["indexed"] + 1

    assert search("salamander") == []
    assert len(search("lemur")) == 1
    # Stored, and still there to be viewed
    mailbox, newest = search("lemur")[0]
    output = message((mailbox, newest - 1))
    assert number(output, "state") == QUARANTINED
    assert number(output, "attempts") == 3
    assert number(output, "raw_bytes") > 0
    assert text(output, "last_error") != ""


CHARSET_CASES = [
    ("iso-2022-jp", "こんにちは世界"),
    ("shift_jis", "こんにちは世界"),
    ("euc-jp", "こんにちは世界"),
    ("gb18030", "你好世界"),
    ("big5", "你好世界"),
    ("euc-kr", "안녕하세요"),
    ("iso-8859-2", "Zażółć"),
    ("windows-1251", "Съешь"),
]


@pytest.mark.parametrize("charset,sample", CHARSET_CASES)
def test__charset_body_and_encoded_subject(charset: str, sample: str) -> None:
    word = "marker" + re.sub(r"\W", "", charset)
    encoded = base64.b64encode(sample.encode(charset)).decode()
    # The gateway passes the MIME headers along with the others
    headers = (
        'record { name = "Content-Type"; '
        f'value = " text/plain; charset={charset}\\r\\n" }}; '
        'record { name = "Content-Transfer-Encoding"; value = " base64\\r\\n" }; '
    )
    subject = f"{word} =?{charset}?B?{encoded}?="
    assert re.search(
        OK,
        deliver(
            subject,
            f"<{word}@sender.example>",
            body=encoded.encode() + b"\r\n",
            extra_headers=headers,
        ),
    )
    wait_until_drained()
    ids = search(word)
    assert len(ids) == 1
    output = message(ids[0])
    assert number(output, "state") == INDEXED
    assert text(output, "subject") == f"{word} {sample}"
    assert text(output, "preview") == sample


def multipart_headers(boundary: str) -> str:
    return (
        'record { name = "Content-Type"; value = " multipart/mixed; '
        f'boundary={boundary}\\r\\n" }}; '
    )


def test__multipart_prefers_plain_text_and_counts_attachments() -> None:
    body = (
        b"--b1\r\nContent-Type: text/html\r\n\r\n<p>htmlonlykestrel</p>\r\n"
        b"--b1\r\nContent-Type: text/plain\r\n\r\nplainkestrel\r\n"
        b"--b1\r\nContent-Type: application/pdf\r\n"
        b"Content-Disposition: attachment; filename=a.pdf\r\n\r\nattachedkestrel\r\n"
        b"--b1--\r\n"
    )
    assert re.search(
        OK,
        deliver(
            "Mixed",
            "<multi@sender.example>",
            body=body,
            extra_headers=multipart_headers("b1"),
        ),
    )
    wait_until_drained()
    ids = search("plainkestrel")
    assert len(ids) == 1
    assert search("htmlonlykestrel") == []
    assert search("attachedkestrel") == []
    assert number(message(ids[0]), "attachments") == 1


def test__html_only_mail_is_readable_without_markup() -> None:
    body = (
        b"<html><style>.stylepuffin{}</style><script>scriptpuffin()</script>"
        b"<body><b>visible</b>puffin</body></html>\r\n"
    )
    headers = 'record { name = "Content-Type"; value = " text/html\\r\\n" }; '
    assert re.search(
        OK, deliver("Html", "<html@sender.example>", body=body, extra_headers=headers)
    )
    wait_until_drained()
    ids = search("visible")
    assert len(ids) == 1
    assert search("stylepuffin") == []
    assert search("scriptpuffin") == []
    assert "<b>" not in text(message(ids[0]), "preview")


@pytest.mark.parametrize(
    "name,body,headers",
    [
        ("binary", bytes(range(256)) * 20, ""),
        (
            "unterminated",
            b"--b2\r\nContent-Type: text/plain\r\n\r\nno end",
            multipart_headers("b2"),
        ),
        (
            "nested",
            b"".join(
                b"--n%d\r\nContent-Type: multipart/mixed; boundary=n%d\r\n\r\n"
                % (i, i + 1)
                for i in range(200)
            ),
            multipart_headers("n0"),
        ),
    ],
)
def test__hostile_mail_never_blocks_the_queue(
    name: str, body: bytes, headers: str
) -> None:
    before = stats()
    assert re.search(
        OK,
        deliver(
            f"Hostile{name}",
            f"<hostile-{name}@sender.example>",
            body=body,
            extra_headers=headers,
        ),
    )
    current = wait_until_drained()
    assert (
        current["indexed"] + current["quarantined"]
        == before["indexed"] + before["quarantined"] + 1
    )


def test__near_limit_message_is_accepted_and_indexed() -> None:
    before = stats()
    output = deliver(
        "Large iguana", "<large@sender.example>", body=b"iguanabody " * 172_000
    )
    assert re.search(OK, output), output
    current = wait_until_drained()
    assert current["indexed"] == before["indexed"] + 1
    ids = search("iguana")
    assert len(ids) == 1
    assert number(message(ids[0]), "raw_bytes") > 1_890_000


def test__oversize_message_is_refused() -> None:
    # Headers count too, so this stays under the 2 MB ingress limit
    long_value = "x" * 8000
    headers = "".join(
        f'record {{ name = "X-Pad-{n}"; value = " {long_value}\\r\\n" }}; '
        for n in range(20)
    )
    output = deliver(
        "Big", "<big@sender.example>", body=b"y" * 1_850_000, extra_headers=headers
    )
    assert "code = 552" in output, output


def test__backlog_cap_asks_senders_to_retry() -> None:
    call("dev_pause", "(true)")
    call("dev_set_backlog_cap", "(100 : nat64, 1 : nat64)")
    try:
        assert re.search(OK, deliver("Capped first gecko", "<cap1@sender.example>"))
        assert "code = 451" in deliver(
            "Capped second gecko", "<cap2@sender.example>", to="bob"
        )
    finally:
        call("dev_set_backlog_cap", "(100 : nat64, 1000 : nat64)")
        call("dev_pause", "(false)")
    wait_until_drained()


def test__backlog_survives_upgrade(identity: str) -> None:
    before = stats()
    call("dev_pause", "(true)")
    for n in range(5):
        assert re.search(OK, deliver(f"Upgraded toucan{n}", f"<up{n}@sender.example>"))
    assert stats()["queued"] == 5

    icp("canister", "stop", CANISTER_NAME, identity=identity)
    icp("deploy", CANISTER_NAME, "--mode", "upgrade", "--yes", identity=identity)
    icp("canister", "start", CANISTER_NAME, identity=identity)

    # The pause was on the heap: only a re-armed timer after a real upgrade
    # can drain this, with nothing else calling the canister
    current = wait_until_drained()
    assert current["indexed"] == before["indexed"] + 5
    for n in range(5):
        assert len(search(f"toucan{n}")) == 1


def test__duplicates_stay_out_after_upgrade() -> None:
    assert re.search(OK, deliver("Upgraded toucan0", "<up0@sender.example>"))
    wait_until_drained()
    assert len(search("toucan0")) == 1
