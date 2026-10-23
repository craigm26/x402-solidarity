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
import type { SolidarityInfo } from "../../../src/solidarity/index.ts";
import { solidarityFacilitator } from "../src/facilitator.ts";
import { facilitatorLogChain } from "../src/logChain.ts";
import { makeWorld, NET, resetTime, setSimulatedTime, useSimulatedTime } from "./harness.ts";
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

test("canary for the pinned SDK: after-settle hooks run on failed results too (a failed transfer, settlement_pending), although its typings say successful", async () => {
  // The kit's pending holds and its purchase-not-final outcomes depend on this.
  const w = await makeWorld();
  const seen: Array<[boolean, string | undefined]> = [];
  w.facilitator.onAfterSettle(async (ctx) => void seen.push([ctx.result.success, ctx.result.errorReason]));
  w.signer.revertNextWrite();
  const a = await signedPurchase(w);
  const failed = await w.facilitator.settle(a.payload, a.requirements);
  assert.equal(failed.success, false);
  w.signer.failNextReceipt(1);
  const b = await signedPurchase(w);
  const pending = await w.facilitator.settle(b.payload, b.requirements);
  assert.equal(pending.errorReason, "settlement_pending");
  assert.deepEqual(seen, [[false, failed.errorReason], [false, "settlement_pending"]], "if a future @x402/core runs these hooks on success only, pending shares are never held");
  assert.equal(readOutcome(failed as { extensions?: Record<string, unknown> })?.reason, "purchase-not-final");
  assert.equal(readOutcome(pending as { extensions?: Record<string, unknown> })?.status, "pending");
});

test("a settle recovered in onSettleFailure runs no after-settle hook (canary); the operator runs solidarity.afterSettle on the recovered result", async () => {
  const w = await makeWorld();
  const realSettle = w.exact.settle.bind(w.exact);
  let settled: SettleResponse | undefined;
  w.exact.settle = async (p, q, c) => {
    const r = await realSettle(p, q, c);
    // The purchase is broadcast and confirmed, then the RPC errors. (The share's own settle carries no extensions.)
    if ((p.extensions as Record<string, unknown> | undefined)?.solidarity) {
      settled = r;
      throw new Error("rpc error after broadcast");
    }
    return r;
  };
  const hooksSaw: unknown[] = [];
  w.facilitator.onAfterSettle(async (ctx) => void hooksSaw.push(ctx.result));
  w.facilitator.onSettleFailure(async (ctx) => {
    if (!settled?.success) return undefined;
    await w.solidarity?.afterSettle({ ...ctx, result: settled }); // as the README says
    return { recovered: true, result: settled };
  });
  const { payload, requirements, id } = await signedPurchase(w);
  const r = await w.facilitator.settle(payload, requirements);
  assert.equal(r.success, true);
  assert.deepEqual(hooksSaw, [], "if a future @x402/core runs after-settle hooks on recovered results, the afterSettle call in the recovery hook becomes redundant (it repeats the outcome)");
  assert.equal(readOutcome(r as { extensions?: Record<string, unknown> })?.status, "accepted");
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), 500n);
  assert.equal(JSON.parse(w.log.handle(`/proofs/${id}`).body).status, "queued");
});

test("a later after-settle hook throws after the kit accepted the share, and the operator recovers as the README says: the buyer is told accepted, not duplicate (canary: every hook of one settle sees the same payload object)", async () => {
  const w = await makeWorld();
  let schemeResult: SettleResponse | undefined;
  const hooksSawPayload: unknown[] = [];
  w.facilitator.onBeforeSettle(async (ctx) => void hooksSawPayload.push(ctx.paymentPayload));
  // An operator's hook registered after attachSolidarity, with a bug.
  w.facilitator.onAfterSettle(async (ctx) => {
    hooksSawPayload.push(ctx.paymentPayload);
    if ((ctx.paymentPayload.extensions as Record<string, unknown> | undefined)?.solidarity) {
      schemeResult = { ...ctx.result, extensions: undefined, extensionResponses: undefined };
      throw new Error("operator hook bug");
    }
  });
  let failureSawPayload: unknown;
  w.facilitator.onSettleFailure(async (ctx) => {
    if (!schemeResult?.success) return undefined;
    failureSawPayload = ctx.paymentPayload;
    const recovered = { ...schemeResult };
    await w.solidarity?.afterSettle({ ...ctx, result: recovered }); // as the README says
    return { recovered: true, result: recovered };
  });
  const { payload, requirements, id } = await signedPurchase(w);
  const r = await w.facilitator.settle(payload, requirements);
  hooksSawPayload.push(failureSawPayload);
  assert.equal(hooksSawPayload.length, 3);
  for (const p of hooksSawPayload) assert.equal(p, payload, "if a future @x402/core hands its hooks copies, the kit can no longer tell one settle from the next");
  assert.equal(r.success, true);
  const o = readOutcome(r as { extensions?: Record<string, unknown> });
  assert.equal(o?.status, "accepted", JSON.stringify(o));
  assert.equal(o?.id, id);
  assert.deepEqual(r.extensionResponses, { solidarity: { status: "accepted" } });
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), 500n);
  assert.equal(w.signer.writes.length, 2, "one purchase, one share: nothing decided or sent twice");
  assert.equal(JSON.parse(w.log.handle(`/proofs/${id}`).body).status, "queued");
  assert.deepEqual(w.facilitatorErrors, []);
});

