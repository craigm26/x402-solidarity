/**
 * Over the HTTP wire format, still in one process: the seller uses the SDK's
 * own HTTPFacilitatorClient, whose requests go to the kit's
 * facilitatorFetchHandler through a swapped globalThis.fetch (the client has
 * no other injection point). Restored after each test.
 * SIMULATED: no sockets, no network, throwaway keys, a placeholder fund.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { resetAssetContractCache } from "@x402/evm";
import { createDescriptorCache } from "../src/descriptors.ts";
import { facilitatorFetchHandler, fetchRequestFromNode, nodeRequestListener } from "../src/http.ts";
import type { NodeRequestLike, NodeResponseLike } from "../src/http.ts";
import { lastShareId, LOG, makeWorld, NET, resetTime, useSimulatedTime } from "./harness.ts";

const FACILITATOR = "https://facilitator.example";
const realFetch = globalThis.fetch;
const realLog = console.log;
let handler: ((req: Request) => Promise<Response>) | undefined;
let seen: Array<{ method: string; path: string; status: number }> = [];
let sdkLogs: string[] = [];

beforeEach(() => {
  useSimulatedTime();
  resetAssetContractCache();
  seen = [];
  sdkLogs = [];
  // HTTPFacilitatorClient logs the EXTENSION-RESPONSES it receives; keep it, quietly.
  console.log = (...a: unknown[]) => void sdkLogs.push(a.map(String).join(" "));
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (!req.url.startsWith(`${FACILITATOR}/`) || !handler) throw new Error(`no network in tests: ${req.url}`);
    const res = await handler(req);
    seen.push({ method: req.method, path: new URL(req.url).pathname, status: res.status });
    return res;
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  handler = undefined;
  resetTime();
});

const overHttp = () =>
  makeWorld({
    facilitatorClient: ({ facilitator, solidarity }) => {
      handler = facilitatorFetchHandler({ facilitator, solidarity });
      return new HTTPFacilitatorClient({ url: FACILITATOR });
    },
  });

test("the outcome survives the SDK's HTTP client: buyer in PAYMENT-RESPONSE, seller from EXTENSION-RESPONSES", async () => {
  const w = await overHttp();
  assert.deepEqual(w.server.getFacilitatorExtensions(2, NET, "exact"), ["solidarity"], "/supported over HTTP");
  const r = await w.buy();
  assert.equal(r.status, 200, r.body);
  assert.equal(r.outcome?.status, "accepted");
  assert.equal(r.outcome?.amount, "500");
  assert.equal(r.paymentResponse?.extensionResponses, undefined);
  assert.deepEqual(w.sellerSaw, [{ solidarity: { status: "accepted" } }]);
  assert.ok(sdkLogs.some((l) => l.includes('"solidarity":{"status":"accepted"}')));
  assert.deepEqual(
    seen.map((s) => `${s.method} ${s.path} ${s.status}`),
    ["GET /supported 200", "POST /verify 200", "POST /settle 200"],
  );
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), 500n);
});

test("a failed settle answers HTTP 200 and keeps its outcome all the way to the buyer", async () => {
  const w = await overHttp();
  w.signer.revertNextWrite();
  const r = await w.buy();
  assert.equal(r.status, 402);
  assert.equal(seen.find((s) => s.path === "/settle")?.status, 200);
  assert.equal(r.paymentResponse?.success, false);
  assert.equal(r.outcome?.status, "skipped");
  assert.equal(r.outcome?.reason, "purchase-not-final");
});

test("a settle that throws (nothing recovered it) is still HTTP 200, a failed SettleResponse, and its share gets purchase-not-final", async () => {
  const w = await overHttp();
  w.exact.settle = async () => {
    throw new Error("scheme threw");
  };
  const r = await w.buy();
  assert.equal(r.status, 402);
  assert.equal(seen.find((s) => s.path === "/settle")?.status, 200);
  assert.equal(r.paymentResponse?.success, false);
  assert.equal(r.paymentResponse?.errorReason, "unexpected_settle_error");
  assert.equal(r.outcome?.status, "skipped");
  assert.equal(r.outcome?.reason, "purchase-not-final");
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), 0n);
});

test("a later after-settle hook throws after the kit accepted the share: the buyer is told accepted (its transfer goes ahead), not purchase-not-final", async () => {
  const w = await overHttp();
  // An operator's hook registered after attachSolidarity, with a bug the README warns about.
  w.facilitator.onAfterSettle(async (ctx) => {
    if ((ctx.paymentPayload.extensions as Record<string, unknown> | undefined)?.solidarity) throw new Error("operator hook bug");
  });
  const sellerBefore = w.balanceOf(w.sellerAddress);
  const r = await w.buy();
  assert.equal(r.status, 402, "the thrown hook fails the settle, as x402Facilitator does");
  assert.equal(seen.find((s) => s.path === "/settle")?.status, 200);
  assert.equal(r.paymentResponse?.success, false);
  assert.equal(r.paymentResponse?.errorReason, "unexpected_settle_error");
  assert.equal(r.outcome?.status, "accepted", JSON.stringify(r.outcome));
  assert.equal(r.outcome?.amount, "500");
  const id = lastShareId(w) as string;
  assert.equal(r.outcome?.id, id);
  await w.solidarity?.drain();
  assert.equal(w.balanceOf(w.sellerAddress) - sellerBefore, 500_000n, "the purchase did settle on chain");
  assert.equal(w.fundBalance(), 500n, "and so did the share, as the buyer was told");
  assert.equal(JSON.parse(w.log.handle(`/proofs/${id}`).body).status, "queued");
  assert.deepEqual(w.facilitatorErrors, []);
});

/** A fake node:http request: no socket. `fail` makes reading its body throw, as a client that hangs up does. */
const node = (url: string | undefined, headers: Record<string, string | string[]> = {}, method = "GET", body?: string, fail?: Error): NodeRequestLike => ({
  method,
  url,
  headers,
  async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.from(body);
    if (fail) throw fail;
  },
});

