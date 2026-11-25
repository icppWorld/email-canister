"""Both builds link the one set of libraries in build-library/, and every file
that names the release names the version in version.txt.

$ pytest test/test_build_config.py
"""

import json
import re
import tomllib
from pathlib import Path
from typing import Any

# pylint: disable=missing-function-docstring

ROOT = Path(__file__).parent.parent


def libraries(name: str, table: str = "build-library") -> list[dict[str, Any]]:
    """The [[build-library]] tables of one toml file, or those named `table`"""
    tables: list[dict[str, Any]] = tomllib.loads((ROOT / name).read_text())[table]
    return tables


def test__test_build_uses_the_same_libraries() -> None:
    assert libraries("icpp.toml") == libraries("icpp-test.toml")


def test__native_tests_build_sqlite_as_the_canister_does() -> None:
    [native] = [
        t
        for t in libraries("icpp-test.toml", "build-library-native")
        if t["lib_name"] == "sqlite3"
    ]
    # The canister's flags, and none of its own
    assert native.get("inherit_compile_flags") is True
    assert not native.get("c_compile_flags") and not native.get("cpp_compile_flags")


def relay_interface(did: str) -> dict[str, set[str]]:
    """relaySend's signature and the types it uses, without names, quotes,
    spaces or field order"""
    text = re.sub(r"//[^\n]*", "", (ROOT / did).read_text())
    found: dict[str, set[str]] = {}
    for name in ("RelayStatus", "RelayRequest", "RelayAttachment"):
        body = re.search(rf"type {name}\s*=\s*(\w+)\s*\{{(.*?)\}};", text, re.S)
        assert body, f"no {name} in {did}"
        found[name] = {body.group(1)} | {
            re.sub(r"\s+", "", field) for field in body.group(2).split(";")
        } - {""}
    signature = re.search(
        r'"?relaySend"?\s*:\s*\(([^)]*)\)\s*->\s*\(([^)]*)\)\s*(\w*)\s*[;}]', text
    )
    assert signature, f"no relaySend in {did}"
    argument, result = (re.sub(r"\s+|\w+:", "", signature.group(i)) for i in (1, 2))
    # The mode too (query, composite_query or none), so the two agree on it
    found["relaySend"] = {f"{argument}->{result} {signature.group(3)}"}
    return found


def test__the_relay_stub_matches_the_bridge() -> None:
    # The replica tests send through the stub; the bridge's own .did is built
    # from its Motoko (test/bridge/build.sh)
    assert relay_interface("test/relay_stub/relay_stub.did") == relay_interface(
        "test/bridge/bridge.did"
    )


def test__no_vendored_code_is_compiled_into_the_canister() -> None:
    for name in ("icpp.toml", "icpp-test.toml"):
        paths = tomllib.loads((ROOT / name).read_text())["build-wasm"]["c_paths"]
        assert paths == ["src/ingest/mime_extract.c"]


def test__the_release_build_uses_the_toolchain_the_tests_use() -> None:
    # Only the ICPP_VERSION line is read: the file is not shown on a failure
    [docker] = [
        line.split("=", 1)[1].strip()
        for line in (ROOT / "docker/.env").read_text().splitlines()
        if line.startswith("ICPP_VERSION=")
    ]
    [tests] = [
        line.split("==", 1)[1].strip()
        for line in (ROOT / "requirements.txt").read_text().splitlines()
        if line.startswith("icpp-pro==")
    ]
    assert docker == tests, f"docker/.env has {docker}, requirements.txt {tests}"


def test__every_file_names_the_version_in_version_txt() -> None:
    version = (ROOT / "version.txt").read_text().strip()
    npm_version = version.replace("rc", "-rc")  # 0.2.0rc1 is 0.2.0-rc1 to npm
    webmail = json.loads((ROOT / "webmail/package.json").read_text())
    lock = json.loads((ROOT / "webmail/package-lock.json").read_text())
    assert webmail["version"] == npm_version
    assert lock["version"] == lock["packages"][""]["version"] == npm_version
    explainer = (ROOT / "docs/how-it-works.html").read_text()
    assert set(re.findall(r"v(\d+\.\d+\.\d+(?:rc\d+)?)(?!\d)", explainer)) == {version}


def test__only_the_store_opens_database_files() -> None:
    # A file has one connection, so that the canister knows every open file
    # and can close it before a purge or an export (docs/storage-per-mailbox.md)
    opener = re.compile(r"\bsqlite3_open|\battach\b|\bvacuum\s+into\b", re.IGNORECASE)
    # shims/ is compiled into the canister too
    sources = [
        p
        for folder in ("src", "shims")
        for p in (ROOT / folder).rglob("*")
        if p.suffix in (".c", ".cpp", ".h") and not p.name.startswith("._")  # macOS
    ]
    # Adjacent string literals are one string to the compiler
    found = [
        f"{p.relative_to(ROOT)}: {match.group(0)}"
        for p in sources
        if p.relative_to(ROOT) != Path("src/store/db.cpp")
        for match in opener.finditer(re.sub(r'"\s*"', "", p.read_text()))
    ]
    assert found == []