test("a recovered final result after a pending one is decided again, not answered with the recorded pending", async () => {
  const w = await makeWorld();
  w.signer.failNextReceipt(1); // the purchase's receipt wait gives settlement_pending
  let pendingResult: SettleResponse | undefined;
  // An operator's hook registered after attachSolidarity, with a bug that fires on the pending result.
  w.facilitator.onAfterSettle(async (ctx) => {
    if ((ctx.paymentPayload.extensions as Record<string, unknown> | undefined)?.solidarity && ctx.result.errorReason === "settlement_pending") {
      pendingResult = { ...ctx.result, extensions: undefined, extensionResponses: undefined };
      throw new Error("operator hook bug");
    }
  });
  w.facilitator.onSettleFailure(async (ctx) => {
    if (!pendingResult) return undefined;
    // The operator's receipt watcher learns the purchase confirmed and recovers with the final result.
    const recovered: SettleResponse = { ...pendingResult, success: true, errorReason: undefined };
    await w.solidarity?.afterSettle({ ...ctx, result: recovered });
    return { recovered: true, result: recovered };
  });
  const { payload, requirements, id } = await signedPurchase(w);
  const r = await w.facilitator.settle(payload, requirements);
  assert.ok(pendingResult, "the purchase went pending first");
  assert.equal(r.success, true);
  const o = readOutcome(r as { extensions?: Record<string, unknown> });
  assert.equal(o?.status, "accepted", JSON.stringify(o));
  assert.equal(o?.id, id);
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), 500n, "the held share was released and paid once");
  assert.equal(w.solidarity?.held.size, 0);
});

test("a new settle() call with the same payload object gets a new decision: the seller's retry of a settlement_pending purchase, with x402Facilitator in process", async () => {
  const payloads: unknown[] = [];
  const w = await makeWorld({
    // No JSON round trip: the seller's SDK retries with the identical payload object.
    facilitatorClient: ({ facilitator }) => ({
      verify: (p, q) => facilitator.verify(p, q),
      settle: (p, q) => {
        payloads.push(p);
        return facilitator.settle(p, q);
      },
      getSupported: async () => facilitator.getSupported(),
    }),
  });
  w.signer.failNextReceipt(1);
  const r = await w.buy();
  assert.equal(payloads.length, 2, "the seller's SDK settled twice");
  assert.equal(payloads[0], payloads[1], "with the same object both times");
  assert.equal(r.status, 200, r.body);
  assert.equal(r.outcome?.status, "accepted", JSON.stringify(r.outcome));
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), 500n);
  assert.equal(w.solidarity?.held.size, 0);
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

  // The same with an onError that throws as well.
  const w2 = await makeWorld({ facilitatorOptions: { onError: () => { throw new Error("the reporter exploded too"); } } });
  w2.facilitator.onSettleFailure(async (ctx) => void failures.push(ctx.error));
  w2.log.onSettled = async () => {
    throw new Error("log exploded");
  };
  const second = await signedPurchase(w2);
  const r2 = await w2.facilitator.settle(second.payload, second.requirements);
  assert.equal(r2.success, true);
  assert.equal(r2.extensions?.solidarity, undefined);
  assert.deepEqual(failures, []);
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

