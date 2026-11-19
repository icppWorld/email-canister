"""Decodes a known sample in every supported charset.

Compiles shims/charconv.c natively, so it needs no canister:

$ pytest test/test_charsets.py
"""

import subprocess
from pathlib import Path

# pylint: disable=missing-function-docstring

import pytest

ROOT = Path(__file__).parent.parent

GERMAN = "Grüße aus Köln"
POLISH = "Zażółć gęślą jaźń"
RUSSIAN = "Съешь же ещё этих мягких булок"
JAPANESE = "こんにちは世界、メールのテストです"
SIMPLIFIED = "你好，世界。这是一封邮件"
TRADITIONAL = "你好，世界。這是一封郵件"
KOREAN = "안녕하세요 세계, 메일 시험입니다"

SAMPLES = [
    ("us-ascii", "ascii", "plain ascii"),
    ("UTF-8", "utf-8", RUSSIAN),
    ("utf8", "utf-8", JAPANESE),
    ("iso-8859-1", "iso8859_1", GERMAN),
    ("ISO_8859-1", "iso8859_1", GERMAN),
    ("latin1", "iso8859_1", GERMAN),
    ("iso-8859-2", "iso8859_2", POLISH),
    ("iso-8859-3", "iso8859_3", "Çava? Ħello"),
    ("iso-8859-4", "iso8859_4", "Grüße ķēda"),
    ("iso-8859-5", "iso8859_5", RUSSIAN),
    ("iso-8859-6", "iso8859_6", "مرحبا بالعالم"),
    ("iso-8859-7", "iso8859_7", "Γειά σου Κόσμε"),
    ("iso-8859-8", "iso8859_8", "שלום עולם"),
    ("iso-8859-9", "iso8859_9", "Merhaba Dünya, İyi günler"),
    ("iso-8859-10", "iso8859_10", "Grüße ŋð"),
    ("iso-8859-11", "iso8859_11", "สวัสดีชาวโลก"),
    ("iso-8859-13", "iso8859_13", "Labas pasauli, ąčę"),
    ("iso-8859-14", "iso8859_14", "Helô Ŵŷ"),
    ("iso-8859-15", "iso8859_15", "Prix 10 € œuvre"),
    ("iso-8859-16", "iso8859_16", "Bună ziua, țară"),
    ("windows-1250", "cp1250", POLISH),
    ("windows-1251", "cp1251", RUSSIAN),
    ("cp1251", "cp1251", RUSSIAN),
    ("windows-1252", "cp1252", "Prix 10 € “quoted”"),
    ("windows-1253", "cp1253", "Γειά σου Κόσμε"),
    ("windows-1254", "cp1254", "Merhaba Dünya, İyi günler"),
    ("windows-1255", "cp1255", "שלום עולם"),
    ("windows-1256", "cp1256", "مرحبا بالعالم"),
    ("windows-1257", "cp1257", "Labas pasauli, ąčę"),
    ("windows-1258", "cp1258", "Xin chào"),
    ("koi8-r", "koi8_r", RUSSIAN),
    ("koi8-u", "koi8_u", "Привіт, світе"),
    ("iso-2022-jp", "iso2022_jp", JAPANESE),
    ("shift_jis", "shift_jis", JAPANESE),
    ("sjis", "shift_jis", JAPANESE),
    ("windows-31j", "cp932", JAPANESE + "①"),
    ("euc-jp", "euc_jp", JAPANESE),
    ("gb2312", "gb2312", SIMPLIFIED),
    ("gbk", "gbk", SIMPLIFIED),
    ("gb18030", "gb18030", SIMPLIFIED + "€ ḿ 𠀀"),
    ("big5", "big5", TRADITIONAL),
    ("euc-kr", "euc_kr", KOREAN),
    ("ks_c_5601-1987", "euc_kr", KOREAN),
    ("cp949", "cp949", KOREAN + " 똠"),
]


@pytest.fixture(scope="module", name="harness")
def fixture_harness(tmp_path_factory: pytest.TempPathFactory) -> Path:
    binary = tmp_path_factory.mktemp("charconv") / "harness"
    subprocess.run(
        [
            "clang",
            "-g",
            "-fsanitize=address,undefined",
            f"-I{ROOT}/vendor/libetpan/libetpan",
            f"-I{ROOT}/shims",
            f"-I{ROOT}/shims/libetpan",
            str(ROOT / "test/charconv_harness.c"),
            str(ROOT / "shims/charconv.c"),
            str(ROOT / "shims/charset_tables.c"),
            "-o",
            str(binary),
        ],
        check=True,
    )
    return binary


def convert(harness: Path, charset: str, raw: bytes) -> str:
    done = subprocess.run(
        [str(harness), charset, raw.hex()], capture_output=True, text=True, check=True
    )
    output = done.stdout.strip()
    assert output != "error", charset
    return bytes.fromhex(output).decode("utf-8")


@pytest.mark.parametrize("charset,codec,text", SAMPLES)
def test_sample(harness: Path, charset: str, codec: str, text: str) -> None:
    assert convert(harness, charset, text.encode(codec)) == text


def test_unknown_charset_is_reported(harness: Path) -> None:
    done = subprocess.run(
        [str(harness), "no-such-charset", b"abc".hex()],
        capture_output=True,
        text=True,
        check=True,
    )
    assert done.stdout.strip() == "error"


@pytest.mark.parametrize(
    "charset",
    ["utf-8", "iso-2022-jp", "shift_jis", "euc-jp", "gb18030", "big5", "euc-kr"],
)
def test_malformed_input_is_replaced_not_fatal(harness: Path, charset: str) -> None:
    raw = bytes([0xE3, 0x81, 0xFF, 0x1B, 0x24, 0x42, 0x24, 0x81, 0x30, 0xFE])
    # A truncated multi-byte sequence at the very end must not read past the input
    assert convert(harness, charset, raw + b"\xfe") is not None
