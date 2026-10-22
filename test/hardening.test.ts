/**
 * Failure paths on the payment side: a share can never make the log throw,
 * a failed claim never strands a channel, the client never trusts the
 * relayed snapshot, concurrent shares never pass the cap, and a relaying
 * seller cannot move a share to another id.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SimulatedChain } from "../src/sim/chain.ts";
import * as S from "../src/solidarity/index.ts";
import type { LogDescriptor, OwnerPolicy, PaymentPayload, PaymentRequirements, SettleResponse, SolidarityInfo } from "../src/solidarity/index.ts";
import { conformance, siteFile } from "./helpers.ts";

const P = conformance("payloads.json");
const DESCRIPTOR: LogDescriptor = P.descriptor;
const POLICY: OwnerPolicy = P.policy;
const USDC = S.USDC_BASE_SEPOLIA.address;
const NET = "eip155:84532";
const LOG = DESCRIPTOR.log;
const FUND_ADDR = "0x000000000000000000000000000000000000f00d" as const;
const AUTHORIZER = "0x3333333333333333333333333333333333333333" as const;
const CORE = ["success", "errorReason", "payer", "transaction", "network", "amount"] as const;

function world(opts: { now?: number; cap?: string } = {}) {
  const now = opts.now ?? Date.UTC(2026, 11, 10, 12) / 1000;
  const chain = new SimulatedChain({ now });
  const agent = privateKeyToAccount(generatePrivateKey());
  chain.mint(USDC, agent.address, 1_000_000_000n);
  const key = S.generateSigningKey("EdDSA", DESCRIPTOR.keys[0].kid);
  const log = new S.SolidarityLog({ descriptor: DESCRIPTOR, key, chain, clock: () => chain.now });
  const counter = new S.CapCounter({ ...POLICY, cap: { ...POLICY.cap, amount: opts.cap ?? "1000000000" } });
  const ctx = { policy: POLICY, counter, signer: agent, descriptor: DESCRIPTOR, now };
  const config: S.ChannelConfig = { payer: agent.address, payerAuthorizer: agent.address, receiver: FUND_ADDR, receiverAuthorizer: AUTHORIZER, token: USDC as `0x${string}`, withdrawDelay: 86400, salt: `0x${"0".repeat(63)}5` };
  const req = (amount: string): PaymentRequirements => ({ scheme: "exact", network: NET, amount, asset: USDC, payTo: "0x2222222222222222222222222222222222222222", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } });
  const declared: SolidarityInfo = { version: 2, logs: [{ network: NET, scheme: "exact", log: LOG }] };
  const payload = (accepted: PaymentRequirements, info: SolidarityInfo): PaymentPayload => ({ x402Version: 2, accepted, payload: {}, extensions: { solidarity: { info, schema: S.solidaritySchema } } });
  const ok = (): SettleResponse => ({ success: true, transaction: "0xpurchase", network: NET, payer: agent.address, amount: "" });
  async function build(amount: string, o: Partial<S.BuildShareInput> = {}) {
    ctx.now = chain.now;
    return S.buildShare(ctx, { declared, accepted: req(amount), purchaseWindow: { validAfter: String(chain.now - 60), validBefore: String(chain.now + 60) }, ...o });
  }
  async function share(amount: string, o: Partial<S.BuildShareInput> = {}) {
    const d = await build(amount, o);
    assert.ok(d.attached, d.attached ? "" : d.why);
    return (d as Extract<S.ShareDecision, { attached: true }>).info;
  }
  /** Build, send and apply one batch-settlement share on `ch`. */
  async function batch(ch: S.ClientChannel, amount: string) {
    const info = await share(amount, { kind: "batch-settlement", channel: ch });
    const r = await log.onSettled(payload(req(amount), info), req(amount), ok());
    const applied = S.applyOutcomeToChannel(ch, r.outcome);
    return { info, outcome: r.outcome, applied };
  }
  return { chain, agent, log, key, counter, ctx, config, req, declared, payload, ok, build, share, batch };
}

