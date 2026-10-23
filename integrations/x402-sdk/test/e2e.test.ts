/**
 * End to end, in one process: a buyer's x402Client (through @x402/fetch) pays
 * a seller's x402HTTPResourceServer route, which verifies and settles through
 * an x402Facilitator running @x402/evm's ExactEvmScheme on SimulatedChain.
 * SIMULATED: throwaway keys, a placeholder fund, no network, no money.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ClientExtension } from "@x402/core/client";
import type { PaymentPayload } from "@x402/core/types";
import { resetAssetContractCache } from "@x402/evm";
import { openClientChannel, staticResolver, validateOutcome, verifyReceipt } from "../../../src/solidarity/index.ts";
import type { ClientChannel, LogDescriptor, PublishedStatement } from "../../../src/solidarity/index.ts";
import { AUTHORIZER, coreBytes, FUND_ADDR, lastShareId, LOG, makeWorld, NET, OTHER_FUND, OTHER_FUND_ADDR, PRICE_ATOMIC, resetTime, setSimulatedTime, USDC, useSimulatedTime } from "./harness.ts";
import type { World } from "./harness.ts";

beforeEach(() => {
  useSimulatedTime();
  resetAssetContractCache();
});
afterEach(() => resetTime());

const SHARE = (PRICE_ATOMIC * 1n) / 1000n; // floor(500000 x 0.001) = 500

test("one purchase: settles, the share lands in the log, the buyer reads the outcome, the fund gets exactly the share", async () => {
  const w = await makeWorld();
  const buyerBefore = w.balanceOf(w.account.address);
  const r = await w.buy();

  assert.equal(r.status, 200, r.body);
  assert.equal(r.paymentResponse?.success, true);
  const o = r.outcome;
  assert.ok(o, "PAYMENT-RESPONSE carries extensions.solidarity");
  assert.equal(o.status, "accepted");
  assert.equal(o.period, "2026-10");
  assert.equal(o.amount, SHARE.toString());
  assert.equal(o.log, LOG);
  assert.equal(o.id, lastShareId(w));
  assert.deepEqual(validateOutcome(o), { valid: true });
  // The buyer's header never carries the seller's extensionResponses...
  assert.equal(r.paymentResponse?.extensionResponses, undefined);
  // ...which reached the seller's own afterSettle.
  assert.deepEqual(w.sellerSaw, [{ solidarity: { status: "accepted" } }]);
  // The client saw the same outcome.
  assert.deepEqual(w.outcomes, [o]);

  // The share is submitted after the response; wait for it.
  assert.equal(w.fundBalance(), 0n, "the response did not wait for the share's transfer");
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), SHARE, "the simulated fund received exactly the share");
  assert.equal(w.balanceOf(w.sellerAddress), PRICE_ATOMIC, "the seller was paid in full");
  assert.equal(w.balanceOf(w.account.address), buyerBefore - PRICE_ATOMIC - SHARE);
  assert.equal(w.counter.committed("2026-10"), SHARE);
  const proof = JSON.parse(w.log.handle(`/proofs/${o.id}`).body);
  assert.equal(proof.status, "queued");
  assert.equal(w.signer.writes.length, 2, "the purchase, then the share");
  assert.equal(w.signer.writes[1].to.toLowerCase(), FUND_ADDR);
  assert.deepEqual(w.facilitatorErrors, []);
  assert.deepEqual(w.clientErrors, []);
});

test("a failed purchase settle leaves no share: purchase-not-final on the 402, fund unchanged", async () => {
  const w = await makeWorld();
  w.signer.revertNextWrite("simulated revert");
  const buyerBefore = w.balanceOf(w.account.address);
  const r = await w.buy();

  assert.equal(r.status, 402);
  assert.equal(r.paymentResponse?.success, false);
  assert.equal(r.outcome?.status, "skipped");
  assert.equal(r.outcome?.reason, "purchase-not-final");
  assert.equal(w.outcomes[0]?.reason, "purchase-not-final", "the client's onOutcome saw it");
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), 0n);
  assert.equal(w.balanceOf(w.account.address), buyerBefore);
  assert.equal(w.log.handle(`/proofs/${lastShareId(w)}`).status, 404, "the log never accepted it");
  // The cap counted it at signing, as the spec says; the owner may release it after validBefore.
  assert.equal(w.counter.committed("2026-10"), SHARE);
});

test("settlement_pending, then the seller's one retry confirms: accepted through resolvePending, fund paid once", async () => {
  const w = await makeWorld();
  w.signer.failNextReceipt(1);
  const r = await w.buy();

  assert.equal(r.status, 200, r.body);
  assert.equal(r.outcome?.status, "accepted", JSON.stringify(r.outcome));
  assert.equal(w.settles.length, 2, "the seller's SDK settled twice");
  assert.equal(w.settles[0].errorReason, "settlement_pending");
  assert.equal((w.settles[0].extensions?.solidarity as { info: { status: string } }).info.status, "pending");
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), SHARE);
  assert.equal(w.signer.writes.length, 2, "one purchase broadcast, one share");
  assert.equal(w.solidarity?.held.size, 0);
});

test("settlement_pending twice: pending (not duplicate); a later resolvePending collects it", async () => {
  const w = await makeWorld();
  w.signer.failNextReceipt(2);
  const r = await w.buy();

  assert.equal(r.status, 402);
  assert.equal(r.paymentResponse?.errorReason, "settlement_pending");
  assert.equal(r.outcome?.status, "pending", JSON.stringify(r.outcome));
  const id = r.outcome.id;
  const tx = r.paymentResponse?.transaction as string;
  assert.ok(tx);
  assert.equal(JSON.parse(w.log.handle(`/proofs/${id}`).body).status, "pending");
  assert.equal(w.fundBalance(), 0n);

  // The operator's receipt watcher sees the purchase confirm.
  const resolved = await w.solidarity?.resolvePending(tx, true);
  assert.equal(resolved?.outcome.status, "accepted");
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), SHARE);
  assert.equal(JSON.parse(w.log.handle(`/proofs/${id}`).body).status, "queued");
});

/** A client extension registered after the kit's that rewrites the share, as a relaying seller could. */
function tamper(fn: (info: Record<string, unknown>) => void): ClientExtension {
  return {
    key: "tamper",
    async enrichPaymentPayload(pp: PaymentPayload) {
      const ext = pp.extensions?.solidarity as { info?: Record<string, unknown>; schema?: unknown } | undefined;
      if (!ext?.info?.payment) return pp;
      const info = structuredClone(ext.info);
      fn(info);
      return { ...pp, extensions: { ...pp.extensions, solidarity: { ...ext, info } } };
    },
  };
}

