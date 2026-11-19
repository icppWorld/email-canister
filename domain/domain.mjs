#!/usr/bin/env node
// Writes a deployment's domain canister: a small asset canister that serves the
// bare domain when the domain's website serves only www, as a Caffeine app does
// for a domain registered elsewhere. It tells the SMTP gateway which backend
// receives the domain's mail, and sends browsers on to the website. Plain
// Node.js 20 or later, with no dependencies.
//
//   node domain.mjs --out <folder> --backend <canister id> --domain example.com
//                   [--redirect https://www.example.com]
//
// --redirect is the website's origin, https://www.<domain> by default. Every
// path on the bare domain goes there, keeping its path, query and fragment.

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The same checks as brand.mjs and configure.sh
const PRINCIPAL = /^[a-z0-9]{5}(-[a-z0-9]{5})*(-[a-z0-9]{1,5})?$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const OUTPUT_MARKER = ".domain-output";

// The asset canister's rules. It skips names that start with a dot, such as
// the marker, unless a rule says otherwise, as these do for .well-known.
const ASSETS = [
  { match: ".well-known", ignore: false },
  { match: ".well-known/*", ignore: false, headers: { "Access-Control-Allow-Origin": "*" } },
  {
    match: "**/*",
    security_policy: "hardened",
    disable_security_policy_warning: true,
    headers: {
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  },
];

export class DomainError extends Error {}

function fail(message) {
  throw new DomainError(`domain: ${message}`);
}

export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A name within DNS's limits, not an IP address: the last label holds a letter
const isDomain = (name) =>
  DOMAIN.test(name) && name.length <= 253 && name.split(".").every((label) => label.length <= 63) &&
  /[a-z]/.test(name.slice(name.lastIndexOf(".") + 1));

export function checkOptions({ backend, domain, redirect }) {
  if (!backend || !PRINCIPAL.test(backend)) fail(`--backend ${backend ?? ""}: give the backend canister's id`);
  if (!domain || !isDomain(domain)) fail(`--domain ${domain ?? ""}: give a lower-case domain such as example.com`);
  const target = redirect ?? `https://www.${domain}`;
  let url;
  try {
    url = new URL(target);
  } catch {
    fail(`--redirect ${target}: not a URL`);
  }
  if (url.protocol !== "https:" || url.port || url.origin !== target || !isDomain(url.hostname)) {
    fail(`--redirect ${target}: give an origin like https://www.example.com, with no path or port`);
  }
  if (url.hostname === domain) fail(`--redirect ${target}: must be another host than ${domain}, or browsers loop`);
  return { backend, domain, target };
}

// The redirect page. The script keeps the path, query and fragment; without
// scripts the refresh goes to the website's home page. The refresh sits in
// <noscript>, so it cannot cut the script's redirect short. The canonical link
// tells search engines that the website, not the bare domain, is the page.
export function redirectFiles(target) {
  const home = `${target}/`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(new URL(target).hostname)}</title>
<script src="/redirect.js"></script>
<noscript><meta http-equiv="refresh" content="0; url=${escapeHtml(home)}"></noscript>
<link rel="canonical" href="${escapeHtml(home)}">
</head>
<body>
<p>This site is at <a href="${escapeHtml(home)}">${escapeHtml(home)}</a>.</p>
</body>
</html>
`;
  const script = `location.replace(${JSON.stringify(target)} + location.pathname + location.search + location.hash);\n`;
  return { "index.html": html, "redirect.js": script };
}

// Every file the canister serves, by path
export function domainFiles(options) {
  const { backend, domain, target } = checkOptions(options);
  return new Map([
    // The SMTP gateway reads this to find the canister that receives the domain's mail
    [".well-known/ic-smtp-canister-id", backend],
    // The IC's custom-domain service registers only the domains a canister lists here
    [".well-known/ic-domains", `${domain}\n`],
    ...Object.entries(redirectFiles(target)),
    [".ic-assets.json5", `${JSON.stringify(ASSETS, null, 2)}\n`],
  ]);
}

// Writes the files into out, which must be empty or an earlier output
export function writeDomain({ out, ...options }) {
  if (!out) fail("--out is required");
  const files = domainFiles(options);
  if (existsSync(out)) {
    if (!lstatSync(out).isDirectory()) fail(`--out ${out} is not a folder`);
    if (readdirSync(out).length > 0) {
      if (!existsSync(path.join(out, OUTPUT_MARKER))) fail(`${out} is not empty and was not written by this script`);
      rmSync(out, { recursive: true });
    }
  }
  // The marker goes first, so a run that stops halfway can be repeated
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, OUTPUT_MARKER), "Written by domain.mjs; deleted and rewritten on the next run.\n");
  for (const [file, content] of files) {
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    writeFileSync(path.join(out, file), content);
  }
  return files;
}

function parseArgs(argv) {
  const known = new Set(["out", "backend", "domain", "redirect"]);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!known.has(key) || argv[i + 1] === undefined) fail(`unknown or incomplete option ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  return args;
}

// Run directly, also through a symlink, rather than imported
const invoked = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : "";
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    writeDomain(args);
    console.log(`domain: wrote the domain canister for ${args.domain}`);
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
