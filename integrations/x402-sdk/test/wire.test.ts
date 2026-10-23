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
import { facilitatorFetchHandler } from "../src/http.ts";
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