test("a bad share is skipped with the right reason, and the purchase's core fields are byte-identical to plain x402", async () => {
  const buyerKey = generatePrivateKey();
  const sellerAddress = privateKeyToAccount(generatePrivateKey()).address;

  // The same purchase with no extension anywhere.
  const plain = await makeWorld({ buyerKey, sellerAddress, kitFacilitator: false, sellerDeclares: false, sellerExtension: false, buyerKit: false });
  const base = await plain.buy();
  assert.equal(base.status, 200);
  assert.equal(base.paymentResponse?.extensions, undefined);

  const clientDescriptor = (d: LogDescriptor): LogDescriptor => ({ ...d, funds: [...d.funds, OTHER_FUND] });
  const cases: Array<{ name: string; reason: string; opts: Parameters<typeof makeWorld>[0] }> = [
    {
      name: "tampered share signature",
      reason: "bad-payment",
      opts: { extraClientExtensions: [tamper((info) => {
        const p = (info.payment as { payload: { signature: string } }).payload;
        p.signature = `${p.signature.slice(0, -4)}${p.signature.endsWith("00") ? "11" : "00"}${p.signature.slice(-2)}`;
      })] },
    },
    { name: "log rewritten to another URL", reason: "wrong-log", opts: { extraClientExtensions: [tamper((info) => (info.log = "https://other.example/solidarity"))] } },
    // The buyer's cached descriptor still lists a fund the log has since dropped.
    { name: "fund off the log's allow-list", reason: "fund-not-allowed", opts: { policy: { fund: OTHER_FUND }, clientDescriptors: [] } },
  ];

  for (const c of cases) {
    resetAssetContractCache();
    const w: World = await makeWorld({ buyerKey, sellerAddress, ...c.opts });
    if (c.reason === "fund-not-allowed") w.descriptors.set(clientDescriptor(w.descriptor));
    const r = await w.buy();
    assert.equal(r.status, 200, `${c.name}: ${r.body}`);
    assert.equal(r.outcome?.status, "skipped", c.name);
    assert.equal(r.outcome?.reason, c.reason, c.name);
    assert.equal(coreBytes(r.paymentResponse), coreBytes(base.paymentResponse), `${c.name}: core fields differ from plain x402`);
    assert.equal(coreBytes(w.settles.at(-1)), coreBytes(plain.settles.at(-1)), `${c.name}: facilitator core fields differ`);
    await w.solidarity?.drain();
    assert.equal(w.fundBalance(), 0n, c.name);
    assert.equal(w.balanceOf(OTHER_FUND_ADDR), 0n, c.name);
    assert.equal(w.balanceOf(sellerAddress), PRICE_ATOMIC, `${c.name}: seller paid in full`);
  }
});

