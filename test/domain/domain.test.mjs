// domain/domain.mjs: what it writes, and what it refuses.
//
// $ node --test test/domain/*.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkOptions, domainFiles, redirectFiles } from "../../domain/domain.mjs";

const script = fileURLToPath(new URL("../../domain/domain.mjs", import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "domain-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BACKEND = "ryjl3-tyaaa-aaaaa-aaaba-cai";

function run(...args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

test("writes the handoff, the domain list, the redirect and the asset rules", () => {
  const out = path.join(scratch, "written");
  const { ok, output } = run("--out", out, "--backend", BACKEND, "--domain", "example.com");
  assert.ok(ok, output);
  const read = (file) => readFileSync(path.join(out, file), "utf8");
  assert.equal(read(".well-known/ic-smtp-canister-id"), BACKEND);
  assert.equal(read(".well-known/ic-domains"), "example.com\n");
  assert.match(read("index.html"), /<noscript><meta http-equiv="refresh" content="0; url=https:\/\/www\.example\.com\/"><\/noscript>/);
  assert.match(read("index.html"), /<a href="https:\/\/www\.example\.com\/">/);
  assert.match(read("index.html"), /<link rel="canonical" href="https:\/\/www\.example\.com\/">/);
  assert.match(read("index.html"), /<script src="\/redirect\.js"><\/script>/);
  assert.equal(
    read("redirect.js"),
    'location.replace("https://www.example.com" + location.pathname + location.search + location.hash);\n',
  );
  const rules = JSON.parse(read(".ic-assets.json5"));
  assert.deepEqual(rules.slice(0, 2).map((r) => [r.match, r.ignore]), [[".well-known", false], [".well-known/*", false]]);
  assert.equal(rules[1].headers["Access-Control-Allow-Origin"], "*");
  assert.match(rules[2].headers["Content-Security-Policy"], /^default-src 'none'; script-src 'self';/);
  assert.ok(existsSync(path.join(out, ".domain-output")));
});

test("takes another website origin", () => {
  const files = domainFiles({ backend: BACKEND, domain: "example.com", redirect: "https://site.example.org" });
  assert.match(files.get("redirect.js"), /^location\.replace\("https:\/\/site\.example\.org" \+/);
});

test("refuses a bad backend, domain or website origin", () => {
  const refused = [
    [{ backend: "Not-An-Id", domain: "example.com" }, /--backend/],
    [{ domain: "example.com" }, /--backend/],
    [{ backend: BACKEND, domain: "Example.com" }, /--domain/],
    [{ backend: BACKEND, domain: "localhost" }, /--domain/],
    [{ backend: BACKEND, domain: "example.com." }, /--domain/],
    [{ backend: BACKEND, domain: "example.com", redirect: "http://www.example.com" }, /--redirect/],
    [{ backend: BACKEND, domain: "example.com", redirect: "https://www.example.com/" }, /--redirect/],
    [{ backend: BACKEND, domain: "example.com", redirect: "https://www.example.com/home" }, /--redirect/],
    [{ backend: BACKEND, domain: "example.com", redirect: "https://www.example.com:8443" }, /--redirect/],
    [{ backend: BACKEND, domain: "example.com", redirect: "https://example.com" }, /loop/],
    [{ backend: BACKEND, domain: "example.com", redirect: "www.example.com" }, /--redirect/],
    [{ backend: BACKEND, domain: "1.2.3.4" }, /--domain/],
    [{ backend: BACKEND, domain: `${"a".repeat(64)}.com` }, /--domain/],
    [{ backend: BACKEND, domain: "example.com", redirect: "https://1.2.3.4" }, /--redirect/],
  ];
  for (const [options, message] of refused) {
    assert.throws(() => checkOptions(options), message, JSON.stringify(options));
  }
});

test("refuses a hostile website origin, and escapes the page's text", () => {
  for (const redirect of ['https://a"><script>alert(1)</script>.example', "https://a'b.example", "javascript:alert(1)"]) {
    assert.throws(() => checkOptions({ backend: BACKEND, domain: "example.com", redirect }), /--redirect/, redirect);
  }
  // The checks above keep such text out; the page is escaped all the same
  const hostile = 'https://x.example/"></script><script>alert(1)</script>';
  const { "index.html": html, "redirect.js": js } = redirectFiles(hostile);
  assert.ok(!html.includes("<script>alert"), html);
  assert.equal(html.split("</script>").length, 2, html);
  assert.ok(html.includes("&quot;&gt;&lt;/script&gt;"), html);
  assert.equal(js, `location.replace(${JSON.stringify(hostile)} + location.pathname + location.search + location.hash);\n`);
});

test("writes only into an empty folder or its own earlier output", () => {
  const out = path.join(scratch, "rewritten");
  const args = ["--backend", BACKEND, "--domain", "example.com"];
  assert.ok(run("--out", out, ...args).ok);
  writeFileSync(path.join(out, "stale.txt"), "from an earlier run");
  assert.ok(run("--out", out, ...args).ok);
  assert.ok(!existsSync(path.join(out, "stale.txt")));

  const foreign = path.join(scratch, "foreign");
  mkdirSync(foreign);
  writeFileSync(path.join(foreign, "keep.txt"), "someone else's");
  const { ok, output } = run("--out", foreign, ...args);
  assert.ok(!ok);
  assert.match(output, /not empty and was not written by this script/);
  assert.ok(existsSync(path.join(foreign, "keep.txt")));
});

test("refuses unknown or incomplete options", () => {
  for (const args of [["--out", path.join(scratch, "x"), "--backend", BACKEND, "--domain"], ["--colour", "red"], []]) {
    const { ok, output } = run(...args);
    assert.ok(!ok, args.join(" "));
    assert.match(output, /^domain: /);
  }
});