test("a share whose transfer cannot be submitted: purchase settled, share accepted and queued; uncollected only once the chain shows it unused after validBefore", async () => {
  for (const readsState of [false, true]) {
    const w = await makeWorld();
    // Swap the log for one whose share settler always throws; with readsState, the chain's
    // authorizationState comes through `fallback`.
    const log = new SolidarityLog({
      descriptor: w.descriptor,
      key: w.logKey,
      chain: facilitatorLogChain(
        {
          settle: async () => {
            throw new Error("rpc down");
          },
        },
        readsState ? { fallback: { authorizationUsed: (a, p) => w.chain.authorizationUsed(a, p) } } : {},
      ),
    });
    const ext = solidarityFacilitator({ log });
    const { payload, requirements, id } = await signedPurchase(w);
    const settled = await w.exact.settle(payload, requirements);
    const r = await ext.process(payload, requirements, settled);
    assert.equal(r.response.success, true);
    assert.equal(r.outcome?.status, "accepted");
    await ext.drain();
    assert.equal(JSON.parse(log.handle(`/proofs/${id}`).body).status, "queued", "a failed submit does not show that the transfer never executed");
    const validBefore = Number(((payload.extensions?.solidarity as { info: SolidarityInfo }).info.payment?.payload as { authorization: { validBefore: string } }).authorization.validBefore);
    setSimulatedTime((validBefore + 30) * 1000);
    await log.reconcileExact();
    assert.equal(JSON.parse(log.handle(`/proofs/${id}`).body).status, readsState ? "uncollected" : "queued");
    assert.equal(w.fundBalance(), 0n);
  }
});

test("process() leaves its inputs alone and returns a new object: the operator's own wrapper gets the outcome and the seller's status without the hook", async () => {
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
  assert.deepEqual(r.response.extensionResponses, { solidarity: { status: "accepted" } }, "for the seller, through EXTENSION-RESPONSES");
  await ext.drain();
  assert.equal(w.fundBalance(), 500n);
  // Not pure: it recorded the share, so a second call for the same settle is a duplicate.
  const again = await ext.process(payload, requirements, settled);
  assert.equal(again.outcome?.reason, "duplicate");
  // No share: still a new object, equal to the input.
  const plain = { success: true, transaction: "0x01", network: NET } as SettleResponse;
  const none = await ext.process({ ...payload, extensions: {} }, requirements, plain);
  assert.notEqual(none.response, plain);
  assert.deepEqual(none.response, plain);
  assert.equal(none.outcome, undefined);
});

test("a share settle that fails with a transaction (a reverted transfer) is uncollected once the chain shows it unused after validBefore, and the month's files leave it out", async () => {
  const w = await makeWorld();
  const log = new SolidarityLog({
    descriptor: w.descriptor,
    key: w.logKey,
    chain: facilitatorLogChain(
      { settle: async () => ({ success: false, errorReason: "transaction_failed", transaction: `0x${"ab".repeat(32)}`, network: NET }) },
      { fallback: { authorizationUsed: (a, p) => w.chain.authorizationUsed(a, p) } },
    ),
  });
  const ext = solidarityFacilitator({ log });
  const { payload, requirements, id } = await signedPurchase(w);
  const settled = await w.exact.settle(payload, requirements);
  const r = await ext.process(payload, requirements, settled);
  assert.equal(r.outcome?.status, "accepted");
  await ext.drain();
  assert.equal(JSON.parse(log.handle(`/proofs/${id}`).body).status, "queued", "not before its validBefore has passed");
  // Closing the month looks again: validBefore has passed and the authorization is unused.
  setSimulatedTime(Date.UTC(2026, 10, 2, 0, 0, 0));
  await log.closePeriod("2026-10");
  assert.equal(JSON.parse(log.handle(`/proofs/${id}`).body).status, "uncollected");
  assert.equal(log.handle("/lines/2026-10").body, "");
  assert.equal(log.handle("/settlements/2026-10").body, "");
});

test("blockTime comes through `fallback`, so block time, not the log's clock, decides that a share's validBefore has passed", async () => {
  const settle = async (): Promise<SettleResponse> => {
    throw new Error("unused");
  };
  const fb = {
    at: 1793000000,
    async blockTime() {
      return this.at;
    },
  };
  assert.equal(await facilitatorLogChain({ settle }, { fallback: fb }).blockTime?.(), 1793000000, "called on the fallback");
  assert.equal(facilitatorLogChain({ settle }).blockTime, undefined, "without it the log falls back to its clock and margin");
});
