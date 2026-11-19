// The relay bridge against PocketIC, with the mail gateway's answers mocked.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PocketIc } from "@dfinity/pic";
import type { Actor, DeferredActor, PendingHttpsOutcall } from "@dfinity/pic";
import type { ActorMethod } from "@icp-sdk/core/agent";
import type { Principal } from "@icp-sdk/core/principal";
import type { IDL } from "@icp-sdk/core/candid";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { relayCaller, stranger } from "./identities.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    PIC_URL: string;
  }
}

type RelayAttachment = { filename: string; base64: string };
type RelayRequest = {
  outboxId: string;
  fromUsername: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  htmlBody: string;
  attachments: RelayAttachment[];
};
type RelayStatus = { sending: bigint } | { sent: null } | { rejected: string } | { unknown: string };
type Service = {
  relaySend: ActorMethod<[RelayRequest], RelayStatus>;
  base64Check: ActorMethod<[string], [boolean, bigint]>;
  keepResult: ActorMethod<[string, RelayStatus], undefined>;
  jsonString: ActorMethod<[string], [string, bigint]>;
  postFee: ActorMethod<[bigint], [bigint, [] | [bigint]]>;
  resultKeys: ActorMethod<[], string[]>;
};

const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const RelayAttachment = IDL.Record({ filename: IDL.Text, base64: IDL.Text });
  const RelayRequest = IDL.Record({
    outboxId: IDL.Text,
    fromUsername: IDL.Text,
    to: IDL.Vec(IDL.Text),
    cc: IDL.Vec(IDL.Text),
    bcc: IDL.Vec(IDL.Text),
    subject: IDL.Text,
    htmlBody: IDL.Text,
    attachments: IDL.Vec(RelayAttachment),
  });
  const RelayStatus = IDL.Variant({
    sending: IDL.Int,
    sent: IDL.Null,
    rejected: IDL.Text,
    unknown: IDL.Text,
  });
  return IDL.Service({
    relaySend: IDL.Func([RelayRequest], [RelayStatus], []),
    base64Check: IDL.Func([IDL.Text], [IDL.Bool, IDL.Nat64], []),
    keepResult: IDL.Func([IDL.Text, RelayStatus], [], []),
    jsonString: IDL.Func([IDL.Text], [IDL.Text, IDL.Nat64], []),
    postFee: IDL.Func([IDL.Nat], [IDL.Nat, IDL.Opt(IDL.Nat)], []),
    resultKeys: IDL.Func([], [IDL.Vec(IDL.Text)], ["query"]),
  });
};

const WASM = resolve(import.meta.dirname, "build", "bridge.wasm");
/** The bridge as v0.1.4 released it */
const WASM_V014 = resolve(import.meta.dirname, "build", "v0.1.4", "bridge.wasm");
const GATEWAY_URL = "https://gateway.example.com";
const API_KEY = "test-api-key";
const MINUTE = 60_000;
/** The backend's retry interval, the gateway's replay window, and the part of it in which the bridge posts */
const RETRY = MINUTE;
const WINDOW = 10 * MINUTE;
const POST_WINDOW = 8 * MINUTE;
/** How long a post may stay in flight before the bridge takes it as ended */
const IN_FLIGHT = 4 * MINUTE;
/** How long a final result is kept */
const WEEK = 7 * 24 * 60 * MINUTE;

let pic: PocketIc;
let relay: DeferredActor<Service>;
let nextId = 0;

/** A request with its own outboxId, as the backend makes one */
function request(fields: Partial<RelayRequest> = {}): RelayRequest {
  nextId += 1;
  return {
    outboxId: `test-${nextId}-0`,
    fromUsername: "noreply",
    to: ["someone@example.com"],
    cc: [],
    bcc: [],
    subject: "Hello",
    htmlBody: "<p>Hello</p>",
    attachments: [],
    ...fields,
  };
}

/** The gateway's answer to one outcall */
type Answer = { status: number; body?: string } | { reject: number; message: string };