// ---- the log never throws on a share ---------------------------------------------------

test("onSettled is total: out-of-range numbers in a share are bad-payment, and the purchase's response is untouched", async () => {
  const w = world();
  w.chain.deposit(w.config, 1_000_000n);
  const ch = S.openClientChannel(NET, w.config);
  const honest = await w.share("2000000", { kind: "batch-settlement", channel: ch });
  const cases: Array<[string, (i: SolidarityInfo) => void]> = [
    ["withdrawDelay -1", (i) => ((i.payment?.payload as unknown as S.BatchVoucherPayload).channelConfig.withdrawDelay = -1)],
    ["withdrawDelay 2^41", (i) => ((i.payment?.payload as unknown as S.BatchVoucherPayload).channelConfig.withdrawDelay = 2 ** 41)],
    ["withdrawDelay 1e21", (i) => ((i.payment?.payload as unknown as S.BatchVoucherPayload).channelConfig.withdrawDelay = 1e21)],
    ["withdrawDelay 1.5", (i) => ((i.payment?.payload as unknown as S.BatchVoucherPayload).channelConfig.withdrawDelay = 1.5)],
    ["maxClaimableAmount above uint128", (i) => ((i.payment?.payload as unknown as S.BatchVoucherPayload).voucher.maxClaimableAmount = "9".repeat(40))],
    ["amount not a number", (i) => ((i.payment as NonNullable<SolidarityInfo["payment"]>).accepted.amount = "1e3")],
    ["payload is a string", (i) => ((i.payment as unknown as { payload: unknown }).payload = "nope")],
  ];
  for (const [name, spoil] of cases) {
    const info = structuredClone(honest);
    info.id = S.generateShareId();
    spoil(info);
    const sr = w.ok();
    const r = await w.log.onSettled(w.payload(w.req("2000000"), info), w.req("2000000"), sr);
    assert.equal(r.outcome?.status, "skipped", name);
    assert.equal(r.outcome?.reason, "bad-payment", name);
    for (const k of CORE) assert.deepEqual(r.settleResponse[k], sr[k], `${name}: ${k}`);
  }
  // A purchase whose requirements are malformed: still no throw.
  const info = await w.share("48000000");
  const broken = { scheme: "upto" } as unknown as PaymentRequirements;
  const r = await w.log.onSettled({ x402Version: 2, accepted: broken, payload: {}, extensions: { solidarity: { info, schema: S.solidaritySchema } } }, broken, w.ok());
  assert.equal(r.outcome?.status, "skipped");
});

// ---- claims ------------------------------------------------------------------------------

test("a failed claim is retried: the shares stay queued, later shares on the channel are collected too", async () => {
  const w = world();
  w.chain.deposit(w.config, 1_000_000n);
  const ch = S.openClientChannel(NET, w.config);
  const s1 = await w.batch(ch, "2000000");
  const real = w.chain.claim.bind(w.chain);
  let fail = true;
  w.chain.claim = async (...a: Parameters<typeof real>) => (fail ? { ok: false as const, error: "rpc timeout" } : real(...a));
  await w.log.claimOutstanding();
  assert.equal(w.log.inspect(s1.info.id as string)?.state, "queued", "a transient failure is not uncollected");
  const s2 = await w.batch(ch, "3000000");
  assert.equal(s2.outcome?.status, "accepted");
  assert.ok(s2.applied);
  w.chain.now = Date.UTC(2027, 0, 3) / 1000;
  await assert.rejects(() => w.log.closePeriod("2026-12"), /try again/, "no statement over unresolved shares");
  fail = false;
  await w.log.closePeriod("2026-12");
  for (const s of [s1, s2]) assert.equal(w.log.inspect(s.info.id as string)?.state, "collected");
  assert.equal(w.chain.channelState(ch.channelId)?.totalClaimed, 5000n);
});

