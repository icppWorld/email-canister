"""The built wasm modules export exactly their entry points, within the IC's
export rules.

The IC refuses a module with more than 1100 exports of any kind, on install and
on every call to a canister already running it. A link that exports every
symbol (libc++, the WASI polyfill) gives over 2000, so each module must export
only its memory and its canister_ entry points: each method of its .did, and
the system functions it needs.

Needs no replica, only the three builds:
$ make build-all build-relay-stub
$ make test-wasm-exports
"""

# pylint: disable=missing-function-docstring

import re
from pathlib import Path
from typing import List, Set, Tuple

import pytest

ROOT = Path(__file__).parent.parent
MAX_EXPORTS = 1100
FUNCTION, MEMORY = 0, 2
METHOD_TYPES = ("canister_query ", "canister_update ", "canister_composite_query ")
# The async runtime's own method, which no .did names
RUNTIME_METHODS = {"__icpp_yield"}
# Without canister_pre_upgrade, the guard that refuses an upgrade while calls
# are in flight no longer runs
SYSTEM_FUNCTIONS = {
    "canister_init",
    "canister_post_upgrade",
    "canister_pre_upgrade",
    "canister_global_timer",
}
# Every system function the IC knows
KNOWN_SYSTEM_FUNCTIONS = SYSTEM_FUNCTIONS | {
    "canister_start",
    "canister_heartbeat",
    "canister_inspect_message",
    "canister_on_low_wasm_memory",
}

# Each module, its .did, and the system functions it must export
MODULES = [
    (
        ROOT / "build" / "email-canister.wasm",
        ROOT / "src" / "email-canister.did",
        SYSTEM_FUNCTIONS,
    ),
    (
        ROOT / "build" / "email-canister-test.wasm",
        ROOT / "test" / "email-canister-test.did",
        SYSTEM_FUNCTIONS,
    ),
    (
        ROOT / "test" / "relay_stub" / "build" / "relay_stub.wasm",
        ROOT / "test" / "relay_stub" / "relay_stub.did",
        set(),
    ),
]


def leb128(data: bytes, at: int) -> Tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return value, at


def exports(wasm: Path) -> List[Tuple[str, int]]:
    """Each export's name and kind"""
    data = wasm.read_bytes()
    assert data[:4] == b"\0asm", f"{wasm} is not a wasm module"
    at = 8
    while at < len(data):
        section = data[at]
        size, at = leb128(data, at + 1)
        end = at + size
        if section == 7:
            count, at = leb128(data, at)
            found = []
            for _ in range(count):
                length, at = leb128(data, at)
                name = data[at : at + length].decode()
                kind = data[at + length]
                _, at = leb128(data, at + length + 1)
                found.append((name, kind))
            return found
        at = end
    return []


def did_methods(did: Path) -> Set[str]:
    """The method names of the .did's service"""
    service = did.read_text().split("service :", 1)[1]
    return set(re.findall(r'^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:\s*\(', service, re.M))


@pytest.mark.parametrize(
    "wasm, did, system", MODULES, ids=[wasm.name for wasm, _, _ in MODULES]
)
def test__a_module_exports_exactly_its_entry_points(
    wasm: Path, did: Path, system: Set[str]
) -> None:
    found = exports(wasm)
    assert len(found) <= MAX_EXPORTS, f"{len(found)} exports"
    functions = {name for name, kind in found if kind == FUNCTION}
    stray = sorted(
        name
        for name, kind in found
        if not (
            kind == MEMORY
            or (
                kind == FUNCTION
                and (name in KNOWN_SYSTEM_FUNCTIONS or name.startswith(METHOD_TYPES))
            )
        )
    )
    assert not stray, f"{len(stray)} stray exports, such as {stray[:5]}"
    assert system <= functions, f"missing {sorted(system - functions)}"
    methods = [
        name[len(prefix) :]
        for name in functions
        for prefix in METHOD_TYPES
        if name.startswith(prefix)
    ]
    twice = sorted({name for name in methods if methods.count(name) > 1})
    assert not twice, f"exported under two call types: {twice}"
    assert set(methods) - RUNTIME_METHODS == did_methods(did)
