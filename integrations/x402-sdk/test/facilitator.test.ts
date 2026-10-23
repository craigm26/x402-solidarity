/**
 * The facilitator side on a real x402Facilitator with @x402/evm's ExactEvmScheme
 * over SimulatedChain. SIMULATED: throwaway keys, a placeholder fund, nothing sent.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { snapshotSettleResponseCore } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { resetAssetContractCache } from "@x402/evm";
import { readOutcome, SolidarityLog } from "../../../src/solidarity/index.ts";
import { solidarityFacilitator } from "../src/facilitator.ts";
import { facilitatorLogChain } from "../src/logChain.ts";
import { makeWorld, NET, resetTime, useSimulatedTime } from "./harness.ts";
import type { World } from "./harness.ts";

beforeEach(() => {
  useSimulatedTime();
  resetAssetContractCache();
});
afterEach(() => resetTime());

/** A real PaymentRequired from the seller's 402, paid by the buyer's x402Client (with the kit). */
async function signedPurchase(w: World): Promise<{ payload: PaymentPayload; requirements: PaymentRequirements; id?: string }> {
  const res = await w.app(new Request("https://books.example/report"));
  const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") as string);
  const payload = await w.client.createPaymentPayload(pr);
  const id = (payload.extensions?.solidarity as { info?: { id?: string } } | undefined)?.info?.id;
  return { payload, requirements: payload.accepted, id };
}

const withoutSolidarity = (p: PaymentPayload): PaymentPayload => {
  const { solidarity: _drop, ...rest } = (p.extensions ?? {}) as Record<string, unknown>;
  return { ...p, extensions: rest };
};

test("/supported lists solidarity, and the seller sees it after initialize()", async () => {
  const w = await makeWorld();
  assert.ok(w.facilitator.getSupported().extensions.includes("solidarity"));
  assert.deepEqual(w.server.getFacilitatorExtensions(2, NET, "exact"), ["solidarity"]);
  const plain = await makeWorld({ kitFacilitator: false });
  assert.deepEqual(plain.server.getFacilitatorExtensions(2, NET, "exact"), []);
});

test("/verify is unchanged by a share: same VerifyResponse, no chain writes, nothing recorded", async () => {
  const w = await makeWorld();
  const { payload, requirements, id } = await signedPurchase(w);
  assert.ok(id, "the payload carries a share");
  const withShare = await w.facilitator.verify(payload, requirements);
  const without = await w.facilitator.verify(withoutSolidarity(payload), requirements);
  assert.equal(withShare.isValid, true);
  assert.deepEqual(withShare, without);
  assert.equal(w.signer.writes.length, 0);
  assert.ok(!w.signer.calls.some((c) => c.startsWith("writeContract")), "verify wrote nothing");
  assert.equal(w.log.handle(`/proofs/${id}`).status, 404);
});

test("canary for the pinned SDK: settle() returns the very object its after-settle hooks received", async () => {
  const w = await makeWorld();
  const { payload, requirements } = await signedPurchase(w);
  let seen: SettleResponse | undefined;
  w.facilitator.onAfterSettle(async (ctx) => {
    seen = ctx.result;
  });
  const r = await w.facilitator.settle(payload, requirements);
  assert.equal(r, seen, "if a future @x402/core passes a copy, the kit's afterSettle can no longer add the outcome");
  assert.equal(readOutcome(r as { extensions?: Record<string, unknown> })?.status, "accepted");
});

test("if the log throws, the purchase still settles, with no solidarity entry, and nothing reaches onSettleFailure", async () => {
  const w = await makeWorld();
  const failures: unknown[] = [];
  w.facilitator.onSettleFailure(async (ctx) => {
    failures.push(ctx.error);
  });
  w.log.onSettled = async () => {
    throw new Error("log exploded");
  };
  const { payload, requirements } = await signedPurchase(w);
  const r = await w.facilitator.settle(payload, requirements);
  assert.equal(r.success, true);
  assert.equal(r.extensions?.solidarity, undefined);
  assert.equal(r.extensionResponses, undefined);
  assert.deepEqual(failures, []);
  assert.equal(w.facilitatorErrors.length, 1);
  assert.equal(w.facilitatorErrors[0].where, "afterSettle");
});

test("if the log changes a core field, the hook puts it back and drops the entry", async () => {
  const w = await makeWorld();
  const original = w.log.onSettled.bind(w.log);
  w.log.onSettled = async (p, q, r) => {
    const out = await original(p, q, r);
    (r as { success: boolean }).success = false; // a misbehaving log
    (r as { payer?: string }).payer = "0x0000000000000000000000000000000000000bad";
    return out;
  };
  const { payload, requirements } = await signedPurchase(w);
  const r = await w.facilitator.settle(payload, requirements);
  assert.equal(r.success, true);
  assert.equal(r.payer, w.account.address);
  assert.equal(r.extensions?.solidarity, undefined);
  assert.match(String((w.facilitatorErrors[0]?.error as Error)?.message), /core SettleResponse field changed/);

  // The same when the log reports no outcome at all.
  const w2 = await makeWorld();
  w2.log.onSettled = async (_p, _q, r) => {
    (r as { transaction: string }).transaction = "0xrewritten";
    return { settleResponse: r, followUp: Promise.resolve() };
  };
  const second = await signedPurchase(w2);
  const r2 = await w2.facilitator.settle(second.payload, second.requirements);
  assert.equal(r2.success, true);
  assert.match(r2.transaction, /^0x[0-9a-f]{64}$/);
  assert.equal(r2.extensions?.solidarity, undefined);
  assert.equal(w2.facilitatorErrors.length, 1);
});

test("a share whose transfer cannot be submitted: purchase settled, share accepted then uncollected", async () => {
  const w = await makeWorld();
  // Swap the log for one whose share settler always throws.
  const log = new SolidarityLog({
    descriptor: w.descriptor,
    key: w.logKey,
    chain: facilitatorLogChain({
      settle: async () => {
        throw new Error("rpc down");
      },
    }),
  });
  const ext = solidarityFacilitator({ log });
  const { payload, requirements, id } = await signedPurchase(w);
  const settled = await w.exact.settle(payload, requirements);
  const r = await ext.process(payload, requirements, settled);
  assert.equal(r.response.success, true);
  assert.equal(r.outcome?.status, "accepted");
  await ext.drain();
  assert.equal(JSON.parse(log.handle(`/proofs/${id}`).body).status, "uncollected");
  assert.equal(w.fundBalance(), 0n);
});

test("process() is pure: the operator's own wrapper gets the same outcome without the hook", async () => {
  const w = await makeWorld({ kitFacilitator: false });
  const ext = solidarityFacilitator({ log: w.log });
  w.facilitator.registerExtension(ext);
  assert.ok(w.facilitator.getSupported().extensions.includes("solidarity"));
  const { payload, requirements } = await signedPurchase(w);
  const settled = await w.facilitator.settle(payload, requirements);
  const before = JSON.stringify(settled);
  const r = await ext.process(payload, requirements, settled);
  assert.equal(JSON.stringify(settled), before, "the input is not changed");
  assert.notEqual(r.response, settled);
  assert.deepEqual(snapshotSettleResponseCore(r.response), snapshotSettleResponseCore(settled));
  assert.equal(readOutcome(r.response as { extensions?: Record<string, unknown> })?.status, "accepted");
  await ext.drain();
  assert.equal(w.fundBalance(), 500n);
});
