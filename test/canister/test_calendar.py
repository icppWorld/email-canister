"""A mailbox's calendar and its feed, on a local replica: events are stored as
the VEVENT blocks the webmail writes, listed by the span they cover, and
served at a secret address as one iCalendar file.

$ make build-test
$ icp network start -d
$ pytest --network=local --identity=$TEST_IDENTITY test/canister/test_calendar.py

Reinstalls the email-canister-test canister, which erases its mail.
"""

# pylint: disable=missing-function-docstring, redefined-outer-name, unused-argument

import re
import time
from typing import Dict, List, Optional, Tuple

import pytest

from .support import (
    CANISTER_NAME,
    DOMAIN,
    add_mailbox,
    blob_of,
    call,
    icp,
    mail,
    number,
    purge,
)
from .test_mailbox import NOBODY, USER_A, USER_B, cursor_of, principal_of

DAY = 86_400
NOW = int(time.time())
FOREVER = 253_402_300_799


@pytest.fixture(scope="module")
def users(network: str, identity: str) -> Dict[str, str]:
    return {name: principal_of(name) for name in (USER_A, USER_B, NOBODY)}


@pytest.fixture(scope="module", autouse=True)
def canister(network: str, identity: str, users: Dict[str, str]) -> None:
    icp("deploy", CANISTER_NAME, "--mode", "reinstall", "--yes", identity=identity)
    icp("canister", "top-up", "--amount", "20t", CANISTER_NAME, identity=identity)
    call("admin_set_domain", f'("{DOMAIN}")')
    assert "error" not in add_mailbox("alice", users[USER_A]).lower()
    assert "error" not in add_mailbox("bob", users[USER_B]).lower()


def candid_text(s: str) -> str:
    """A Candid text literal"""
    out = []
    for c in s:
        if c in '\\"':
            out.append("\\" + c)
        elif c == "\r":
            out.append("\\r")
        elif c == "\n":
            out.append("\\n")
        elif ord(c) < 0x20 or ord(c) == 0x7F:
            out.append(f"\\u{{{ord(c):x}}}")
        else:
            out.append(c)
    return '"' + "".join(out) + '"'


def vevent(uid: str, summary: str = "Tee time", extra: str = "") -> str:
    lines = [
        "BEGIN:VEVENT",
        f"UID:{uid}",
        "DTSTAMP:20261123T120000Z",
        "DTSTART;TZID=Europe/Amsterdam:20261124T093000",
        "DTEND;TZID=Europe/Amsterdam:20261124T110000",
        f"SUMMARY:{summary}",
    ]
    if extra:
        lines.append(extra)
    lines.append("END:VEVENT")
    return "\r\n".join(lines)


ZONE = "\r\n".join(
    [
        "BEGIN:VTIMEZONE",
        "TZID:Europe/Amsterdam",
        "BEGIN:STANDARD",
        "DTSTART:19701025T030000",
        "TZOFFSETFROM:+0200",
        "TZOFFSETTO:+0100",
        "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
        "END:STANDARD",
        "END:VTIMEZONE",
    ]
)


def put(
    uid: str,
    block: Optional[str] = None,
    starts: int = NOW,
    ends: int = NOW + 3600,
    zones: Optional[List[Tuple[str, str]]] = None,
    local: str = "alice",
    user: str = USER_A,
) -> str:
    named = zones if zones is not None else [("Europe/Amsterdam", ZONE)]
    listed_zones = "; ".join(
        f"record {{ tzid = {candid_text(tzid)}; block = {candid_text(z)} }}"
        for tzid, z in named
    )
    return mail(
        "mail_cal_put",
        local,
        f"(record {{ uid = {candid_text(uid)}; "
        f"vevent = {candid_text(block or vevent(uid))}; "
        f"starts = {starts} : nat64; ends = {ends} : nat64; "
        f"vtimezones = vec {{ {listed_zones} }} }})",
        user,
    )


def listed(
    start: int = NOW - DAY,
    end: int = NOW + DAY,
    cursor: Optional[int] = None,
    limit: int = 100,
    local: str = "alice",
    user: str = USER_A,
) -> str:
    wanted = f"opt ({cursor} : nat64)" if cursor is not None else "null"
    return mail(
        "mail_cal_list",
        local,
        f"(record {{ from = {start} : nat64; to = {end} : nat64; "
        f"cursor = {wanted}; limit = {limit} : nat64 }})",
        user,
    )


