import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SimulatedChain } from "../src/sim/chain.ts";
import * as S from "../src/solidarity/index.ts";
import type { LogDescriptor, OwnerPolicy, PaymentPayload, PaymentRequirements, SettleResponse, SolidarityInfo } from "../src/solidarity/index.ts";
import { conformance } from "./helpers.ts";

const P = conformance("payloads.json");
const DESCRIPTOR: LogDescriptor = P.descriptor;
const POLICY: OwnerPolicy = P.policy;
const USDC = S.USDC_BASE_SEPOLIA.address;
const NET = "eip155:84532";
const LOG = DESCRIPTOR.log;
const FUND_ADDR = "0x000000000000000000000000000000000000f00d";
const CORE = ["success", "errorReason", "payer", "transaction", "network", "amount"] as const;

test("conformance: every facilitator case gives the expected outcome, in order, with core fields untouched", async () => {
  const chain = new SimulatedChain({ now: P.now });
  chain.mint(USDC, P.payer.address, 1_000_000_000n);
  assert.equal(chain.deposit(P.channel.config, BigInt(P.channel.deposit)), P.channel.id);
  const log = new S.SolidarityLog({ descriptor: DESCRIPTOR, key: S.generateSigningKey("EdDSA", DESCRIPTOR.keys[0].kid), chain, clock: () => P.now });
  for (const c of P.cases) {
    const r = await log.onSettled(c.paymentPayload, c.requirements, c.settleResponse);
    assert.deepEqual(r.outcome ?? null, c.expected, c.name);
    for (const k of CORE) assert.deepEqual(r.settleResponse[k], c.settleResponse[k], `${c.name}: ${k} changed`);
    if (r.outcome) {
      assert.deepEqual(S.validateOutcome(r.outcome), { valid: true }, c.name);
      assert.deepEqual((r.settleResponse.extensions?.solidarity as { schema: unknown }).schema, S.solidarityOutcomeSchema);
      assert.deepEqual(S.decodeExtensionResponses(r.extensionResponses as string), { solidarity: { status: r.outcome.status } });
    } else {
      assert.equal(r.settleResponse, c.settleResponse, "no share, the response is passed through");
    }
    if (c.resolve) {
      const res = await log.resolvePending(c.resolve.transaction, c.resolve.confirmed);
      assert.deepEqual(res?.outcome, c.resolve.expected, `${c.name} resolved`);
    }
    await r.followUp;
  }
  const reasons = new Set(P.cases.map((c: { expected: { reason?: string } | null }) => c.expected?.reason).filter(Boolean));
  for (const r of S.SKIP_REASONS) assert.ok(reasons.has(r), `conformance covers ${r}`);
});

// ---- a small world for scenario tests ------------------------------------------

async function world(opts: { now?: number } = {}) {
  const now = opts.now ?? Date.UTC(2026, 11, 10, 12) / 1000;
  const chain = new SimulatedChain({ now });
  const agent = privateKeyToAccount(generatePrivateKey());
  chain.mint(USDC, agent.address, 1_000_000_000n);
  const key = S.generateSigningKey("EdDSA", DESCRIPTOR.keys[0].kid);
  const log = new S.SolidarityLog({ descriptor: DESCRIPTOR, key, chain, clock: () => chain.now });
  const counter = new S.CapCounter({ ...POLICY, cap: { ...POLICY.cap, amount: "1000000000" } });
  const ctx = { policy: POLICY, counter, signer: agent, descriptor: DESCRIPTOR, now };
  const config = { payer: agent.address, payerAuthorizer: agent.address, receiver: FUND_ADDR as `0x${string}`, receiverAuthorizer: "0x3333333333333333333333333333333333333333" as const, token: USDC as `0x${string}`, withdrawDelay: 86400, salt: `0x${"0".repeat(63)}9` as `0x${string}` };
  const req = (amount: string, scheme = "exact"): PaymentRequirements => ({ scheme, network: NET, amount, asset: USDC, payTo: "0x2222222222222222222222222222222222222222", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } });
  const declared = (scheme = "exact"): SolidarityInfo => ({ version: 2, logs: [{ network: NET, scheme, log: LOG }] });
  const payload = (accepted: PaymentRequirements, info: SolidarityInfo, extra: Record<string, unknown> = {}): PaymentPayload => ({ x402Version: 2, accepted, payload: { ...extra }, extensions: { solidarity: { info, schema: S.solidaritySchema } } });
  const ok = (extra: Partial<SettleResponse> = {}): SettleResponse => ({ success: true, transaction: "0xpurchase", network: NET, payer: agent.address, ...extra });
  async function share(accepted: PaymentRequirements, o: Partial<S.BuildShareInput> = {}) {
    ctx.now = chain.now;
    const d = await S.buildShare(ctx, { declared: declared(accepted.scheme), accepted, purchaseWindow: { validAfter: String(chain.now - 60), validBefore: String(chain.now + 60) }, ...o });
    assert.ok(d.attached, d.attached ? "" : d.why);
    return (d as Extract<S.ShareDecision, { attached: true }>).info;
  }
  return { chain, agent, log, key, ctx, config, req, declared, payload, ok, share };
}