test("a drained channel that is funded again: the log lowers its charged amount, the client resyncs, later shares are collected", async () => {
  const w = world();
  w.chain.deposit(w.config, 1_000_000n);
  const ch = S.openClientChannel(NET, w.config);
  const s1 = await w.batch(ch, "2000000");
  w.chain.initiateWithdrawal(ch.channelId);
  w.chain.now += 86400;
  w.chain.finalizeWithdrawal(ch.channelId);
  await w.log.claimOutstanding();
  assert.equal(w.log.inspect(s1.info.id as string)?.state, "uncollected");
  w.chain.deposit(w.config, 1_000_000n);
  // The client still counts 2000; the log now says 0. The next voucher is a mismatch...
  const s2 = await w.batch(ch, "3000000");
  assert.equal(s2.outcome?.reason, "cumulative-mismatch");
  assert.equal(s2.applied, false);
  assert.equal(s2.outcome?.channel?.chargedCumulativeAmount, "0");
  assert.equal(s2.outcome?.channel?.signedMaxClaimable, "2000", "the last voucher the log holds");
  // ...and the client recovers from it, because the voucher in the snapshot is its own.
  assert.equal(await S.resyncChannel(ch, s2.outcome?.channel), true);
  assert.equal(ch.chargedCumulativeAmount, "0");
  const s3 = await w.batch(ch, "3000000");
  assert.equal(s3.outcome?.status, "accepted");
  await w.log.claimOutstanding();
  assert.equal(w.log.inspect(s3.info.id as string)?.state, "collected");
  assert.equal(w.chain.channelState(ch.channelId)?.totalClaimed, 3000n);
});

test("a claim the log did not make is unattributed: its shares are uncollected and later shares still work", async () => {
  const w = world();
  w.chain.deposit(w.config, 1_000_000n);
  const ch = S.openClientChannel(NET, w.config);
  const s1 = await w.batch(ch, "2000000");
  // Someone else (the binding lets the receiver, the fund, do this) claims the voucher.
  const v = (s1.info.payment?.payload as unknown as S.BatchVoucherPayload).voucher;
  assert.equal((await w.chain.claim(ch.channelId, v, 2000n)).ok, true);
  await w.log.claimOutstanding();
  assert.equal(w.log.inspect(s1.info.id as string)?.state, "uncollected", "counted in no total");
  const s2 = await w.batch(ch, "3000000");
  assert.equal(s2.outcome?.status, "accepted", "the log already charged up to what was claimed");
  await w.log.claimOutstanding();
  assert.equal(w.log.inspect(s2.info.id as string)?.state, "collected");
  w.chain.now = Date.UTC(2027, 0, 3) / 1000;
  const st = S.decodeStatement((await w.log.closePeriod("2026-12")).statement).payload;
  assert.deepEqual(st.totals.map((t) => t.amount), ["3000"]);
});

// ---- the client never trusts the relayed snapshot -----------------------------------------