/** A fake node:http response that records what was written. `endThrows` makes end() throw once headers are sent. */
function fakeResponse(endThrows = false) {
  const out = { status: 0, headers: {} as Record<string, string>, body: "", destroyed: false, headersSent: false };
  const res: NodeResponseLike = {
    get headersSent() {
      return out.headersSent;
    },
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers ?? {};
      out.headersSent = true;
      return res;
    },
    end(body) {
      if (endThrows) throw new Error("socket gone");
      out.body = body ? Buffer.from(body).toString("utf8") : "";
      return res;
    },
    destroy() {
      out.destroyed = true;
      return res;
    },
  };
  return { res, out };
}

test("fetchRequestFromNode never rejects for a request it cannot use: a method fetch refuses, or a body the client stopped sending, is undefined (a 400)", async () => {
  const origin = "https://facilitator.example";
  for (const method of ["TRACE", "TRACK", "CONNECT", "trace"]) {
    assert.equal(await fetchRequestFromNode(node("/supported", {}, method), origin), undefined, method);
  }
  const aborted = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
  assert.equal(await fetchRequestFromNode(node("/settle", { "content-type": "application/json" }, "POST", "abc", aborted), origin), undefined);
  // Other methods still build a Request.
  assert.equal((await fetchRequestFromNode(node("/supported", {}, "PROPFIND"), origin))?.method, "PROPFIND");
  // Only the operator's own origin can throw, and nodeRequestListener checks it at startup.
  await assert.rejects(fetchRequestFromNode(node("/supported"), "not a url"));
  assert.throws(() => nodeRequestListener(async () => new Response(), "not a url"));
});