test("/verify is untouched: same object back, nothing reserved", async () => {
  const w = await world();
  const info = await w.share(w.req("48000000"));
  const pp = w.payload(w.req("48000000"), info);
  const vr = { isValid: true, payer: w.agent.address };
  assert.equal(w.log.onVerify(pp, vr), vr);
  assert.deepEqual(vr, { isValid: true, payer: w.agent.address });
  const r = await w.log.onSettled(pp, w.req("48000000"), w.ok());
  assert.equal(r.outcome?.status, "accepted", "the id was not reserved by verify");
  await r.followUp;
});

test("purchase basis follows the table in the spec", () => {
  const pp = (accepted: PaymentRequirements, payload: Record<string, unknown> = {}): PaymentPayload => ({ x402Version: 2, accepted, payload });
  const r = (scheme: string, amount: string, extra: Record<string, unknown> = {}): PaymentRequirements => ({ scheme, network: NET, amount, asset: USDC, payTo: "0x22", maxTimeoutSeconds: 60, extra });
  const sr: SettleResponse = { success: true, transaction: "0x1", network: NET, amount: "700", extra: { chargedAmount: "650" } };
  assert.deepEqual(S.purchaseBasis(pp(r("exact", "48")), r("exact", "48"), sr), { ok: true, basis: 48n });
  assert.deepEqual(S.purchaseBasis(pp(r("exact", "48", { paymentFlow: "upfront" })), r("exact", "48"), sr), { ok: true, basis: 48n });
  assert.deepEqual(S.purchaseBasis(pp(r("upto", "1000")), r("upto", "400"), sr), { ok: true, basis: 400n }, "settle-time amount");
  assert.deepEqual(S.purchaseBasis(pp(r("batch-settlement", "700"), { type: "voucher" }), r("batch-settlement", "700"), sr), { ok: true, basis: 650n }, "extra.chargedAmount");
  assert.deepEqual(S.purchaseBasis(pp(r("batch-settlement", "700"), { type: "refund" }), r("batch-settlement", "700"), sr), { ok: false });
  assert.deepEqual(S.purchaseBasis(pp(r("batch-settlement", "700"), { type: "claim" }), r("batch-settlement", "700"), sr), { ok: false });
  assert.deepEqual(S.purchaseBasis(pp(r("auth-capture", "900", { paymentFlow: "authorization" })), r("auth-capture", "900"), sr), { ok: true, basis: 700n }, "what the charge collected");
  assert.deepEqual(S.purchaseBasis(pp(r("auth-capture", "900", { paymentFlow: "authorization" }), { type: "refund" }), r("auth-capture", "900"), sr), { ok: false });
  assert.deepEqual(S.purchaseBasis(pp(r("auth-capture", "900")), r("auth-capture", "900"), sr), { ok: false }, "escrow default");
  assert.deepEqual(S.purchaseBasis(pp(r("upto", "1000", { paymentFlow: "escrow" })), r("upto", "1000"), sr), { ok: false });
  assert.deepEqual(S.purchaseBasis(pp(r("mystery", "1")), r("mystery", "1"), sr), { ok: false });
});

test("refunds: keep only; a refund settle never triggers or adjusts a share", async () => {
  const w = await world();
  const accepted = w.req("48000000");
  const info = await w.share(accepted);
  const r = await w.log.onSettled(w.payload(accepted, info), accepted, w.ok());
  await r.followUp;
  assert.deepEqual(w.log.onPurchaseRefund({ transaction: "0xpurchase", amount: "48000000" }), { adjusted: false, rule: "keep" });
  assert.equal(w.log.inspect(info.id as string)?.state, "collected");
  // A refund payload carrying a share is not a purchase that can carry one.
  const info2 = await w.share(accepted);
  const r2 = await w.log.onSettled(w.payload({ ...accepted, scheme: "batch-settlement" }, info2, { type: "refund" }), accepted, w.ok());
  assert.equal(r2.outcome?.reason, "purchase-not-supported");
  // After close, a batch is never edited.
  w.chain.now = Date.UTC(2027, 0, 3) / 1000;
  await w.log.closePeriod("2026-12");
  assert.throws(() => w.log.book.addSettlement("2026-12", "x"), /closed/);
});