/** Ticks until an outcall that is not in `known` is pending, and returns it. */
async function newOutcall(known: PendingHttpsOutcall[]): Promise<PendingHttpsOutcall> {
  const ids = new Set(known.map((outcall) => outcall.requestId));
  for (let i = 0; i < 20; i++) {
    await pic.tick();
    const fresh = (await pic.getPendingHttpsOutcalls()).filter((outcall) => !ids.has(outcall.requestId));
    if (fresh.length > 0) {
      expect(fresh).toHaveLength(1);
      return fresh[0];
    }
  }
  throw new Error("no outcall was made");
}

async function answer(outcall: PendingHttpsOutcall, reply: Answer): Promise<void> {
  await pic.mockPendingHttpsOutcall({
    subnetId: outcall.subnetId,
    requestId: outcall.requestId,
    response:
      "status" in reply
        ? { type: "success", statusCode: reply.status, headers: [], body: new TextEncoder().encode(reply.body ?? "") }
        : { type: "reject", statusCode: reply.reject, message: reply.message },
  });
}

/**
 * Calls relaySend and answers each outcall it makes with the next answer.
 * Fails if it makes more outcalls than there are answers.
 */
async function send(
  req: RelayRequest,
  ...answers: Answer[]
): Promise<{ status: RelayStatus; outcalls: PendingHttpsOutcall[] }> {
  const pending = await pic.getPendingHttpsOutcalls();
  const finish = await relay.relaySend(req);
  const outcalls: PendingHttpsOutcall[] = [];
  for (const reply of answers) {
    const outcall = await newOutcall(pending);
    outcalls.push(outcall);
    await answer(outcall, reply);
  }
  await pic.tick(5);
  expect(await pic.getPendingHttpsOutcalls()).toHaveLength(pending.length);
  return { status: await finish(), outcalls };
}

