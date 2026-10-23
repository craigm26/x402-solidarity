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
import { facilitatorLogChain } from "../src/logChain.ts";
import { AUTHORIZER, coreBytes, FUND_ADDR, lastShareId, LOG, makeDescriptor, makeWorld, NET, OTHER_FUND, OTHER_FUND_ADDR, PRICE_ATOMIC, resetTime, setSimulatedTime, T0, USDC, useSimulatedTime } from "./harness.ts";
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

/** The descriptor with its exact entry's maxTimeoutSeconds set: the share's window after the purchase's. */
const exactWindow = (seconds: number) => ({ accepts: makeDescriptor("unused").accepts?.map((a) => (a.scheme === "exact" ? { ...a, maxTimeoutSeconds: seconds } : a)) });

test("settlement_pending after a real receipt timeout (180 s): with a 600-second share window the held share is still collected", async () => {
  const w = await makeWorld({ descriptor: exactWindow(600) });
  // The first receipt wait takes toFacilitatorEvmSigner's default 180 s and gives up.
  w.signer.failNextReceipt(1, { advanceSeconds: 180 });
  const r = await w.buy();
  assert.equal(r.status, 200, r.body);
  assert.equal(w.settles[0].errorReason, "settlement_pending");
  assert.equal(r.outcome?.status, "accepted", JSON.stringify(r.outcome));
  const share = w.decisions.find((d) => d.attached);
  const auth = (share?.attached ? share.info.payment?.payload : undefined) as unknown as { authorization: { validBefore: string } };
  assert.equal(Number(auth.authorization.validBefore), T0 / 1000 + 60 + 600, "the purchase's validBefore plus the entry's 600 s");
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), SHARE);
  assert.equal(w.solidarity?.held.size, 0);

  // The same timing with the 60-second minimum: the share has expired by the time the purchase confirms.
  resetAssetContractCache();
  const short = await makeWorld({ descriptor: exactWindow(60) });
  short.signer.failNextReceipt(1, { advanceSeconds: 180 });
  const s = await short.buy();
  assert.equal(s.status, 200, "the purchase itself is fine");
  assert.equal(s.outcome?.status, "skipped");
  assert.equal(s.outcome?.reason, "bad-payment");
  await short.solidarity?.drain();
  assert.equal(short.fundBalance(), 0n);
  assert.equal(short.solidarity?.held.size, 0);
});

test("a held share expires when its window closes: dropped as purchase-not-final, /proofs 404, nothing left held", async () => {
  const w = await makeWorld();
  w.signer.failNextReceipt(2);
  const r = await w.buy();
  assert.equal(r.outcome?.status, "pending");
  const id = r.outcome.id;
  const tx = r.paymentResponse?.transaction as string;
  assert.equal(w.solidarity?.held.size, 1);
  // The share's validBefore is T0 + 120; the log needs 6 seconds to spare.
  setSimulatedTime(T0 + 114_000);
  assert.deepEqual(await w.solidarity?.expireHeld(), [], "still inside its window");
  setSimulatedTime(T0 + 115_000);
  assert.deepEqual(await w.solidarity?.expireHeld(), [{ transaction: tx, id }]);
  assert.equal(w.solidarity?.held.size, 0);
  assert.equal(w.log.handle(`/proofs/${id}`).status, 404, "no longer reported pending");
  assert.equal(await w.solidarity?.resolvePending(tx, true), undefined, "nothing left to resolve");
  assert.equal(w.fundBalance(), 0n);
});