test("an exact share whose transfer fails is uncollected and left out of the batch", async () => {
  const w = await world();
  const accepted = w.req("48000000");
  const info = await w.share(accepted);
  const p = (info.payment as NonNullable<SolidarityInfo["payment"]>).payload as unknown as S.ExactEip3009Payload;
  w.chain.cancelAuthorization(USDC, p.authorization.from, p.authorization.nonce); // the agent voided it (EIP-3009 cancelAuthorization)
  const r = await w.log.onSettled(w.payload(accepted, info), accepted, w.ok());
  assert.equal(r.outcome?.status, "accepted", "accepted is provisional");
  await r.followUp;
  assert.equal(w.log.inspect(info.id as string)?.state, "uncollected");
  assert.deepEqual(JSON.parse(w.log.handle(`/proofs/${info.id}`).body), { status: "uncollected" });
  w.chain.now = Date.UTC(2027, 0, 3) / 1000;
  const st = await w.log.closePeriod("2026-12");
  const payload = S.decodeStatement(st.statement).payload;
  assert.equal(payload.size, 0);
  assert.deepEqual(payload.totals, []);
});

test("batch-settlement: one claim split across two periods; the fund attests both parts", async () => {
  const w = await world({ now: Date.UTC(2026, 11, 30, 12) / 1000 });
  w.chain.deposit(w.config, 1_000_000n);
  const ch = S.openClientChannel(NET, w.config);
  const ids: string[] = [];
  for (const [amount, t] of [["2000000", Date.UTC(2026, 11, 30, 12)], ["3000000", Date.UTC(2027, 0, 1, 1)]] as const) {
    w.chain.now = t / 1000;
    const accepted = w.req(amount);
    const info = await w.share(accepted, { kind: "batch-settlement", channel: ch });
    const r = await w.log.onSettled(w.payload(accepted, info), accepted, w.ok());
    assert.equal(r.outcome?.status, "accepted");
    assert.ok(r.outcome?.channel, "snapshot returned");
    S.applyOutcomeToChannel(ch, r.outcome);
    ids.push(info.id as string);
  }
  // Close December in January: the log claims everything charged so far (5000), split 2000 / 3000.
  w.chain.now = Date.UTC(2027, 0, 2) / 1000;
  const dec = await w.log.closePeriod("2026-12");
  w.chain.now = Date.UTC(2027, 1, 2) / 1000;
  const jan = await w.log.closePeriod("2027-01");
  const decSet = w.log.handle("/settlements/2026-12").body;
  const janSet = w.log.handle("/settlements/2027-01").body;
  const ref = (body: string) => S.parseSettlement(body.trim()).ref;
  assert.equal(ref(decSet), ref(janSet), "the same claim, split");
  assert.equal(S.parseSettlement(decSet.trim()).amount, "2000");
  assert.equal(S.parseSettlement(janSet.trim()).amount, "3000");
  assert.equal(w.chain.channelState(ch.channelId)?.totalClaimed, 5000n);
  const fundKey = S.generateSigningKey("EdDSA", "did:web:fund.example#1");
  const resolveKey = S.staticResolver({ [w.key.kid]: w.key.publicKey, [fundKey.kid]: fundKey.publicKey });
  const fund = new S.FundCosigner({ fund: POLICY.fund, key: fundKey, view: w.chain.fundView(), logAuthorizers: { [LOG]: w.config.receiverAuthorizer } });
  fund.cosign(dec, decSet, { resolveKey, descriptor: DESCRIPTOR });
  fund.cosign(jan, janSet, { resolveKey, descriptor: DESCRIPTOR });
  assert.deepEqual(S.verifyChain([dec, jan]), { ok: true, problems: [] });
});