test("a buyer with no policy, or a seller with no declaration, behaves exactly like plain x402", async () => {
  const buyerKey = generatePrivateKey();
  const sellerAddress = privateKeyToAccount(generatePrivateKey()).address;
  const plain = await makeWorld({ buyerKey, sellerAddress, kitFacilitator: false, sellerDeclares: false, sellerExtension: false, buyerKit: false });
  const base = await plain.buy();

  // The seller declares and the facilitator runs a log, but the buyer holds no policy: its
  // echo carries no `payment`, so there is no share and no solidarity entry.
  resetAssetContractCache();
  const noPolicy = await makeWorld({ buyerKey, sellerAddress, buyerKit: false });
  const a = await noPolicy.buy();
  assert.equal(a.status, 200);
  assert.equal(a.paymentResponse?.extensions?.solidarity, undefined);
  assert.equal(coreBytes(a.paymentResponse), coreBytes(base.paymentResponse));
  assert.deepEqual(noPolicy.sellerSaw, [undefined]);

  // The buyer holds a policy and the facilitator runs a log, but the seller declares nothing.
  resetAssetContractCache();
  const noDecl = await makeWorld({ buyerKey, sellerAddress, sellerDeclares: false });
  const b = await noDecl.buy();
  assert.equal(b.status, 200);
  assert.equal(b.paymentResponse?.extensions, undefined);
  assert.equal(coreBytes(b.paymentResponse), coreBytes(base.paymentResponse));
  assert.deepEqual(noDecl.decisions, [], "the extension did not even consider a share");
  assert.equal(noDecl.counter.committed("2026-10"), 0n);
  assert.equal(noDecl.signer.writes.length, 1);
});

test("a facilitator without the kit ignores a payload that carries extensions.solidarity", async () => {
  const buyerKey = generatePrivateKey();
  const sellerAddress = privateKeyToAccount(generatePrivateKey()).address;
  const plain = await makeWorld({ buyerKey, sellerAddress, kitFacilitator: false, sellerDeclares: false, sellerExtension: false, buyerKit: false });
  const base = await plain.buy();

  resetAssetContractCache();
  const w = await makeWorld({ buyerKey, sellerAddress, kitFacilitator: false });
  assert.ok(!w.facilitator.getSupported().extensions.includes("solidarity"));
  const r = await w.buy();
  assert.ok(lastShareId(w), "the buyer did attach a share");
  assert.equal(r.status, 200);
  assert.equal(r.paymentResponse?.extensions, undefined, "no solidarity entry in the settle response");
  assert.equal(coreBytes(r.paymentResponse), coreBytes(base.paymentResponse));
  assert.deepEqual(w.outcomes, [undefined], "the client saw no outcome");
  assert.equal(w.fundBalance(), 0n, "nothing submitted the share");
  assert.equal(w.signer.writes.length, 1);
});