test("a share whose own receipt wait stays settlement_pending is settled again until it confirms, and is in the month's batch (no findExactTransfer)", async () => {
  const waits: number[] = [];
  // As the README wires it: the operator's scheme, no fallback.
  const w = await makeWorld({ logChain: ({ exact }) => facilitatorLogChain(exact, { sleep: async (ms) => void waits.push(ms) }) });
  w.signer.failNextReceipt(4, { to: FUND_ADDR });
  const r = await w.buy();
  assert.equal(r.outcome?.status, "accepted");
  const id = r.outcome.id;
  await w.solidarity?.drain();
  assert.deepEqual(waits, [5000, 10000, 20000, 40000], "four more settles, the wait doubling");
  assert.equal(w.signer.writes.filter((x) => x.to.toLowerCase() === FUND_ADDR).length, 1, "broadcast once; each retry re-waited on it");
  assert.equal(w.fundBalance(), SHARE);
  assert.equal(JSON.parse(w.log.handle(`/proofs/${id}`).body).status, "queued");
  setSimulatedTime(Date.UTC(2026, 10, 2, 0, 0, 0));
  await w.log.closePeriod("2026-10");
  assert.equal(JSON.parse(w.log.handle(`/proofs/${id}`).body).status, "included");
  assert.match(w.log.handle("/settlements/2026-10").body, /exact:0x[0-9a-f]{64}/);
});

test("a share receipt that never comes: queued while it is asked again, until validBefore + pendingGraceSeconds", async () => {
  for (const withFinder of [false, true]) {
    resetAssetContractCache();
    setSimulatedTime(T0);
    const seen: string[] = [];
    let w: World | undefined;
    const sleep = async (ms: number) => {
      const id = w ? lastShareId(w) : undefined;
      if (w && id) seen.push(JSON.parse(w.log.handle(`/proofs/${id}`).body).status);
      setSimulatedTime(Date.now() + ms);
    };
    w = await makeWorld({
      logChain: ({ exact, chain }) => facilitatorLogChain(exact, { pendingGraceSeconds: 120, retryDelayMs: () => 30_000, sleep, ...(withFinder ? { fallback: chain } : {}) }),
    });
    w.signer.failNextReceipt(1000, { to: FUND_ADDR });
    const r = await w.buy();
    assert.equal(r.outcome?.status, "accepted");
    await w.solidarity?.drain();
    // validBefore is T0 + 120, so it gives up after T0 + 240: nine 30-second waits.
    assert.equal(seen.length, 9);
    assert.ok(seen.every((x) => x === "queued"), seen.join());
    assert.equal(w.fundBalance(), SHARE, "the transfer did execute; only its receipt never came");
    const status = JSON.parse(w.log.handle(`/proofs/${r.outcome.id}`).body).status;
    // Past the bound only findExactTransfer (an RPC client reading events) can still find it.
    assert.equal(status, withFinder ? "queued" : "uncollected");
  }
});

test("a channel claim stuck on chain does not hold up the next purchase: its response goes out without an entry, the decision lands later and charges the share, and the channel resyncs on the purchase after", async () => {
  let channel: ClientChannel | undefined;
  const w = await makeWorld({ price: "$0.05", clientOptions: { channelFor: () => channel }, facilitatorOptions: { decisionTimeoutMs: 500 } });
  const config = {
    payer: w.account.address,
    payerAuthorizer: w.account.address,
    receiver: FUND_ADDR as `0x${string}`,
    receiverAuthorizer: AUTHORIZER as `0x${string}`,
    token: USDC,
    withdrawDelay: 86400,
    salt: `0x${"03".padStart(64, "0")}` as `0x${string}`,
  };
  const cid = w.chain.deposit(config, 1_000n);
  channel = openClientChannel(NET, config);
  // A withdrawal is pending, so each accepted share is claimed at once, under the channel's lock.
  w.chain.initiateWithdrawal(cid);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const safety = setTimeout(() => release(), 5000); // never hang, even if the purchase does wait
  const realClaim = w.chain.claim.bind(w.chain);
  (w.chain as { claim: typeof realClaim }).claim = async (...a: Parameters<typeof realClaim>) => {
    await gate;
    return realClaim(...a);
  };

  const first = await w.buy();
  assert.equal(first.outcome?.status, "accepted", JSON.stringify(first.outcome));
  const started = performance.now();
  const second = await w.buy();
  const ms = performance.now() - started;
  assert.equal(second.status, 200, second.body);
  assert.ok(ms < 3000, `the purchase waited ${Math.round(ms)} ms for a claim`);
  assert.equal(second.outcome, undefined, "no entry: the log had not decided in time");
  assert.ok(w.facilitatorErrors.some((e) => e.where === "process"));
  const id2 = lastShareId(w) as string;

  release();
  clearTimeout(safety);
  await w.solidarity?.drain();
  assert.equal(JSON.parse(w.log.handle(`/proofs/${id2}`).body).status, "queued", "decided in the background");
  assert.equal(w.chain.channelState(cid)?.totalClaimed, 100n, "both shares claimed: the late one was charged though the buyer saw no entry");
  assert.equal(w.outcomes[1], undefined, "the buyer's onOutcome got undefined for it");
  assert.equal(channel?.chargedCumulativeAmount, "50", "the client took the missing outcome as not charged");

  // So the buyer's next share on the channel is one voucher behind: skipped once, and the client resyncs from the log's snapshot.
  const third = await w.buy();
  assert.equal(third.status, 200, third.body);
  assert.equal(third.outcome?.status, "skipped");
  assert.equal(third.outcome?.reason, "cumulative-mismatch");
  assert.equal(channel?.chargedCumulativeAmount, "100", "resynced to what the log charged");
  await w.solidarity?.drain();
  const fourth = await w.buy();
  assert.equal(fourth.outcome?.status, "accepted", JSON.stringify(fourth.outcome));
  await w.solidarity?.drain();
  assert.equal(channel?.chargedCumulativeAmount, "150");
  assert.equal(w.chain.channelState(cid)?.totalClaimed, 150n, "the skipped share cost nothing");
});