def uids_in(output: str) -> List[str]:
    return re.findall(r'\buid = "([^"]*)"', output)


def token_of(output: str) -> str:
    hit = re.search(r'"([0-9a-f]{32})"', output)
    assert hit, output
    return hit.group(1)


def get(url: str, method: str = "GET") -> str:
    return call(
        "http_request",
        f'(record {{ method = "{method}"; url = "{url}"; headers = vec {{}}; '
        'body = blob ""; certificate_version = opt (2 : nat16) })',
    )


def get_update(url: str, method: str = "GET") -> str:
    return call(
        "http_request_update",
        f'(record {{ method = "{method}"; url = "{url}"; headers = vec {{}}; '
        'body = blob "" })',
    )


def status(output: str) -> int:
    return number(output, "status_code")


def feed(token: str) -> str:
    output = get_update(f"/cal/{token}.ics")
    assert status(output) == 200, output
    return blob_of(output, "body").decode()


def test__an_event_is_stored_listed_and_deleted() -> None:
    assert put("tee-1@x.example") == "()"
    output = listed()
    assert uids_in(output) == ["tee-1@x.example"]
    assert "SUMMARY:Tee time" in output
    assert "modified_ns" in output
    # A put with the same uid replaces it
    assert put("tee-1@x.example", vevent("tee-1@x.example", "Moved")) == "()"
    output = listed()
    assert uids_in(output) == ["tee-1@x.example"] and "SUMMARY:Moved" in output
    assert "(true)" in mail("mail_cal_delete", "alice", '("tee-1@x.example")', USER_A)
    assert "(false)" in mail("mail_cal_delete", "alice", '("tee-1@x.example")', USER_A)
    assert uids_in(listed()) == []


def test__a_window_lists_the_events_that_overlap_it() -> None:
    put("past", starts=NOW - 10 * DAY, ends=NOW - 9 * DAY)
    put("now", starts=NOW, ends=NOW + 3600)
    put("forever", starts=NOW - 30 * DAY, ends=FOREVER)
    put("instant", starts=NOW + 60, ends=NOW + 60)
    assert sorted(uids_in(listed())) == ["forever", "instant", "now"]
    assert sorted(uids_in(listed(NOW - 11 * DAY, NOW - 9 * DAY))) == [
        "forever",
        "past",
    ]
    for uid in ("past", "now", "forever", "instant"):
        mail("mail_cal_delete", "alice", f'("{uid}")', USER_A)


def test__a_long_list_comes_in_pages() -> None:
    for n in range(5):
        put(f"page-{n}")
    first = listed(limit=2)
    assert len(uids_in(first)) == 2 and cursor_of(first) is not None
    seen = uids_in(first)
    cursor = cursor_of(first)
    while cursor is not None:
        more = listed(limit=2, cursor=cursor)
        seen += uids_in(more)
        cursor = cursor_of(more)
    assert sorted(seen) == [f"page-{n}" for n in range(5)]
    for n in range(5):
        mail("mail_cal_delete", "alice", f'("page-{n}")', USER_A)


@pytest.mark.parametrize(
    "uid,block,why",
    [
        ("a", vevent("b"), "another UID"),
        ("a", vevent("a").replace("UID:a\r\n", ""), "has no UID:a"),
        ("a b", vevent("a b"), "the uid must be"),
        ("a", vevent("a").replace("\r\n", "\n"), "CRLF"),
        ("a", vevent("a") + "\r\n", "must be one VEVENT"),
        ("a", "BEGIN:VEVENT\r\nUID:a\r\nEND:VTODO", "must be one VEVENT"),
        ("a", vevent("a", extra="BEGIN:VCALENDAR"), "another VCALENDAR"),
        ("a", vevent("a", extra="END:VEVENT\r\nBEGIN:VEVENT"), "another VEVENT"),
        ("a", vevent("a", "x\x07"), "CRLF"),
        ("a", vevent("a", "x" * 17_000), "too large"),
        # A parser unfolds lines and reads names in any case
        ("a", vevent("a", extra="END:VEV\r\n ENT\r\nBEGIN:VEVENT"), "another VEVENT"),
        ("a", vevent("a", extra="end:vcalendar"), "another VCALENDAR"),
        ("a", vevent("a", extra="BEGIN;X=1:VTimezone"), "with parameters"),
        (
            "a",
            vevent("a", extra="BEGIN;X=1:VALARM\r\nUID:b\r\nEND;X=1:VALARM"),
            "with parameters",
        ),
        ("a", vevent("a") + "\r\n X", "must be one VEVENT"),
        ("a", vevent("a", extra="BEGIN:VALARM"), "do not nest"),
        ("a", vevent("a", extra="END:VALARM"), "do not nest"),
        ("a", vevent("a", extra="BEGIN:VALARM\r\nEND:VTODO"), "do not nest"),
        ("a", vevent("b", extra="BEGIN:VALARM\r\nUID:a\r\nEND:VALARM"), "another UID"),
        ("a", vevent("a", extra="UID:a"), "more than one UID"),
    ],
)
def test__a_block_that_is_not_one_event_is_refused(
    uid: str, block: str, why: str
) -> None:
    assert why in put(uid, block)
    assert uid not in uids_in(listed())