function header(outcall: PendingHttpsOutcall, name: string): string | undefined {
  return outcall.headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

function bodyText(outcall: PendingHttpsOutcall): string {
  return new TextDecoder().decode(outcall.body);
}

async function later(ms: number): Promise<void> {
  await pic.advanceTime(ms);
  await pic.tick();
}

/** The time in nanoseconds, as the bridge stores it */
async function now(): Promise<bigint> {
  return BigInt(await pic.getTime()) * 1_000_000n;
}

/** A configured bridge of its own, with `wasm` installed, as the one under test */
async function newRelay(wasm = WASM): Promise<Principal> {
  const { canisterId } = await pic.setupCanister<Service>({
    idlFactory,
    wasm,
    environmentVariables: [
      { name: "INTEGRATIONS_GATEWAY_URL", value: GATEWAY_URL },
      { name: "INTEGRATIONS_GATEWAY_API_KEY", value: API_KEY },
    ],
  });
  relay = pic.createDeferredActor<Service>({ idlFactory, canisterId, sender: relayCaller });
  return canisterId;
}

/** Upgrades a bridge to the one under test, keeping its memory as Caffeine does */
async function upgrade(canisterId: Principal): Promise<void> {
  await pic.upgradeCanister({
    canisterId,
    wasm: WASM,
    upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
  });
}

/** Calls a method of the bridge under test that makes no outcall */
async function call<T>(method: (relay: DeferredActor<Service>) => Promise<() => Promise<T>>): Promise<T> {
  return await (await method(relay))();
}

beforeAll(async () => {
  pic = await PocketIc.create(inject("PIC_URL"));
  await newRelay();
});

afterAll(async () => {
  await pic?.tearDown();
});

describe("relaySend", () => {
  it("refuses any caller but the backend", async () => {
    const { canisterId } = await pic.setupCanister<Service>({ idlFactory, wasm: WASM });
    const actor = pic.createActor<Service>({ idlFactory, canisterId, sender: stranger });
    await expect(actor.relaySend(request())).rejects.toThrow(/only the email-canister backend can relay email/);
  });

  it("posts the request to the gateway", async () => {
    const req = request({ subject: "a\u0001b\u001fc\u0008d\"e\\f\ng" });
    const { status, outcalls } = await send(req, { status: 200 });
    expect(status).toEqual({ sent: null });
    const [outcall] = outcalls;
    expect(outcall.url).toBe(`${GATEWAY_URL}/api/mail/v2/send`);
    expect(header(outcall, "idempotency-key")).toBe(`relay-${req.outboxId}`);
    expect(header(outcall, "authorization")).toBe(`Bearer ${API_KEY}`);
    const body = bodyText(outcall);
    // Control characters are escaped, never dropped
    expect(body).toContain('"subject":"a\\u0001b\\u001fc\\u0008d\\"e\\\\f\\ng"');
    expect(JSON.parse(body)).toMatchObject({ fromUsername: "noreply", to: ["someone@example.com"], subject: req.subject });
  });

  it("keeps #sent: a repeat does not post", async () => {
    const req = request();
    expect((await send(req, { status: 200 })).status).toEqual({ sent: null });
    expect((await send(req)).status).toEqual({ sent: null });
  });

  it("repeats a #rejected an older bridge kept: a repeat does not post", async () => {
    const req = request();
    await call((r) => r.keepResult(req.outboxId, { rejected: "HTTP 429: slow down" }));
    expect((await send(req)).status).toEqual({ rejected: "HTTP 429: slow down" });
  });

  it.each([301, 308, 400, 401, 403, 404, 413, 422])("keeps #rejected for HTTP %i: a repeat does not post", async (code) => {
    const req = request();
    const first = await send(req, { status: code, body: "refused" });
    expect(first.status).toEqual({ rejected: `HTTP ${code}: refused` });
    expect((await send(req)).status).toEqual(first.status);
  });

  it.each([408, 409, 425, 500, 502, 503])("retries HTTP %i with the same key, then reports #sent", async (code) => {
    const req = request();
    const first = await send(req, { status: code });
    expect(first.status).toHaveProperty("sending");
    await later(RETRY);
    const second = await send(req, { status: 200 });
    expect(second.status).toEqual({ sent: null });
    expect(header(second.outcalls[0], "idempotency-key")).toBe(header(first.outcalls[0], "idempotency-key"));
    expect(bodyText(second.outcalls[0])).toBe(bodyText(first.outcalls[0]));
  });

  it("reports the first attempt's time while it retries", async () => {
    const req = request();
    const first = await send(req, { status: 429 });
    await later(RETRY);
    const second = await send(req, { status: 429 });
    expect(second.status).toEqual(first.status);
  });

  it("retries HTTP 429 with the same key within the replay window", async () => {
    const req = request();
    const first = await send(req, { status: 429, body: "slow down" });
    expect(first.status).toHaveProperty("sending");
    await later(RETRY);
    const second = await send(req, { status: 429, body: "slow down" });
    expect(second.status).toHaveProperty("sending");
    expect(header(second.outcalls[0], "idempotency-key")).toBe(`relay-${req.outboxId}`);
  });

  it("rejects HTTP 429 after the replay window, and keeps it", async () => {
    const req = request();
    expect((await send(req, { status: 429, body: "slow down" })).status).toHaveProperty("sending");
    await later(WINDOW + RETRY);
    expect((await send(req)).status).toEqual({ rejected: "rate limited: HTTP 429: slow down" });
    expect((await send(req)).status).toEqual({ rejected: "rate limited: HTTP 429: slow down" });
  });

  it("reports #unknown after the window when an attempt may have sent, even if a later one was rate limited", async () => {
    const req = request();
    expect((await send(req, { status: 500 })).status).toHaveProperty("sending");
    await later(RETRY);
    expect((await send(req, { status: 429 })).status).toHaveProperty("sending");
    await later(WINDOW);
    expect((await send(req)).status).toEqual({ unknown: "rate limited: HTTP 429: " });
  });

  it.each([400, 401, 422])("keeps retrying HTTP %i after an attempt that may have sent, then reports #unknown", async (code) => {
    const req = request();
    expect((await send(req, { status: 502 })).status).toHaveProperty("sending");
    await later(RETRY);
    expect((await send(req, { status: code, body: "refused" })).status).toHaveProperty("sending");
    await later(WINDOW);
    expect((await send(req)).status).toEqual({ unknown: `HTTP ${code}: refused` });
  });

  it("takes a lost response as may have sent, even if the retry was rate limited", async () => {
    const req = request();
    const first = await send(req, { reject: 2, message: "lost" }, { status: 429, body: "slow down" });
    expect(first.status).toHaveProperty("sending");
    await later(WINDOW + RETRY);
    expect((await send(req)).status).toEqual({ unknown: "rate limited: HTTP 429: slow down" });
  });

  it("posts no more after the post window, and reports #unknown", async () => {
    const req = request();
    expect((await send(req, { status: 500 })).status).toHaveProperty("sending");
    await later(POST_WINDOW + 10_000);
    // No answer is given: a post now would fail the test
    expect((await send(req)).status).toEqual({ unknown: "HTTP 500: " });
  });

  it("keeps #unknown after the window, with its error text cut to 1024 characters", async () => {
    const req = request();
    expect((await send(req, { status: 500, body: "x".repeat(3000) })).status).toHaveProperty("sending");
    await later(WINDOW + RETRY);
    const { status } = await send(req);
    expect(status).toHaveProperty("unknown");
    const text = (status as { unknown: string }).unknown;
    expect(text).toHaveLength(1024);
    expect(text.startsWith("HTTP 500: xxx")).toBe(true);
    // Kept: a repeat does not post
    expect((await send(req)).status).toEqual(status);
  });

  it("retries a lost response at once with the same key", async () => {
    const req = request();
    const { status, outcalls } = await send(req, { reject: 2, message: "lost" }, { status: 200 });
    expect(status).toEqual({ sent: null });
    expect(header(outcalls[1], "idempotency-key")).toBe(header(outcalls[0], "idempotency-key"));
  });

  it("does not post again while an attempt is in flight", async () => {
    const req = request();
    const finish = await relay.relaySend(req);
    const outcall = await newOutcall([]);
    // The repeat returns without an outcall of its own
    const repeat = await send(req);
    expect(repeat.status).toHaveProperty("sending");
    await answer(outcall, { status: 200 });
    expect(await finish()).toEqual({ sent: null });
    expect((await send(req)).status).toEqual({ sent: null });
  });

  it("keeps the doubt a later post left when an earlier one is refused", async () => {
    const req = request();
    const finish = await relay.relaySend(req);
    const outcall = await newOutcall([]);
    // As a later call leaves the note after a post that may have sent the email
    await call((r) => r.keepResult(`${req.outboxId}/note`, { unknown: "HTTP 502: " }));
    await answer(outcall, { status: 400, body: "refused" });
    expect(await finish()).toHaveProperty("sending");
    await later(WINDOW);
    expect((await send(req)).status).toEqual({ unknown: "HTTP 400: refused" });
  });

  it("waits for a later post still in flight when an earlier one ends after the window", async () => {
    const req = request();
    const start = await now();
    const startedAt = start - BigInt(POST_WINDOW - 10_000) * 1_000_000n;
    await call((r) => r.keepResult(req.outboxId, { sending: startedAt }));
    await call((r) => r.keepResult(`${req.outboxId}/note`, { sending: startedAt }));
    const finish = await relay.relaySend(req);
    const outcall = await newOutcall([]);
    // As a later call posts while this one's post is in flight
    await call((r) => r.keepResult(`${req.outboxId}/note`, { sending: start + 1n }));
    await later(20_000);
    await answer(outcall, { status: 429, body: "slow down" });
    expect(await finish()).toEqual({ sending: startedAt });
  });

  // An outcall times out after about a minute, so an attempt cannot stay in
  // flight for the whole replay window
  it("retries an outcall that times out at once, then on the next call", async () => {
    const req = request();
    const finish = await relay.relaySend(req);
    const first = await newOutcall([]);
    await later(RETRY + 10_000);
    const retry = await newOutcall([]);
    expect(header(retry, "idempotency-key")).toBe(header(first, "idempotency-key"));
    await later(RETRY + 10_000);
    await pic.tick(5);
    expect(await pic.getPendingHttpsOutcalls()).toHaveLength(0);
    expect(await finish()).toHaveProperty("sending");
    const next = await send(req, { status: 200 });
    expect(next.status).toEqual({ sent: null });
    expect(header(next.outcalls[0], "idempotency-key")).toBe(header(first, "idempotency-key"));
  });

  it.each([
    ["a character outside the alphabet", "aGVsbG8*"],
    ["a quote", 'aGVs"G8='],
    ["a backslash", "aGVs\\G8="],
    ["padding in the middle", "aG=sbG8="],
    ["a length that is not a multiple of 4", "aGVsbG8"],
    ["too much padding", "aGV==="],
  ])("rejects an attachment with %s, without an outcall", async (_, base64) => {
    const req = request({ attachments: [{ filename: "file.txt", base64 }] });
    expect((await send(req)).status).toEqual({ rejected: "invalid attachment: file.txt" });
  });

  it.each(["", "x".repeat(129), "a/note", "a b", "a\nb", "a_b", "é", "relay-1:0"])("rejects the outboxId %j", async (outboxId) => {
    expect((await send(request({ outboxId }))).status).toEqual({ rejected: "invalid outboxId" });
  });

  it("accepts an outboxId of letters, digits and dashes up to 128 characters", async () => {
    const outboxId = `Ab-09-${"x".repeat(122)}`;
    expect((await send(request({ outboxId }), { status: 200 })).status).toEqual({ sent: null });
  });

  it("rejects a send while the gateway is not configured", async () => {
    const { canisterId } = await pic.setupCanister<Service>({ idlFactory, wasm: WASM });
    const unconfigured = pic.createDeferredActor<Service>({ idlFactory, canisterId, sender: relayCaller });
    const finish = await unconfigured.relaySend(request());
    await pic.tick(5);
    expect(await pic.getPendingHttpsOutcalls()).toHaveLength(0);
    expect(await finish()).toEqual({ rejected: expect.stringMatching(/gateway is not configured/) });
  });

  it("rejects an email whose escaped JSON is over the outcall limit, without an outcall", async () => {
    const req = request({ htmlBody: "\n".repeat(1_000_000) });
    const { status } = await send(req);
    expect(status).toHaveProperty("rejected");
    expect((status as { rejected: string }).rejected).toMatch(/^the email is too large to post: 2\d{6} bytes$/);
  });

  it("sends a 1.9 MB attachment within the instruction limit", async () => {
    const base64 = randomBytes(1_425_000).toString("base64");
    expect(base64).toHaveLength(1_900_000);
    const req = request({ attachments: [{ filename: "large.bin", base64 }] });
    const { status, outcalls } = await send(req, { status: 200 });
    expect(status).toEqual({ sent: null });
    expect(JSON.parse(bodyText(outcalls[0])).attachments[0].content).toBe(base64);
  });
});

describe("across upgrades", () => {
  it("still takes an email as may have sent after an upgrade", async () => {
    const canisterId = await newRelay();
    const req = request();
    expect((await send(req, { status: 502 })).status).toHaveProperty("sending");
    await upgrade(canisterId);
    await later(RETRY);
    expect((await send(req, { status: 400, body: "refused" })).status).toHaveProperty("sending");
    await later(WINDOW);
    expect((await send(req)).status).toEqual({ unknown: "HTTP 400: refused" });
  });

  it("does not post while a post from before an upgrade may be in flight, then posts with the same key", async () => {
    const canisterId = await newRelay();
    const req = request();
    const postedAt = await now();
    await call((r) => r.keepResult(req.outboxId, { sending: postedAt }));
    await call((r) => r.keepResult(`${req.outboxId}/note`, { sending: postedAt }));
    await upgrade(canisterId);
    expect((await send(req)).status).toEqual({ sending: postedAt });
    await later(IN_FLIGHT);
    const { status, outcalls } = await send(req, { status: 200 });
    expect(status).toEqual({ sent: null });
    expect(header(outcalls[0], "idempotency-key")).toBe(`relay-${req.outboxId}`);
  });

  it("records why a call that found a lost post could not post again", async () => {
    await newRelay();
    const req = request();
    const postedAt = await now();
    await call((r) => r.keepResult(req.outboxId, { sending: postedAt }));
    await call((r) => r.keepResult(`${req.outboxId}/note`, { sending: postedAt }));
    await later(IN_FLIGHT);
    const invalid = { ...req, attachments: [{ filename: "file.txt", base64: "*" }] };
    expect((await send(invalid)).status).toEqual({ sending: postedAt });
    await later(WINDOW);
    expect((await send(req)).status).toEqual({ unknown: "invalid attachment: file.txt" });
  });

  it("upgrades from the v0.1.4 bridge, keeping its results", async () => {
    const canisterId = await newRelay(WASM_V014);
    const sent = request();
    const lost = request();
    const startedAt = await now();
    await call((r) => r.keepResult(sent.outboxId, { sent: null }));
    await call((r) => r.keepResult(lost.outboxId, { sending: startedAt }));
    await upgrade(canisterId);
    expect((await send(sent)).status).toEqual({ sent: null });
    // v0.1.4 kept its attempts in transient memory: one lost in the upgrade may still be in flight
    expect((await send(lost)).status).toEqual({ sending: startedAt });
    await later(IN_FLIGHT);
    // and then may have sent
    expect((await send(lost, { status: 400, body: "refused" })).status).toEqual({ sending: startedAt });
    await later(WINDOW);
    expect((await send(lost)).status).toEqual({ unknown: "HTTP 400: refused" });
  });
});

describe("removing old results", () => {
  const keys = () => call((r) => r.resultKeys());

  it("removes a result a week after it was kept, so its outboxId posts again", async () => {
    await newRelay();
    const req = request();
    expect((await send(req, { status: 200 })).status).toEqual({ sent: null });
    expect(await keys()).toEqual([req.outboxId, `${req.outboxId}/note`]);
    await later(WEEK - MINUTE);
    await send(request(), { status: 200 });
    expect(await keys()).toContain(req.outboxId);
    await later(2 * MINUTE);
    await send(request(), { status: 200 });
    expect(await keys()).not.toContain(req.outboxId);
    expect(await keys()).not.toContain(`${req.outboxId}/note`);
    expect((await send(req, { status: 200 })).outcalls).toHaveLength(1);
  });

  it("notes when it found a result an older bridge kept, and removes it a week later", async () => {
    await newRelay();
    const old = request();
    // v0.1.4 accepted any outboxId, a `/` in it too
    const slashed = "legacy/0";
    await call((r) => r.keepResult(old.outboxId, { unknown: "lost" }));
    await call((r) => r.keepResult(slashed, { sent: null }));
    await send(request(), { status: 200 });
    expect(await keys()).toEqual(expect.arrayContaining([`${old.outboxId}/note`, `${slashed}/note`]));
    await later(WEEK + MINUTE);
    await send(request(), { status: 200 });
    for (const key of [old.outboxId, `${old.outboxId}/note`, slashed, `${slashed}/note`]) {
      expect(await keys()).not.toContain(key);
    }
  });

  it("removes an email abandoned while sending a week later", async () => {
    await newRelay();
    const req = request();
    const startedAt = await now();
    await call((r) => r.keepResult(req.outboxId, { sending: startedAt }));
    await call((r) => r.keepResult(`${req.outboxId}/note`, { rejected: "HTTP 429: slow down" }));
    await later(WEEK + MINUTE);
    await send(request(), { status: 200 });
    expect((await keys()).filter((key) => key.startsWith(req.outboxId))).toEqual([]);
  });

  it("removes a note whose email is gone", async () => {
    await newRelay();
    const at = await now();
    await call((r) => r.keepResult("gone/note", { sending: at }));
    await send(request(), { status: 200 });
    expect(await keys()).not.toContain("gone/note");
  });

  it("looks at 50 entries per call", async () => {
    await newRelay();
    for (let i = 0; i < 60; i++) {
      await call((r) => r.keepResult(`old-${i}`, { sent: null }));
    }
    const unstamped = async () => {
      const all = await keys();
      return all.filter((key) => key.startsWith("old-") && !key.endsWith("/note") && !all.includes(`${key}/note`));
    };
    await send(request(), { status: 200 });
    expect(await unstamped()).toHaveLength(10);
    await send(request(), { status: 200 });
    expect(await unstamped()).toHaveLength(0);
  });
});

describe("JSON strings", () => {
  it.each(["", "plain", 'a"b\\c', "line\nbreak\r\ttab", "\u0000\u0001\u0008\u000b\u000c\u001f\u007f", "é ü 中 😀 \u2028", "</script>"])(
    "writes %j as JSON that reads back the same",
    async (text) => {
      const [json] = await (await checker()).jsonString(text);
      expect(JSON.parse(json)).toBe(text);
    },
  );

  it("escapes as v0.1.4 did", async () => {
    const [json] = await (await checker()).jsonString('a\u0001"\\\n\r\t\u001fé');
    expect(json).toBe('"a\\u0001\\"\\\\\\n\\r\\t\\u001fé"');
  });

  it("costs few instructions on a body near 2 MB", async () => {
    const html = '<p class="x">line</p>\n'.repeat(77_000);
    const [json, instructions] = await (await checker()).jsonString(html);
    expect(JSON.parse(json)).toBe(html);
    console.log(`jsonString on ${html.length} characters: ${instructions} instructions`);
    // Building the text a character at a time, as v0.1.4 did, took 1.62B
    expect(instructions).toBeLessThan(800_000_000n);
  });
});

describe("the outcall fee", () => {
  // bridge/README.md quotes this number
  it("is about 16B cycles for a request near 2 MB, more than the mail client attaches", async () => {
    await newRelay();
    const [fee, configured] = await call((r) => r.postFee(1_990_000n));
    console.log(`outcall fee for a 1,990,000-byte body: ${fee} cycles; the mail client would attach ${configured[0]}`);
    expect(fee).toBeGreaterThan(configured[0] ?? 0n);
    expect(fee).toBeLessThan(20_000_000_000n);
  });
});

describe("the base64 check", () => {
  it.each(["", "YQ==", "YWI=", "YWJj", "+/+/", "aGVsbG8gd29ybGQ="])("accepts %j", async (text) => {
    const [valid] = await (await checker()).base64Check(text);
    expect(valid).toBe(true);
  });

  it("costs few instructions on 1.9 MB", async () => {
    const base64 = randomBytes(1_425_000).toString("base64");
    const [valid, instructions] = await (await checker()).base64Check(base64);
    expect(valid).toBe(true);
    console.log(`base64 check on ${base64.length} characters: ${instructions} instructions`);
    // Walking the characters, as v0.1.4 did, took 0.63B
    expect(instructions).toBeLessThan(400_000_000n);
  });
});

let checkerActor: Actor<Service> | undefined;
async function checker(): Promise<Actor<Service>> {
  checkerActor ??= (await pic.setupCanister<Service>({ idlFactory, wasm: WASM })).actor;
  return checkerActor;
}
