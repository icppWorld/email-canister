"""The built wasm modules stay within the IC's export rules.

The IC refuses a module with more than 1100 exports of any kind, on install and
on every call to a canister already running it. A link that exports every
symbol (libc++, the WASI polyfill) gives over 2000, so each module must export
only its memory and its canister_ entry points.

$ make build build-test build-relay-stub
$ pytest test/canister/test_wasm_exports.py
"""

# pylint: disable=missing-function-docstring

from pathlib import Path
from typing import List, Tuple

import pytest

from .support import ROOT

MAX_EXPORTS = 1100
MODULES = [
    ROOT / "build" / "email-canister.wasm",
    ROOT / "build" / "email-canister-test.wasm",
    ROOT / "test" / "relay_stub" / "build" / "relay_stub.wasm",
]
FUNCTION, MEMORY = 0, 2


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


@pytest.mark.parametrize("wasm", MODULES, ids=lambda path: path.name)
def test__a_module_exports_only_its_memory_and_entry_points(wasm: Path) -> None:
    found = exports(wasm)
    assert len(found) <= MAX_EXPORTS
    stray = [
        name
        for name, kind in found
        if not (kind == MEMORY or (kind == FUNCTION and name.startswith("canister_")))
    ]
    assert not stray, f"{len(stray)} stray exports, such as {stray[:5]}"
    assert any(name.startswith("canister_query ") for name, _ in found)
