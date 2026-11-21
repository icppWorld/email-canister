"""What the replica tests share"""

# pylint: disable=missing-function-docstring

import base64
import re
import subprocess
import time
import zlib
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

from .toolchain import call_canister_api

ROOT = Path(__file__).parent.parent.parent
ICP_YAML_PATH = ROOT / "icp.yaml"
CANISTER_NAME = "email-canister-test"
DOMAIN = "mail.example"

QUEUED, INDEXED, QUARANTINED = 0, 1, 2


def run_icp(*args: str, identity: str) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(
        ["icp", *args, "--environment", "local", "--identity", identity],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def icp_any(*args: str, identity: str) -> str:
    """Runs icp, and returns its output whether or not it failed"""
    done = run_icp(*args, identity=identity)
    return done.stdout + done.stderr


def icp(*args: str, identity: str) -> str:
    done = run_icp(*args, identity=identity)
    assert done.returncode == 0, done.stdout + done.stderr
    return done.stdout


def call(method: str, argument: str = "()", identity: Optional[str] = None) -> str:
    return call_canister_api(
        icp_yaml_path=ICP_YAML_PATH,
        canister_name=CANISTER_NAME,
        canister_method=method,
        canister_argument=argument,
        network="local",
        identity=identity,
    )


def number(output: str, field: str) -> int:
    found = re.search(rf"\b{field} = ([\d_]+)", output)
    assert found, f"no {field} in {output}"
    return int(found.group(1).replace("_", ""))


def text(output: str, field: str) -> str:
    found = re.search(rf'\b{field} = "(.*?)"(?:;|\s*\}})', output, re.S)
    assert found, f"no {field} in {output}"
    return found.group(1)


def stats() -> Dict[str, int]:
    output = call("admin_ingest_stats")
    names = ("queued", "indexed", "quarantined", "quarantined_moves")
    return {name: number(output, name) for name in names}


def wait_until(done: Callable[[], bool], what: str, seconds: float = 90) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if done():
            return
        time.sleep(0.5)
    raise AssertionError(f"{what} did not happen in {seconds} s")


def wait_until_drained(seconds: float = 90) -> Dict[str, int]:
    deadline = time.time() + seconds
    while time.time() < deadline:
        current = stats()
        if current["queued"] == 0:
            return current
        time.sleep(0.5)
    raise AssertionError(f"the backlog did not drain: {stats()}")


# A message, as its mailbox and its uid there
Hit = Tuple[str, int]


def search(query: str) -> List[Hit]:
    output = call("dev_search", f'("{query}")')
    return [
        (text(record, "mailbox"), number(record, "uid"))
        for record in re.findall(r"record \{[^}]*\}", output)
    ]


def message(hit: Hit) -> str:
    return call("dev_message", f'("{hit[0]}", {hit[1]} : nat64)')


def blob_of(output: str, field: str) -> bytes:
    """A blob in a reply, which icp prints as \\xx escapes"""
    found = re.search(rf'\b{field} = blob "((?:\\[0-9a-f]{{2}})*)"', output)
    assert found, f"no {field} in {output[:500]}"
    return bytes.fromhex(found.group(1).replace("\\", ""))


def candid_blob(data: bytes) -> str:
    return "".join(f"\\{byte:02x}" for byte in data)


def request(
    subject: str = "Hello",
    message_id: Optional[str] = "<a@sender.example>",
    to: str = "alice",
    domain: str = DOMAIN,
    body: bytes = b"hello world",
    extra_headers: str = "",
    sender: str = "sender",
    date: str = "Mon, 9 Nov 2026 12:00:00 +0100",
    from_address: str = "sender@sender.example",
    from_header: Optional[str] = None,
) -> str:
    """An SmtpRequest. from_header, when given, is the whole From header's
    value, in place of "Sender <from_address>", as Candid text: its quotes
    escaped as \\\"."""
    recipients = "; ".join(
        f'record {{ user = "{user}"; domain = "{domain}" }}' for user in to.split(",")
    )
    from_value = f"Sender <{from_address}>" if from_header is None else from_header
    id_header = (
        f'record {{ name = "Message-ID"; value = " {message_id}\\r\\n" }}; '
        if message_id
        else ""
    )
    return (
        '(record { message_id = opt "gateway-1"; gateway_flags = null; '
        "envelope = opt record { "
        f'from = record {{ user = "{sender}"; domain = "sender.example" }}; '
        f"to = vec {{ {recipients} }} }}; "
        f"message = opt record {{ headers = vec {{ {id_header}"
        f'record {{ name = "From"; value = " {from_value}\\r\\n" }}; '
        f'record {{ name = "Date"; value = " {date}\\r\\n" }}; '
        f"{extra_headers}"
        f'record {{ name = "Subject"; value = " {subject}\\r\\n" }} }}; '
        f'body = blob "{candid_blob(body)}" }} }})'
    )


OK = r"variant\s*\{\s*Ok"


def fake_principal(n: int) -> str:
    """A valid principal that no identity holds"""
    raw = b"\x10" + n.to_bytes(8, "big") + b"\x01"
    textual = base64.b32encode(zlib.crc32(raw).to_bytes(4, "big") + raw).decode()
    textual = textual.lower().rstrip("=")
    return "-".join(textual[i : i + 5] for i in range(0, len(textual), 5))


def mail(
    method: str, local: str, argument: str = "()", identity: Optional[str] = None
) -> str:
    """Calls a mailbox method on the mailbox `local`, before `argument`'s own"""
    rest = argument.strip()[1:].strip()
    return call(method, f'("{local}"' + ("" if rest == ")" else ", ") + rest, identity)


def create_mailbox(
    local: str, identity: Optional[str] = None, first_member: Optional[str] = None
) -> str:
    first = f'opt principal "{first_member}"' if first_member else "null"
    return call(
        "admin_create_mailbox",
        f'(record {{ local = "{local}"; quota_bytes = null; first_member = {first} }})',
        identity,
    )


def add_member(local: str, principal: str, identity: Optional[str] = None) -> str:
    return call(
        "admin_add_member", f'("{local}", principal "{principal}", null)', identity
    )


def add_mailbox(local: str, principal: str, identity: Optional[str] = None) -> str:
    """Creates the mailbox `local` with `principal` as its one member"""
    return create_mailbox(local, identity, principal)


def deliver(*args: object, **kwargs: object) -> str:
    return call("smtp_request", request(*args, **kwargs))  # type: ignore[arg-type]


def record_with(output: str, local: str) -> str:
    """The innermost record in a reply that has the field `local = "<local>"`,
    nested records included, however didc lays it out. Quoted text, such as a
    name, is skipped, so braces in it do not count, and so is a field whose
    name only ends in local."""
    key = f'local = "{local}"'
    opened: list[int] = []  # where each record or vec still open starts
    depth = None  # how many were open where the key was found
    quoted = escaped = False
    for at, c in enumerate(output):
        if quoted:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                quoted = False
        elif (
            depth is None
            and output.startswith(key, at)
            and (at == 0 or output[at - 1] in "{;" or output[at - 1].isspace())
        ):
            depth = len(opened)
        elif c == '"':
            quoted = True
        elif c == "{":
            # A record is returned from its keyword
            opened.append(at - 7 if output.endswith("record ", 0, at) else at)
        elif c == "}":
            if not opened:
                break
            start = opened.pop()
            if depth is not None and len(opened) < depth:
                return output[start : at + 1]
    raise AssertionError(f"no whole record for {local}: {output}")


def entry_line(local: str) -> str:
    return record_with(call("admin_list_entries"), local)


def clean_due(local: str) -> bool:
    """Whether the mailbox waits for the pump to clean out its expired mail"""
    return "true" in call("dev_clean_due", f'("{local}")')


def purge(local: str) -> None:
    call("admin_set_disabled", f'("{local}", true)')
    while number(call("admin_purge", f'("{local}")'), "remaining") > 0:
        pass
