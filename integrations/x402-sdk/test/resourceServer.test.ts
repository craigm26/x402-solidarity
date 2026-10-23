/**
 * The seller's extension inside a real x402ResourceServer.
 * SIMULATED: throwaway keys, a placeholder fund, nothing sent.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { resetAssetContractCache } from "@x402/evm";
import { conventionalLogUrl, declareSolidarityExtension, solidaritySchema } from "../../../src/solidarity/index.ts";
import { solidarityServerExtension } from "../src/resourceServer.ts";
import { LOG, makeWorld, NET, resetTime, USDC, useSimulatedTime } from "./harness.ts";

beforeEach(() => {
  useSimulatedTime();
  resetAssetContractCache();
});
afterEach(() => resetTime());

const unusedClient: FacilitatorClient = {
  verify: async () => {
    throw new Error("not used");
  },
  settle: async () => {
    throw new Error("not used");
  },
  getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
};
const accepted = { scheme: "exact", network: NET, amount: "500000", asset: USDC, payTo: "0x2222222222222222222222222222222222222222", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };

test("the extension offers the slot only: no settle enrichment, no hooks", () => {
  const ext = solidarityServerExtension();
  assert.equal(ext.key, "solidarity");
  assert.deepEqual(ext.dynamicInfoFields, ["logs"]);
  assert.equal(ext.enrichSettlementResponse, undefined, "it would overwrite the log's outcome");
  assert.equal(ext.hooks, undefined);
  assert.equal(ext.enrichPaymentRequiredResponse, undefined, "static unless logFor is given");
  assert.equal(typeof solidarityServerExtension({ logFor: () => LOG }).enrichPaymentRequiredResponse, "function");
});

test("echo validation: a change to logs between the 402 and the payment does not refuse the purchase; version is still checked", () => {
  const advertised = { x402Version: 2, resource: { url: "https://books.example/report" }, accepts: [accepted], extensions: { solidarity: declareSolidarityExtension([{ network: NET, scheme: "exact", log: LOG }]) } } as unknown as PaymentRequired;
  const echo = (info: Record<string, unknown>) => ({ x402Version: 2, accepted, payload: {}, extensions: { solidarity: { info, schema: solidaritySchema } } }) as unknown as PaymentPayload;
  const moved = echo({ version: 2, logs: [{ network: NET, scheme: "exact", log: "https://moved.example/solidarity" }], log: "https://moved.example/solidarity" });

  const withKit = new x402ResourceServer(unusedClient);
  withKit.registerExtension(solidarityServerExtension());
  assert.deepEqual(withKit.validateExtensions(advertised, moved), { valid: true });

  // Without the kit's dynamicInfoFields the same echo is refused.
  const strict = new x402ResourceServer(unusedClient);
  assert.equal((strict.validateExtensions(advertised, moved) as { invalidReason?: string }).invalidReason, "extension_echo_mismatch");

  assert.equal((withKit.validateExtensions(advertised, echo({ version: 3, logs: [] })) as { invalidReason?: string }).invalidReason, "extension_echo_mismatch");
});

test("logFor with a server: logs only for (network, scheme) pairs whose facilitator lists solidarity", async () => {
  const ext = solidarityServerExtension({
    logFor: () => LOG,
    server: { getFacilitatorExtensions: (_v, network, scheme) => (network === NET && scheme === "exact" ? ["solidarity"] : []) },
  });
  const ctx = {
    requirements: [accepted, { ...accepted, network: "eip155:8453" }, { ...accepted, scheme: "upto" }, { ...accepted }],
    resourceInfo: { url: "https://books.example/report" },
    paymentRequiredResponse: {} as PaymentRequired,
  };
  const out = (await ext.enrichPaymentRequiredResponse?.(declareSolidarityExtension([]), ctx as never)) as { info: { logs: unknown[] } };
  assert.deepEqual(out.info, { version: 2, logs: [{ network: NET, scheme: "exact", log: LOG }] });

  const none = solidarityServerExtension({ logFor: () => LOG, server: { getFacilitatorExtensions: () => [] } });
  const empty = (await none.enrichPaymentRequiredResponse?.(declareSolidarityExtension([]), ctx as never)) as { info: unknown };
  assert.deepEqual(empty.info, { version: 2, logs: [] });

  const notHttps = solidarityServerExtension({ logFor: () => "http://insecure.example/solidarity" });
  assert.deepEqual(((await notHttps.enrichPaymentRequiredResponse?.(declareSolidarityExtension([]), ctx as never)) as { info: unknown }).info, { version: 2, logs: [] });
});

/** The 402's declared logs, read from the PAYMENT-REQUIRED header the buyer gets. */
async function declaredLogs(app: (r: Request) => Promise<Response>): Promise<unknown> {
  const res = await app(new Request("https://books.example/report"));
  assert.equal(res.status, 402);
  const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") as string);
  return (pr.extensions?.solidarity as { info: { logs: unknown } }).info.logs;
}

test("dynamic logs through /supported, end to end: filled when the facilitator runs a log, empty when it does not", async () => {
  const facilitatorUrl = "https://facilitator.example";
  const lazy: { server?: x402ResourceServer } = {};
  const sellerExtension = {
    logFor: () => conventionalLogUrl(facilitatorUrl),
    server: { getFacilitatorExtensions: (v: number, n: string, s: string) => (lazy.server as x402ResourceServer).getFacilitatorExtensions(v, n as `${string}:${string}`, s) },
  };
  const routeExtensions = { solidarity: declareSolidarityExtension([]) };

  const w = await makeWorld({ sellerExtension, routeExtensions });
  lazy.server = w.server;
  assert.deepEqual(await declaredLogs(w.app), [{ network: NET, scheme: "exact", log: LOG }]);
  const r = await w.buy();
  assert.equal(r.status, 200, r.body);
  assert.equal(r.outcome?.status, "accepted");
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), 500n);

  resetAssetContractCache();
  const without = await makeWorld({ sellerExtension, routeExtensions, kitFacilitator: false });
  lazy.server = without.server;
  assert.deepEqual(await declaredLogs(without.app), []);
  const r2 = await without.buy();
  assert.equal(r2.status, 200);
  assert.equal(r2.paymentResponse?.extensions, undefined);
  assert.equal(without.decisions[0]?.attached, false, "no log declared for this network and scheme");
});