test("the client keeps its own channel state: an inflated snapshot is ignored, and only its own voucher can resync it", async () => {
  const w = world();
  const ch = S.openClientChannel(NET, w.config);
  // No share in flight: nothing applies, whatever the snapshot says.
  assert.equal(S.applyOutcomeToChannel(ch, { status: "skipped", reason: "bad-payment", id: "x".repeat(22), log: LOG, channel: { channelId: ch.channelId, chargedCumulativeAmount: "900000000" } }), false);
  assert.equal(ch.chargedCumulativeAmount, "0");
  const d = await w.build("2000000", { kind: "batch-settlement", channel: ch });
  assert.ok(d.attached);
  const id = (d as Extract<S.ShareDecision, { attached: true }>).info.id as string;
  assert.equal((d.attached && (d.info.payment?.payload as unknown as S.BatchVoucherPayload).voucher.maxClaimableAmount), "2000", "built on its own state, not the snapshot");
  // Accepted, but the snapshot does not agree with previous + amount: state unchanged.
  const inflated = { status: "accepted" as const, id, log: LOG, period: "2026-12", amount: "2000", channel: { channelId: ch.channelId, chargedCumulativeAmount: "900002000" } };
  assert.equal(S.applyOutcomeToChannel(ch, inflated), false);
  assert.equal(ch.chargedCumulativeAmount, "0");
  // More than this share signed, or another share's id: ignored.
  for (const bad of [{ ...inflated, amount: "2001", channel: undefined }, { ...inflated, id: "y".repeat(22), channel: undefined }]) {
    const again = await w.build("2000000", { kind: "batch-settlement", channel: ch });
    assert.ok(again.attached);
    assert.equal(S.applyOutcomeToChannel(ch, { ...bad, id: bad.id === inflated.id ? (again as Extract<S.ShareDecision, { attached: true }>).info.id as string : bad.id }), false);
  }
  assert.equal(ch.chargedCumulativeAmount, "0");
  // Resync needs a voucher signed by this client, with charged at most its ceiling.
  const own = await S.signVoucher(w.agent, ch.channelId, "4000", NET);
  const stranger = await S.signVoucher(privateKeyToAccount(generatePrivateKey()), ch.channelId, "900002000", NET);
  assert.equal(await S.resyncChannel(ch, { channelId: ch.channelId, chargedCumulativeAmount: "900000000", signedMaxClaimable: "900002000", signature: stranger.signature }), false);
  assert.equal(await S.resyncChannel(ch, { channelId: ch.channelId, chargedCumulativeAmount: "5000", signedMaxClaimable: "4000", signature: own.signature }), false, "charged above the ceiling");
  assert.equal(await S.resyncChannel(ch, { channelId: ch.channelId, chargedCumulativeAmount: "2000", signedMaxClaimable: "4000", signature: own.signature }), true);
  assert.equal(ch.chargedCumulativeAmount, "2000");
});

// ---- concurrency ----------------------------------------------------------------------------

