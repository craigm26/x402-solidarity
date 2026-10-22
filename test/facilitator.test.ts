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
  for (const m of P.setup.mints) chain.mint(m.token, m.to, BigInt(m.amount));
  for (const d of P.setup.deposits) assert.equal(chain.deposit(d.config, BigInt(d.amount)), d.id);
  const log = new S.SolidarityLog({ descriptor: DESCRIPTOR, key: S.generateSigningKey("EdDSA", DESCRIPTOR.keys[0].kid), chain, clock: () => P.now });
  for (const c of P.cases) {
    const r = await log.onSettled(c.paymentPayload, c.requirements, c.settleResponse);
    assert.deepEqual(r.outcome ?? null, c.expected, c.name);
    if (c.want === null) assert.equal(r.outcome, undefined, c.name);
    else assert.deepEqual([r.outcome?.status, r.outcome?.reason], [c.want.status, c.want.reason], `${c.name}: the hand-written outcome`);
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
  assert.deepEqual(S.purchaseBasis(pp(r("exact", "48"), { type: "refund" }), r("exact", "48"), sr), { ok: false }, "a refund payload never carries a share, whatever its scheme");
  assert.deepEqual(S.purchaseBasis(pp(r("upto", "1000"), { type: "refund" }), r("upto", "400"), sr), { ok: false });
  assert.deepEqual(S.purchaseBasis(pp(r("upto", "1000")), r("upto", "400"), sr), { ok: true, basis: 400n }, "settle-time amount");
  assert.deepEqual(S.purchaseBasis(pp(r("batch-settlement", "700"), { type: "voucher" }), r("batch-settlement", "700"), sr), { ok: false }, "batch-settlement purchases carry no share in draft 2");
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

test("batch-settlement: claim on withdrawal, and at once for a share accepted while it is pending", async () => {
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
  // Another share arrives while the withdrawal is pending: the log claims it at once (followUp),
  // so the withdrawal cannot finalize past it. (A channel drained before the log could claim is
  // covered in hardening.test.ts.)
  const accepted = w.req("1000000");
  const info = await w.share(accepted, { kind: "batch-settlement", channel: ch });
  const r = await w.log.onSettled(w.payload(accepted, info), accepted, w.ok());
  assert.equal(r.outcome?.status, "accepted");
  await r.followUp;
  assert.equal(w.chain.channelState(ch.channelId)?.totalClaimed, 6000n, "claimed before the delay could elapse");
  w.chain.now += 86400;
  w.chain.finalizeWithdrawal(ch.channelId);
  w.chain.now = Date.UTC(2027, 0, 3) / 1000;
  const st = await w.log.closePeriod("2026-12");
  assert.equal(w.log.inspect(info.id as string)?.state, "collected");
  const payload = S.decodeStatement(st.statement).payload;
  assert.equal(payload.size, 3);
  assert.equal(payload.totals[0].amount, "6000");
  for (const id of [...ids, info.id as string]) assert.equal(JSON.parse(w.log.handle(`/proofs/${id}`).body).status, "included");
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
  assert.deepEqual(JSON.parse(w.log.handle(`/proofs/${info.id}`).body), { status: "pending" });
  const res = await w.log.resolvePending("0xp", false);
  assert.equal(res?.outcome.reason, "purchase-not-final");
  assert.equal(w.log.handle(`/proofs/${info.id}`).status, 404);
});

// ---- review of draft 2 -------------------------------------------------------------------

/** Build, send and apply one batch-settlement share on `ch`. */
async function batchShare(w: Awaited<ReturnType<typeof world>>, ch: S.ClientChannel, amount: string) {
  const accepted = w.req(amount);
  const info = await w.share(accepted, { kind: "batch-settlement", channel: ch });
  const r = await w.log.onSettled(w.payload(accepted, info), accepted, w.ok());
  const applied = S.applyOutcomeToChannel(ch, r.outcome);
  return { info, id: info.id as string, outcome: r.outcome, applied };
}

test("an exact share the seller submitted first is still collected, under the seller's transaction", async () => {
  const w = await world();
  const accepted = w.req("48000000");
  const info = await w.share(accepted);
  const pay = info.payment as NonNullable<SolidarityInfo["payment"]>;
  // The seller relays the signed authorization, so it can submit it before the log does.
  const front = await w.chain.transferWithAuthorization(pay.accepted, pay.payload as unknown as S.ExactEip3009Payload);
  assert.ok(front.ok);
  const r = await w.log.onSettled(w.payload(accepted, info), accepted, w.ok());
  await r.followUp;
  assert.equal(w.log.inspect(info.id as string)?.state, "collected");
  w.chain.now = Date.UTC(2027, 0, 3) / 1000;
  const st = S.decodeStatement((await w.log.closePeriod("2026-12")).statement).payload;
  assert.deepEqual(st.totals.map((t) => t.amount), ["48000"]);
  assert.equal(S.parseSettlement(w.log.handle("/settlements/2026-12").body.trim()).ref, `exact:${(front as { transaction: string }).transaction}`);
  assert.equal(JSON.parse(w.log.handle(`/proofs/${info.id}`).body).status, "included");
});

test("a claim that keeps failing holds a statement only until the claim grace runs out; then the channel recovers", async () => {
  const w = await world();
  w.chain.deposit(w.config, 1_000_000n);
  const ch = S.openClientChannel(NET, w.config);
  const s1 = await batchShare(w, ch, "2000000");
  assert.equal(s1.outcome?.status, "accepted");
  const exact = await w.share(w.req("48000000"));
  const re = await w.log.onSettled(w.payload(w.req("48000000"), exact), w.req("48000000"), w.ok());
  await re.followUp;
  const real = w.chain.claim.bind(w.chain);
  w.chain.claim = async () => ({ ok: false as const, error: "reverted" });
  w.chain.now = Date.UTC(2027, 0, 3) / 1000;
  await assert.rejects(() => w.log.closePeriod("2026-12"), /try again/, "inside the grace: retry");
  w.chain.now = Date.UTC(2027, 0, 20) / 1000; // 19 days after December ends, past the 14-day grace
  const st = S.decodeStatement((await w.log.closePeriod("2026-12")).statement).payload;
  assert.equal(st.size, 1, "the exact share; the stuck batch share is left out");
  assert.deepEqual(st.totals.map((t) => t.amount), ["48000"]);
  assert.deepEqual(JSON.parse(w.log.handle(`/proofs/${s1.id}`).body), { status: "uncollected" });
  // The channel recovers: the client's next voucher is a cumulative-mismatch, and it resyncs from its own voucher.
  w.chain.claim = real;
  const s2 = await batchShare(w, ch, "3000000");
  assert.equal(s2.outcome?.reason, "cumulative-mismatch");
  assert.equal(await S.resyncChannel(ch, s2.outcome?.channel), true);
  assert.equal(ch.chargedCumulativeAmount, "0");
  const s3 = await batchShare(w, ch, "3000000");
  assert.equal(s3.outcome?.status, "accepted");
  assert.equal(s3.outcome?.period, "2027-01");
  w.chain.now = Date.UTC(2027, 1, 3) / 1000;
  await w.log.closePeriod("2027-01");
  assert.equal(JSON.parse(w.log.handle(`/proofs/${s3.id}`).body).status, "included");
  assert.equal(w.chain.channelState(ch.channelId)?.totalClaimed, 3000n);
});

test("an upto share that records less leaves no headroom: its voucher cannot be spent again under another id", async () => {
  const w = await world();
  w.chain.deposit(w.config, 1_000_000n);
  const ch = S.openClientChannel(NET, w.config);
  const upto = w.req("10000000", "upto");
  const info = await w.share(upto, { kind: "batch-settlement", channel: ch });
  const r = await w.log.onSettled(w.payload(upto, info), { ...upto, amount: "4000000" }, w.ok({ amount: "4000000" }));
  assert.equal(r.outcome?.amount, "4000", "recorded on what the settle collected");
  assert.equal(r.outcome?.channel?.chargedCumulativeAmount, "10000", "the voucher base moves by what was signed");
  assert.equal(r.outcome?.channel?.signature, undefined, "an accepted outcome carries no voucher");
  assert.ok(S.applyOutcomeToChannel(ch, r.outcome));
  assert.equal(ch.chargedCumulativeAmount, "10000");
  // A junk share naming the channel learns no voucher.
  const junk = { version: 2, log: "https://elsewhere.example/solidarity", id: S.generateShareId(), rate: "0.001", fund: POLICY.fund, payment: { accepted: { scheme: "batch-settlement" }, payload: { voucher: { channelId: ch.channelId } } } } as unknown as SolidarityInfo;
  const probe = await w.log.onSettled(w.payload(w.req("1000000"), junk), w.req("1000000"), w.ok());
  assert.equal(probe.outcome?.reason, "wrong-log");
  assert.ok(probe.outcome?.channel && probe.outcome.channel.signature === undefined && probe.outcome.channel.signedMaxClaimable === undefined);
  // The relaying seller holds the owner's voucher anyway. Under an id of its own, at any amount and rate, it fails.
  const voucher = (info.payment?.payload as unknown as S.BatchVoucherPayload).voucher;
  const entry = DESCRIPTOR.accepts?.find((a) => a.scheme === "batch-settlement") as NonNullable<LogDescriptor["accepts"]>[number];
  for (const amount of ["6000", "1"]) {
    const forged = {
      version: 2,
      log: LOG,
      id: S.generateShareId(),
      rate: "0.01",
      fund: POLICY.fund,
      payment: { accepted: { scheme: "batch-settlement", network: NET, amount, asset: USDC, payTo: FUND_ADDR, maxTimeoutSeconds: entry.maxTimeoutSeconds, extra: { ...entry.extra } }, payload: { type: "voucher", channelConfig: w.config, voucher } },
    } as unknown as SolidarityInfo;
    const rf = await w.log.onSettled(w.payload(w.req("1000000"), forged), w.req("1000000"), w.ok());
    assert.equal(rf.outcome?.reason, "cumulative-mismatch", amount);
  }
  // The owner's next share builds on the signed ceiling; claims cover recorded amounts only.
  const next = await batchShare(w, ch, "2000000");
  assert.equal((next.info.payment?.payload as unknown as S.BatchVoucherPayload).voucher.maxClaimableAmount, "12000");
  assert.ok(next.applied);
  w.chain.now = Date.UTC(2027, 0, 3) / 1000;
  const st = S.decodeStatement((await w.log.closePeriod("2026-12")).statement).payload;
  assert.equal(st.size, 2);
  assert.deepEqual(st.totals.map((t) => t.amount), ["6000"]);
  assert.equal(w.chain.channelState(ch.channelId)?.totalClaimed, 6000n, "the 6000 the upto share did not record is never claimed");
});

test("claim boundaries: a share ending exactly at the balance is collected; an outside claim ending exactly at a share's start leaves it collectable", async () => {
  const w = await world();
  w.chain.deposit(w.config, 5000n);
  const ch = S.openClientChannel(NET, w.config);
  const a = await batchShare(w, ch, "2000000");
  const b = await batchShare(w, ch, "3000000");
  await w.log.claimOutstanding();
  for (const s of [a, b]) assert.equal(w.log.inspect(s.id)?.state, "collected");
  assert.equal(w.chain.channelState(ch.channelId)?.totalClaimed, 5000n);

  const w2 = await world();
  w2.chain.deposit(w2.config, 1_000_000n);
  const ch2 = S.openClientChannel(NET, w2.config);
  const c = await batchShare(w2, ch2, "2000000");
  const d = await batchShare(w2, ch2, "3000000");
  const v = (c.info.payment?.payload as unknown as S.BatchVoucherPayload).voucher;
  assert.equal((await w2.chain.claim(ch2.channelId, v, 2000n)).ok, true, "someone else claims exactly the first share");
  await w2.log.claimOutstanding();
  assert.equal(w2.log.inspect(c.id)?.state, "uncollected");
  assert.equal(w2.log.inspect(d.id)?.state, "collected", "it starts where the outside claim ended");
  assert.equal(w2.chain.channelState(ch2.channelId)?.totalClaimed, 5000n);
});

test("a batch-settlement share on a settlement_pending purchase is skipped at once; the client's state stays as it was", async () => {
  const w = await world();
  w.chain.deposit(w.config, 1_000_000n);
  const ch = S.openClientChannel(NET, w.config);
  await batchShare(w, ch, "2000000");
  const accepted = w.req("3000000");
  const info = await w.share(accepted, { kind: "batch-settlement", channel: ch });
  const r = await w.log.onSettled(w.payload(accepted, info), accepted, { success: false, errorReason: "settlement_pending", transaction: "0xpb", network: NET });
  assert.deepEqual([r.outcome?.status, r.outcome?.reason], ["skipped", "purchase-not-final"]);
  assert.equal(await w.log.resolvePending("0xpb", true), undefined, "nothing was held");
  assert.ok(S.applyOutcomeToChannel(ch, r.outcome));
  assert.equal(ch.chargedCumulativeAmount, "2000");
  const next = await batchShare(w, ch, "3000000");
  assert.equal(next.outcome?.status, "accepted", "the next voucher builds on the same base without a mismatch");
});

test("a batch-settlement share skipped before its checks still carries the channel snapshot, without the voucher", async () => {
  const w = await world();
  w.chain.deposit(w.config, 1_000_000n);
  const ch = S.openClientChannel(NET, w.config);
  await batchShare(w, ch, "2000000");
  const accepted = w.req("3000000");
  const cases: Array<[string, PaymentPayload, SettleResponse]> = [];
  // A refund payload: not a purchase that can carry a share.
  let info = await w.share(accepted, { kind: "batch-settlement", channel: ch });
  cases.push(["purchase-not-supported", w.payload(accepted, info, { type: "refund" }), w.ok()]);
  for (const [reason, pp, sr] of cases) {
    const r = await w.log.onSettled(pp, accepted, sr);
    assert.deepEqual([r.outcome?.status, r.outcome?.reason], ["skipped", reason]);
    assert.equal(r.outcome?.channel?.channelId, ch.channelId.toLowerCase(), `${reason}: snapshot`);
    assert.equal(r.outcome?.channel?.chargedCumulativeAmount, "2000", `${reason}: nothing charged`);
    assert.equal(r.outcome?.channel?.signature, undefined, `${reason}: no voucher`);
    assert.deepEqual(S.validateOutcome(r.outcome as S.SolidarityOutcome), { valid: true });
    assert.ok(S.applyOutcomeToChannel(ch, r.outcome), `${reason}: the client keeps its state`);
  }
  // A purchase settle that failed.
  info = await w.share(accepted, { kind: "batch-settlement", channel: ch });
  const r = await w.log.onSettled(w.payload(accepted, info), accepted, { success: false, errorReason: "insufficient_funds", transaction: "", network: NET });
  assert.deepEqual([r.outcome?.status, r.outcome?.reason], ["skipped", "purchase-not-final"]);
  assert.equal(r.outcome?.channel?.chargedCumulativeAmount, "2000");
  assert.ok(S.applyOutcomeToChannel(ch, r.outcome));
  assert.equal(ch.chargedCumulativeAmount, "2000");
  const next = await batchShare(w, ch, "3000000");
  assert.equal(next.outcome?.status, "accepted", "the next voucher builds on the same base");
});

test("a share skipped for a reason the client can fix may be retried with the same id; one the log accepted may not", async () => {
  const w = await world();
  const accepted = w.req("48000000");
  const info = await w.share(accepted);
  const wrong = await w.log.onSettled(w.payload(accepted, { ...structuredClone(info), log: "https://elsewhere.example/solidarity" }), accepted, w.ok());
  assert.deepEqual([wrong.outcome?.status, wrong.outcome?.reason], ["skipped", "wrong-log"]);
  const retry = await w.log.onSettled(w.payload(accepted, structuredClone(info)), accepted, w.ok());
  assert.equal(retry.outcome?.status, "accepted", "a skipped id is not held, so it is not a duplicate");
  await retry.followUp;
  const again = await w.log.onSettled(w.payload(accepted, structuredClone(info)), accepted, w.ok());
  assert.deepEqual([again.outcome?.status, again.outcome?.reason], ["skipped", "duplicate"]);
});