test("month close: the statement is signed, a receipt verifies, and the served files agree", async () => {
  const w = await makeWorld();
  const r = await w.buy();
  assert.equal(r.outcome?.status, "accepted");
  await w.solidarity?.drain();
  const id = r.outcome.id;

  await assert.rejects(w.log.closePeriod("2026-10"), /before it ends/);
  setSimulatedTime(Date.UTC(2026, 10, 2, 0, 0, 0));
  const statement: PublishedStatement = await w.log.closePeriod("2026-10");
  assert.ok(statement.statement.signature);

  const receipt = w.log.receipt(id);
  assert.ok(receipt, "a receipt for the included share");
  const check = verifyReceipt(receipt, { resolveKey: staticResolver({ [w.logKey.kid]: w.logKey.publicKey }), descriptor: w.descriptor });
  assert.equal(check.ok, true, check.problems.join("; "));

  const served = JSON.parse(w.log.handle("/statements/2026-10").body);
  assert.deepEqual(served, statement);
  const lines = w.log.handle("/lines/2026-10").body;
  assert.ok(lines.endsWith("\n"));
  assert.equal(lines, `${receipt.line}\n`);
  assert.match(w.log.handle("/settlements/2026-10").body, /exact:0x[0-9a-f]{64}/);
  const proof = JSON.parse(w.log.handle(`/proofs/${id}`).body);
  assert.equal(proof.status, "included");
  assert.equal(proof.line, receipt.line);
});

test("batch-settlement shares: two small purchases accepted, the channel advances, month close claims them for the fund", async () => {
  // A price whose share (50) is below the exact minAmount (100): only a channel share fits.
  let channel: ClientChannel | undefined;
  const w = await makeWorld({ price: "$0.05", clientOptions: { channelFor: () => channel } });
  const config = {
    payer: w.account.address,
    payerAuthorizer: w.account.address,
    receiver: FUND_ADDR as `0x${string}`,
    receiverAuthorizer: AUTHORIZER as `0x${string}`,
    token: USDC,
    withdrawDelay: 86400,
    salt: `0x${"01".padStart(64, "0")}` as `0x${string}`,
  };
  const cid = w.chain.deposit(config, 1_000n);
  channel = openClientChannel(NET, config);

  const first = await w.buy();
  assert.equal(first.outcome?.status, "accepted", JSON.stringify(first.outcome));
  assert.equal(first.outcome?.amount, "50");
  assert.equal(channel.chargedCumulativeAmount, "50", "advanced by onPaymentResponse");
  assert.equal(channel.busy, false);
  const second = await w.buy();
  assert.equal(second.outcome?.status, "accepted", JSON.stringify(second.outcome));
  assert.equal(channel.chargedCumulativeAmount, "100");
  assert.equal(second.outcome?.channel?.chargedCumulativeAmount, "100");
  await w.solidarity?.drain();
  assert.equal(w.chain.channelState(cid)?.totalClaimed, 0n, "nothing claimed before the month ends");

  setSimulatedTime(Date.UTC(2026, 10, 2, 0, 0, 0));
  await w.log.closePeriod("2026-10");
  assert.equal(w.chain.channelState(cid)?.totalClaimed, 100n, "the log claimed both shares");
  w.chain.sweep(FUND_ADDR, USDC); // permissionless, moves claimed funds to the receiver
  assert.equal(w.fundBalance(), 100n);
  assert.equal(JSON.parse(w.log.handle(`/proofs/${second.outcome.id}`).body).status, "included");
});

test("the cap stops shares: the last share is cut to what is left, then none is attached", async () => {
  const w = await makeWorld({ policy: { cap: { amount: "600", asset: USDC.toLowerCase() } } });
  const a = await w.buy();
  assert.equal(a.outcome?.amount, "500");
  // 100 left: the share is cut to 100, which still meets the exact minAmount.
  const b = await w.buy();
  assert.equal(b.outcome?.status, "accepted");
  assert.equal(b.outcome?.amount, "100");
  // Cap reached: no share at all, and the purchase goes ahead.
  const c = await w.buy();
  assert.equal(c.status, 200);
  assert.equal(c.outcome, undefined);
  assert.equal(w.counter.committed("2026-10"), 600n);
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), 600n);
});