test("concurrent shares near the cap: one is attached, the other is left out, and neither rejects", async () => {
  const w = world({ cap: "48000" });
  const [a, b] = await Promise.all([w.build("48000000"), w.build("48000000")]);
  assert.deepEqual([a.attached, b.attached].sort(), [false, true]);
  assert.equal(w.counter.committed("2026-12"), 48000n);
  const w2 = world({ cap: "48000" });
  const decl = () => ({ [S.SOLIDARITY]: S.declareSolidarityExtension([{ network: NET, scheme: "exact", log: LOG }]) }) as Record<string, unknown>;
  const window = { validAfter: String(w2.chain.now - 60), validBefore: String(w2.chain.now + 60) };
  const results = await Promise.allSettled([
    S.appendSolidarityToExtensions(decl(), w2.ctx, { accepted: w2.req("48000000"), purchaseWindow: window }),
    S.appendSolidarityToExtensions(decl(), w2.ctx, { accepted: w2.req("48000000"), purchaseWindow: window }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(results.map((r) => (r as PromiseFulfilledResult<S.ShareDecision>).value.attached).sort(), [false, true]);
});

test("concurrent shares on one channel: only one voucher is signed on a base", async () => {
  const w = world();
  const ch = S.openClientChannel(NET, w.config);
  const [a, b] = await Promise.all([w.build("2000000", { kind: "batch-settlement", channel: ch }), w.build("2000000", { kind: "batch-settlement", channel: ch })]);
  assert.deepEqual([a.attached, b.attached].sort(), [false, true]);
  assert.equal(w.counter.committed("2026-12"), 2000n, "the left-out share is not counted");
});

test("buildShare never rejects, even on a malformed descriptor or a reused id", async () => {
  const w = world();
  const broken = { ...w.ctx, descriptor: { ...DESCRIPTOR, funds: undefined } as unknown as LogDescriptor };
  const d = await S.buildShare(broken, { declared: w.declared, accepted: w.req("48000000") });
  assert.equal(d.attached, false);
  const first = await w.build("48000000", { fixedId: "ReusedIdReusedIdReusedId" });
  assert.ok(first.attached);
  const again = await w.build("48000000", { fixedId: "ReusedIdReusedIdReusedId" });
  assert.ok(!again.attached && /already counted/.test(again.why));
});

test("a signing failure gives the cap room back and frees the channel", async () => {
  const w = world({ cap: "2000" });
  const ch = S.openClientChannel(NET, w.config);
  const failing = { ...w.ctx, signer: { address: w.agent.address, signTypedData: async () => Promise.reject(new Error("wallet locked")) } };
  const d = await S.buildShare(failing, { declared: w.declared, accepted: w.req("2000000"), kind: "batch-settlement", channel: ch });
  assert.ok(!d.attached && /wallet locked/.test(d.why));
  assert.equal(w.counter.left("2026-12"), 2000n);
  assert.equal(ch.busy, false);
});

test("the client checks the channel against the log's descriptor entry", async () => {
  const w = world();
  for (const [field, value, why] of [["receiver", "0x2222222222222222222222222222222222222222", /receiver is not the fund/], ["receiverAuthorizer", "0x4444444444444444444444444444444444444444", /receiverAuthorizer/], ["withdrawDelay", 3600, /withdrawDelay/], ["token", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", /token/]] as const) {
    const ch = S.openClientChannel(NET, { ...w.config, [field]: value });
    const d = await w.build("2000000", { kind: "batch-settlement", channel: ch });
    assert.ok(!d.attached && why.test(d.why), field);
  }
});

// ---- the seller relays the share --------------------------------------------------------------

test("an exact share's nonce binds its id: a seller cannot record it under an id of its own", async () => {
  const w = world();
  const info = await w.share("48000000");
  const p = info.payment?.payload as unknown as S.ExactEip3009Payload;
  assert.equal(p.authorization.nonce, S.shareNonce(info.id as string));
  const rewritten = { ...structuredClone(info), id: "SellerChosenIdXXXXXXXXX" };
  const r = await w.log.onSettled(w.payload(w.req("48000000"), rewritten), w.req("48000000"), w.ok());
  assert.deepEqual([r.outcome?.status, r.outcome?.reason], ["skipped", "bad-payment"]);
  assert.equal(w.log.handle("/proofs/SellerChosenIdXXXXXXXXX").status, 404);
  const honest = await w.log.onSettled(w.payload(w.req("48000000"), info), w.req("48000000"), w.ok());
  assert.equal(honest.outcome?.status, "accepted", "the owner's own id still works");
  await honest.followUp;
});

// ---- month close -----------------------------------------------------------------------------

test("before its first statement a log cannot skip a month that holds shares", async () => {
  const w = world({ now: Date.UTC(2026, 9, 20) / 1000 });
  const info = await w.share("48000000");
  const r = await w.log.onSettled(w.payload(w.req("48000000"), info), w.req("48000000"), w.ok());
  await r.followUp;
  assert.equal(r.outcome?.period, "2026-10");
  w.chain.now = Date.UTC(2026, 11, 5) / 1000;
  await assert.rejects(() => w.log.closePeriod("2026-11"), /first statement must be for 2026-10/);
  await w.log.closePeriod("2026-10");
  await w.log.closePeriod("2026-11");
  assert.equal(JSON.parse(w.log.handle(`/proofs/${info.id}`).body).status, "included");
});

// ---- schemas ------------------------------------------------------------------------------------

test("the outcome schema enforces the table: reason only when skipped, period and amount only when accepted", () => {
  const base = { id: "DRZzX1aYGEvTJ_Ftuk1mMWLq", log: LOG };
  for (const v of [{ ...base, status: "accepted", period: "2026-10", amount: "1" }, { ...base, status: "pending" }, { ...base, status: "skipped", reason: "duplicate" }]) {
    assert.deepEqual(S.validateOutcome(v as S.SolidarityOutcome), { valid: true }, JSON.stringify(v));
  }
  for (const v of [
    { ...base, status: "skipped" },
    { ...base, status: "accepted" },
    { ...base, status: "accepted", period: "2026-10" },
    { ...base, status: "pending", reason: "duplicate" },
    { ...base, status: "pending", period: "2026-10", amount: "1" },
    { ...base, status: "skipped", reason: "duplicate", amount: "1" },
  ]) {
    assert.equal(S.validateOutcome(v as S.SolidarityOutcome).valid, false, JSON.stringify(v));
  }
});

// The spec is three documents: solidarity.md (the x402 extension, with the wire examples),
// attestation.md (the receipt attestation contract, with the log descriptor) and processor-mode.md.
const SPEC_DOCS = ["spec/solidarity.md", "spec/attestation.md", "spec/processor-mode.md"];
test("the schemas here are the spec's inline schemas", { skip: !SPEC_DOCS.every((f) => siteFile(f)) && "site spec not found" }, () => {
  const md = SPEC_DOCS.map((f) => readFileSync(siteFile(f) as string, "utf8")).join("\n");
  const example = (name: string) => JSON.parse((new RegExp(`<!-- example:${name} -->\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``).exec(md) as RegExpExecArray)[1]);
  assert.deepEqual(example("payment-required").extensions.solidarity.schema, S.solidaritySchema);
  assert.deepEqual(example("settle-response").extensions.solidarity.schema, S.solidarityOutcomeSchema);
  const d = example("descriptor");
  assert.equal(d.minWithdrawDelay, undefined, "the channel's delay equals the entry's extra.withdrawDelay");
});

// ---- the seller only offers the slot ----------------------------------------------------------

test("a seller cannot pre-fill the share: the client adds none when the declared info carries more than version and logs", async () => {
  const w = world();
  for (const extra of [{ log: LOG }, { rate: "0.01" }, { fund: "eip155:84532:0x000000000000000000000000000000000000dead" }, { id: "SellerChosenIdXXXXXXXXX" }]) {
    const d = await w.build("48000000", { declared: { ...w.declared, ...extra } as SolidarityInfo });
    assert.ok(!d.attached && /more than version and logs/.test(d.why), JSON.stringify(extra));
  }
  const ext: Record<string, unknown> = { [S.SOLIDARITY]: { info: { ...w.declared, rate: "0.01" }, schema: S.solidaritySchema } };
  const before = structuredClone(ext);
  const d = await S.appendSolidarityToExtensions(ext, w.ctx, { accepted: w.req("48000000"), purchaseWindow: { validAfter: String(w.chain.now - 60), validBefore: String(w.chain.now + 60) } });
  assert.equal(d.attached, false);
  assert.deepEqual(ext, before, "nothing appended, nothing overwritten");
  assert.equal(w.counter.committed("2026-12"), 0n, "nothing counted against the cap");
});

// ---- the schema validator ------------------------------------------------------------------------

test("the schema validator checks own properties only: constructor, __proto__ and toString are extra keys", () => {
  for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const v = JSON.parse(`{"version":2,"${k}":1}`);
    assert.ok(S.validateSchema(S.solidaritySchema, v).some((e) => e.includes("not allowed")), k);
  }
  const outcome = JSON.parse('{"status":"skipped","reason":"duplicate","id":"x","log":"y","constructor":1}');
  assert.equal(S.validateOutcome(outcome).valid, false);
  assert.ok(S.validateSchema({ type: "object", required: ["toString"] }, {}).length > 0, "an inherited name never satisfies required");
  assert.ok(S.validateSchema({ type: "object", dependentRequired: { a: ["valueOf"] } }, { a: 1 }).length > 0);
});