test("batch-settlement: claim on withdrawal; shares a drained channel cannot pay are uncollected", async () => {
  const w = await world();
  w.chain.deposit(w.config, 6_000n);
  const ch = S.openClientChannel(NET, w.config);
  const ids: string[] = [];
  for (const amount of ["2000000", "3000000"]) {
    const accepted = w.req(amount);
    const info = await w.share(accepted, { kind: "batch-settlement", channel: ch });
    const r = await w.log.onSettled(w.payload(accepted, info), accepted, w.ok());
    S.applyOutcomeToChannel(ch, r.outcome);
    ids.push(info.id as string);
  }
  // The payer starts a withdrawal; the log sees it and claims at once.
  w.chain.initiateWithdrawal(ch.channelId);
  await w.log.onWithdrawalInitiated(ch.channelId);
  assert.equal(w.chain.channelState(ch.channelId)?.totalClaimed, 5000n);
  // Another share arrives, then the withdrawal finalizes before the log claims it.
  const accepted = w.req("1000000");
  const info = await w.share(accepted, { kind: "batch-settlement", channel: ch });
  const r = await w.log.onSettled(w.payload(accepted, info), accepted, w.ok());
  assert.equal(r.outcome?.status, "accepted");
  w.chain.now += 86400;
  w.chain.finalizeWithdrawal(ch.channelId);
  w.chain.now = Date.UTC(2027, 0, 3) / 1000;
  const st = await w.log.closePeriod("2026-12");
  assert.equal(w.log.inspect(info.id as string)?.state, "uncollected");
  assert.deepEqual(JSON.parse(w.log.handle(`/proofs/${info.id}`).body), { status: "uncollected" });
  const payload = S.decodeStatement(st.statement).payload;
  assert.equal(payload.size, 2);
  assert.equal(payload.totals[0].amount, "5000");
  for (const id of ids) assert.equal(JSON.parse(w.log.handle(`/proofs/${id}`).body).status, "included");
});

test("per-channel serialization: two concurrent vouchers on one base, one is a cumulative mismatch", async () => {
  const w = await world();
  w.chain.deposit(w.config, 1_000_000n);
  const a = S.openClientChannel(NET, w.config);
  const b = S.openClientChannel(NET, w.config); // a second client copy that ignores the busy flag
  const ia = await w.share(w.req("2000000"), { kind: "batch-settlement", channel: a });
  const ib = await w.share(w.req("2000000"), { kind: "batch-settlement", channel: b });
  const [ra, rb] = await Promise.all([w.log.onSettled(w.payload(w.req("2000000"), ia), w.req("2000000"), w.ok()), w.log.onSettled(w.payload(w.req("2000000"), ib), w.req("2000000"), w.ok())]);
  const statuses = [ra.outcome?.status, rb.outcome?.status].sort();
  assert.deepEqual(statuses, ["accepted", "skipped"]);
  assert.equal([ra, rb].find((r) => r.outcome?.status === "skipped")?.outcome?.reason, "cumulative-mismatch");
  assert.equal([ra, rb].find((r) => r.outcome?.status === "skipped")?.outcome?.channel?.chargedCumulativeAmount, "2000");
});

test("concurrent duplicates: one accepted, one duplicate", async () => {
  const w = await world();
  const accepted = w.req("48000000");
  const info = await w.share(accepted);
  const [r1, r2] = await Promise.all([w.log.onSettled(w.payload(accepted, info), accepted, w.ok()), w.log.onSettled(w.payload(accepted, structuredClone(info)), accepted, w.ok())]);
  assert.deepEqual([r1.outcome?.status, r2.outcome?.status].sort(), ["accepted", "skipped"]);
  await Promise.all([r1.followUp, r2.followUp]);
});

test("month close rules: not before the month ends, in order, empty months still get a statement", async () => {
  const w = await world();
  await assert.rejects(() => w.log.closePeriod("2026-12"), /before it ends/);
  w.chain.now = Date.UTC(2027, 2, 3) / 1000;
  await w.log.closePeriod("2026-12");
  await assert.rejects(() => w.log.closePeriod("2027-02"), /must be for 2027-01/);
  const jan = await w.log.closePeriod("2027-01");
  const p = S.decodeStatement(jan.statement).payload;
  assert.equal(p.size, 0);
  assert.equal(p.root, S.EMPTY_ROOT_HEX);
  assert.equal(p.previous, S.statementHash(S.decodeStatement((await Promise.resolve(JSON.parse(w.log.handle("/statements/2026-12").body))).statement).payload));
  assert.equal(w.log.handle("/lines/2027-01").body, "");
  assert.equal(w.log.handle("/settlements/2027-01").body, "");
  assert.equal(w.log.handle("/statements/2027-02").status, 404);
  assert.deepEqual(JSON.parse(w.log.handle("").body), DESCRIPTOR);
});

test("a pending purchase that fails drops the share; /proofs answers 404", async () => {
  const w = await world();
  const accepted = w.req("48000000");
  const info = await w.share(accepted);
  const r = await w.log.onSettled(w.payload(accepted, info), accepted, { success: false, errorReason: "settlement_pending", transaction: "0xp", network: NET });
  assert.equal(r.outcome?.status, "pending");
  assert.deepEqual(JSON.parse(w.log.handle(`/proofs/${info.id}`).body), { status: "queued" });
  const res = await w.log.resolvePending("0xp", false);
  assert.equal(res?.outcome.reason, "purchase-not-final");
  assert.equal(w.log.handle(`/proofs/${info.id}`).status, 404);
});