def test__an_event_may_hold_an_alarm() -> None:
    alarm = "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM"
    assert put("alarmed", vevent("alarmed", extra=alarm)) == "()"
    assert "alarmed" in uids_in(listed())
    mail("mail_cal_delete", "alice", '("alarmed")', USER_A)


def test__an_event_must_end_after_it_starts() -> None:
    assert "end after it starts" in put("late", starts=NOW, ends=NOW - 1)


@pytest.mark.parametrize(
    "tzid,zone,why",
    [
        ("Europe/Paris", ZONE, "another TZID"),
        ("Amster dam", ZONE, "IANA name"),
        (
            "Europe/Amsterdam",
            ZONE.replace("BEGIN:STANDARD", "BEGIN:VEVENT"),
            "another VEVENT",
        ),
    ],
)
def test__a_zone_that_is_not_its_block_is_refused(
    tzid: str, zone: str, why: str
) -> None:
    assert why in put("zoned", zones=[(tzid, zone)])
    assert "zoned" not in uids_in(listed())


def test__too_many_zones_in_one_event_are_refused() -> None:
    assert "too many time zones" in put("zones", zones=[("Europe/Amsterdam", ZONE)] * 5)


def test__a_zone_no_event_names_is_dropped() -> None:
    token = token_of(mail("mail_cal_feed_reset", "alice", "()", USER_A))
    put("zoned-1")
    assert ZONE in feed(token)
    # Changed to name no zone, the event leaves its zone unnamed
    put("zoned-1", zones=[])
    assert "BEGIN:VTIMEZONE" not in feed(token)
    put("zoned-1")
    put("zoned-2")
    mail("mail_cal_delete", "alice", '("zoned-1")', USER_A)
    assert ZONE in feed(token)  # zoned-2 still names it
    mail("mail_cal_delete", "alice", '("zoned-2")', USER_A)
    assert "BEGIN:VTIMEZONE" not in feed(token)
    mail("mail_cal_feed_stop", "alice", "()", USER_A)


def test__calendars_are_apart() -> None:
    put("alice-only")
    assert "alice-only" not in uids_in(listed(local="bob", user=USER_B))
    assert "no such mailbox" in put("x", local="bob")
    assert "no such mailbox" in listed(local="alice", user=USER_B)
    mail("mail_cal_delete", "alice", '("alice-only")', USER_A)


def test__an_unshared_calendar_has_no_address() -> None:
    assert "(null)" in mail("mail_cal_feed", "bob", "()", USER_B)
    unknown = "0" * 32
    assert status(get(f"/cal/{unknown}.ics")) == 404
    assert status(get_update(f"/cal/{unknown}.ics")) == 404


def test__a_shared_calendar_is_one_icalendar_file() -> None:
    put("feed-1", vevent("feed-1", "Golf, open; day"))
    token = token_of(mail("mail_cal_feed_reset", "alice", "()", USER_A))
    assert token == token_of(mail("mail_cal_feed", "alice", "()", USER_A))

    # The query asks the gateway to upgrade, and serves nothing itself
    query = get(f"/cal/{token}.ics")
    assert "upgrade = opt true" in query

    output = get_update(f"/cal/{token}.ics?x=1")
    assert status(output) == 200
    assert '"text/calendar; charset=utf-8"' in output
    assert re.search(r'"Access-Control-Allow-Origin";\s*"\*"', output)
    body = blob_of(output, "body").decode()
    assert body.startswith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")
    assert body.endswith("END:VCALENDAR\r\n")
    assert f"X-WR-CALNAME:alice@{DOMAIN}\r\n" in body
    assert ZONE + "\r\n" in body
    assert vevent("feed-1", "Golf, open; day") + "\r\n" in body
    assert "\n" not in body.replace("\r\n", "")

    # A HEAD has the headers alone
    head = get_update(f"/cal/{token}.ics", "HEAD")
    assert status(head) == 200 and blob_of(head, "body") == b""
    assert status(get(f"/cal/{token}.ics", "POST")) == 405
    mail("mail_cal_delete", "alice", '("feed-1")', USER_A)