test("the log checks an exact share with the operator's scheme code: a buyer who cannot cover the share gets bad-payment, not accepted then uncollected", async () => {
  const w = await makeWorld();
  const verified: Array<[unknown, unknown]> = [];
  const realVerify = w.exact.verify.bind(w.exact);
  w.exact.verify = async (p, q, c) => {
    verified.push([p, q]);
    return realVerify(p, q, c);
  };
  const r = await w.buy();
  assert.equal(r.outcome?.status, "accepted");
  const share = w.decisions.find((d) => d.attached);
  const payment = share?.attached ? share.info.payment : undefined;
  assert.ok(payment);
  const forShare = verified.filter(([, q]) => (q as { payTo: string }).payTo.toLowerCase() === FUND_ADDR);
  assert.equal(forShare.length, 1, "the share went through the scheme's verify once");
  assert.deepEqual(forShare[0], [{ x402Version: 2, accepted: payment.accepted, payload: payment.payload }, payment.accepted]);
  await w.solidarity?.drain();

  // A buyer with exactly the purchase price: the scheme's simulation refuses the share.
  resetAssetContractCache();
  const poor = await makeWorld();
  poor.chain.transfer(USDC, poor.account.address, OTHER_FUND_ADDR, poor.balanceOf(poor.account.address) - PRICE_ATOMIC);
  const p = await poor.buy();
  assert.equal(p.status, 200, "the purchase settles");
  assert.equal(p.outcome?.status, "skipped");
  assert.equal(p.outcome?.reason, "bad-payment");
  assert.equal(poor.log.handle(`/proofs/${p.outcome.id}`).status, 404);
});

test("an onFollowUp that throws changes nothing: the share is still accepted and collected", async () => {
  const w = await makeWorld({ facilitatorOptions: { onFollowUp: () => { throw new Error("waitUntil exploded"); } } });
  const r = await w.buy();
  assert.equal(r.status, 200);
  assert.equal(r.outcome?.status, "accepted");
  await w.solidarity?.drain();
  assert.equal(w.fundBalance(), SHARE);
  assert.ok(w.facilitatorErrors.some((e) => e.where === "onFollowUp"));
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
  assert.equal(channel?.chargedCumulativeAmount, "50", "advanced by onPaymentResponse");
  assert.equal(channel.busy, false);
  const second = await w.buy();
  assert.equal(second.outcome?.status, "accepted", JSON.stringify(second.outcome));
  assert.equal(channel?.chargedCumulativeAmount, "100");
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