test("nodeRequestListener (the README's node:http bridge, without a socket): never rejects; 400 for an unusable request, 500 for a handler that throws, and a destroy once headers are out", async () => {
  const origin = "https://facilitator.example";
  const errors: unknown[] = [];
  const echo = async (req: Request) => new Response(JSON.stringify({ path: new URL(req.url).pathname, body: await req.text() }), { status: 201, headers: { "x-seen": "1" } });
  const listen = nodeRequestListener(echo, origin, (e) => errors.push(e));

  let t = fakeResponse();
  await listen(node("/settle", { host: "facilitator.example/verify?" }, "POST", "abc"), t.res);
  assert.equal(t.out.status, 201);
  assert.equal(t.out.headers["x-seen"], "1");
  assert.deepEqual(JSON.parse(t.out.body), { path: "/settle", body: "abc" });

  for (const req of [node("/supported", {}, "TRACE"), node("/settle", {}, "POST", "abc", new Error("aborted")), node("/a/../settle"), node("*")]) {
    t = fakeResponse();
    await listen(req, t.res);
    assert.equal(t.out.status, 400, String(req.method) + " " + String(req.url));
  }
  assert.deepEqual(errors, [], "a refused request is not an error");

  const boom = nodeRequestListener(async () => {
    throw new Error("handler exploded");
  }, origin, (e) => errors.push(e));
  t = fakeResponse();
  await boom(node("/supported"), t.res);
  assert.equal(t.out.status, 500);
  assert.equal((errors[0] as Error).message, "handler exploded");

  // The response started and then failed: nothing more can be said, so the connection is dropped.
  t = fakeResponse(true);
  await listen(node("/supported"), t.res);
  assert.equal(t.out.destroyed, true);

  // A reporter that throws is not a way to reject either.
  const loud = nodeRequestListener(async () => {
    throw new Error("again");
  }, origin, () => {
    throw new Error("the reporter exploded too");
  });
  t = fakeResponse();
  await loud(node("/supported"), t.res);
  assert.equal(t.out.status, 500);

  // The kit's own handler behind it.
  const w = await overHttp();
  const served = nodeRequestListener(facilitatorFetchHandler({ facilitator: w.facilitator, solidarity: w.solidarity }), origin);
  t = fakeResponse();
  await served(node("/supported"), t.res);
  assert.equal(t.out.status, 200);
  assert.ok((JSON.parse(t.out.body) as { extensions: string[] }).extensions.includes("solidarity"));
});

test("fetchRequestFromNode (the README's node:http bridge): the Host header never routes, and only a plain path is accepted", async () => {
  const origin = "https://facilitator.example";
  // A Host chosen to turn a proofs request into /settle, as `https://${host}${url}` would.
  const hostile = await fetchRequestFromNode(node("/solidarity/proofs/x", { host: "facilitator.example/settle?" }), origin);
  assert.equal(new URL(hostile?.url as string).pathname, "/solidarity/proofs/x");
  assert.equal(new URL(hostile?.url as string).host, "facilitator.example");
  // A path that starts with two slashes stays that path.
  assert.equal(new URL((await fetchRequestFromNode(node("//evil.example/settle"), origin))?.url as string).pathname, "//evil.example/settle");
  // Targets the handler would route differently from a proxy reading the raw path: refused (a 400).
  for (const bad of [undefined, "", "*", "settle", "http://facilitator.example/settle", "/solidarity/../settle", "/x/%2e%2e/settle"]) {
    assert.equal(await fetchRequestFromNode(node(bad), origin), undefined, String(bad));
  }
  const post = await fetchRequestFromNode(node("/settle?x=1", { "content-type": "application/json", "x-many": ["a", "b"] }, "POST", '{"a":1}'), origin);
  assert.equal(post?.method, "POST");
  assert.equal(new URL(post?.url as string).search, "?x=1");
  assert.equal(post?.headers.get("x-many"), "a, b");
  assert.equal(await post?.text(), '{"a":1}');
});

test("the log's read endpoints are served under its URL, and the buyer's cache accepts the descriptor", async () => {
  const w = await overHttp();
  const desc = await globalThis.fetch(LOG);
  assert.equal(desc.status, 200);
  assert.deepEqual(await desc.json(), w.descriptor);

  const cache = createDescriptorCache();
  await cache.prefetch([LOG]);
  assert.deepEqual(cache.get(LOG), w.descriptor);

  await w.buy();
  const id = lastShareId(w) as string;
  await w.solidarity?.drain();
  const proof = await globalThis.fetch(`${LOG}/proofs/${id}`);
  assert.equal(proof.status, 200);
  assert.equal(((await proof.json()) as { status: string }).status, "queued");
  assert.equal((await globalThis.fetch(`${LOG}/proofs/${"A".repeat(22)}`)).status, 404);
  assert.equal((await globalThis.fetch(`${LOG}/statements/2026-10`)).status, 404, "no statement before the month closes");
  assert.equal((await globalThis.fetch(`${FACILITATOR}/nothing-here`)).status, 404);
  const bad = await globalThis.fetch(`${FACILITATOR}/settle`, { method: "POST", body: "not json" });
  assert.equal(bad.status, 400);
});