def test__a_new_address_ends_the_old_one() -> None:
    old = token_of(mail("mail_cal_feed_reset", "alice", "()", USER_A))
    new = token_of(mail("mail_cal_feed_reset", "alice", "()", USER_A))
    assert old != new
    assert status(get(f"/cal/{old}.ics")) == 404
    assert status(get_update(f"/cal/{old}.ics")) == 404
    assert "upgrade = opt true" in get(f"/cal/{new}.ics")

    assert mail("mail_cal_feed_stop", "alice", "()", USER_A) == "()"
    assert "(null)" in mail("mail_cal_feed", "alice", "()", USER_A)
    assert status(get(f"/cal/{new}.ics")) == 404
    assert status(get_update(f"/cal/{new}.ics")) == 404


@pytest.mark.parametrize(
    "url",
    ["/", "/cal/", "/cal/x.ics", "/cal/" + "A" * 32 + ".ics", "/cal/" + "0" * 33],
)
def test__any_other_address_is_not_found(url: str) -> None:
    assert status(get(url)) == 404
    assert status(get_update(url)) == 404


def test__the_feed_leaves_out_events_over_a_year_old() -> None:
    put("old", starts=NOW - 400 * DAY, ends=NOW - 380 * DAY)
    put("recent", starts=NOW - 300 * DAY, ends=NOW - 299 * DAY)
    token = token_of(mail("mail_cal_feed_reset", "alice", "()", USER_A))
    body = feed(token)
    assert "UID:recent\r\n" in body and "UID:old\r\n" not in body
    for uid in ("old", "recent"):
        mail("mail_cal_delete", "alice", f'("{uid}")', USER_A)


def test__a_removed_member_takes_no_address_with_them(users: Dict[str, str]) -> None:
    assert "error" not in add_mailbox("crew", users[USER_A]).lower()
    call("admin_add_member", f'("crew", principal "{users[USER_B]}", null)')
    token = token_of(mail("mail_cal_feed_reset", "crew", "()", USER_B))
    assert status(get_update(f"/cal/{token}.ics")) == 200
    call("admin_remove_member", f'("crew", principal "{users[USER_B]}")')
    assert status(get(f"/cal/{token}.ics")) == 404
    assert status(get_update(f"/cal/{token}.ics")) == 404
    assert "(null)" in mail("mail_cal_feed", "crew", "()", USER_A)


def test__a_disabled_or_purged_mailbox_has_no_feed(users: Dict[str, str]) -> None:
    assert "error" not in add_mailbox("gone", users[USER_A]).lower()
    put("gone-1", local="gone")
    token = token_of(mail("mail_cal_feed_reset", "gone", "()", USER_A))
    assert "UID:gone-1" in feed(token)

    call("admin_set_disabled", '("gone", true)')
    assert status(get(f"/cal/{token}.ics")) == 404
    # Enabled again, the mailbox has no address until a member makes one
    call("admin_set_disabled", '("gone", false)')
    assert status(get_update(f"/cal/{token}.ics")) == 404
    assert "(null)" in mail("mail_cal_feed", "gone", "()", USER_A)
    token = token_of(mail("mail_cal_feed_reset", "gone", "()", USER_A))
    assert "UID:gone-1" in feed(token)

    purge("gone")
    assert status(get(f"/cal/{token}.ics")) == 404
    assert status(get_update(f"/cal/{token}.ics")) == 404
    # The address created again starts with no calendar and no feed
    assert "error" not in add_mailbox("gone", users[USER_A]).lower()
    assert "(null)" in mail("mail_cal_feed", "gone", "()", USER_A)
    assert status(get_update(f"/cal/{token}.ics")) == 404
