/**
 * Generates conformance/ from code. Deterministic: run it twice and nothing
 * changes (ECDSA signatures are RFC 6979, Ed25519 is deterministic, ids,
 * nonces and clocks are fixed, simulated transaction hashes are counters).
 *
 *   node scripts/generate-conformance.ts          write conformance/
 *   node scripts/generate-conformance.ts --check  exit 1 if conformance/ differs
 *
 * Keys are published test keys and must never hold value: the payer is the
 * well-known Hardhat/Anvil development account 0; statement keys are RFC 8032
 * section 7.1 TEST 1 (log), TEST 2 (witness) and TEST 3 (fund).
 * Addresses, funds and transaction hashes are placeholders. No money moves.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { SimulatedChain } from "../src/sim/chain.ts";
import * as S from "../src/solidarity/index.ts";
import type { LogDescriptor, OwnerPolicy, PaymentPayload, PaymentRequirements, SettleResponse, SolidarityInfo, SolidarityOutcome } from "../src/solidarity/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_VECTORS = JSON.parse(readFileSync(join(ROOT, "conformance/spec-draft2-vectors.json"), "utf8"));

export const TEST_KEYS = {
  payer: { privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", note: "Hardhat/Anvil development account 0. Public. Never fund it." },
  log: { seed: SPEC_VECTORS.keys.log.privateKeyHex, kid: SPEC_VECTORS.keys.log.kid, rfc8032: "7.1 TEST 1" },
  witness: { seed: SPEC_VECTORS.keys.witness.privateKeyHex, kid: SPEC_VECTORS.keys.witness.kid, rfc8032: "7.1 TEST 2" },
  fund: { seed: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7", kid: "did:web:fund.example#test-only-3", rfc8032: "7.1 TEST 3" },
} as const;

const USDC = S.USDC_BASE_SEPOLIA.address;
const NET = S.BASE_SEPOLIA;
const LOG = "https://log.example/solidarity";
const FUND = "eip155:84532:0x000000000000000000000000000000000000f00d";
const FUND2 = "eip155:84532:0x000000000000000000000000000000000000beef";
const FUND_ADDR = "0x000000000000000000000000000000000000f00d";
const SELLER = "0x2222222222222222222222222222222222222222";
const AUTHORIZER = "0x3333333333333333333333333333333333333333";
export const NOW = Date.UTC(2026, 11, 10, 12, 0, 0) / 1000; // 2026-12-10T12:00:00Z
const CLOSE_AT = Date.UTC(2027, 0, 5) / 1000; // 2027-01-05, as the spec vectors issue on the 5th

export const DESCRIPTOR: LogDescriptor = {
  version: 2,
  log: LOG,
  funds: [FUND2, FUND],
  accepts: [
    { network: NET, asset: USDC.toLowerCase(), scheme: "batch-settlement", maxTimeoutSeconds: 60, extra: { receiverAuthorizer: AUTHORIZER, withdrawDelay: 86400, name: "USDC", version: "2" } },
    { network: NET, asset: USDC.toLowerCase(), scheme: "exact", maxTimeoutSeconds: 60, minAmount: "10000", extra: { name: "USDC", version: "2" } },
  ],
  keys: [{ kid: TEST_KEYS.log.kid, from: "2026-10", until: null }],
  witnesses: ["did:web:witness.example"],
};

export const POLICY: OwnerPolicy = {
  version: 2,
  rate: "0.001",
  cap: { amount: "5000000", asset: USDC.toLowerCase() },
  fund: FUND,
  logs: [LOG],
  refunds: "keep",
  since: "2026-10-21T09:12:00Z",
};

const exactReq = (amount: string, extra: Record<string, unknown> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: NET,
  amount,
  asset: USDC,
  payTo: SELLER,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2", ...extra },
});

const declared = (scheme = "exact"): SolidarityInfo => ({ version: 2, logs: [{ network: NET, scheme, log: LOG }] });
const idOf = (n: number) => `conformance-share-${String(n).padStart(4, "0")}`;
const nonceOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const ok = (extra: Partial<SettleResponse> = {}): SettleResponse => ({ success: true, transaction: "0xpurchase", network: NET, payer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", ...extra });
const clone = <T>(v: T): T => structuredClone(v);

/** The outcome a case must have, written by hand: status and, when skipped, the reason. null = no entry. */
type Want = { status: "accepted" | "pending" | "skipped"; reason?: string; amount?: string } | null;

interface Case {
  name: string;
  note: string;
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
  settleResponse: SettleResponse;
  expected: SolidarityOutcome | null;
  want: Want;
  resolve?: { transaction: string; confirmed: boolean; expected: SolidarityOutcome; want: Want };
}

/** Fails the generator when the log's outcome is not what the case says by hand. */
function assertWant(name: string, want: Want, got: SolidarityOutcome | null | undefined): void {
  const g = got ?? null;
  const ok =
    want === null
      ? g === null
      : g !== null && g.status === want.status && g.reason === want.reason && (want.amount === undefined || g.amount === want.amount);
  if (!ok) throw new Error(`case ${name}: the log returned ${JSON.stringify(g)}, but the case expects ${JSON.stringify(want)}`);
}

/** Builds the facilitator cases with a real client, then perturbs some. Returns the cases and the world they ran in. */
export async function buildCases() {
  const account = privateKeyToAccount(TEST_KEYS.payer.privateKey);
  const chain = new SimulatedChain({ now: NOW });
  chain.mint(USDC, account.address, 1_000_000_000n);
  const channelConfig = {
    payer: account.address,
    payerAuthorizer: account.address,
    receiver: FUND_ADDR as `0x${string}`,
    receiverAuthorizer: AUTHORIZER as `0x${string}`,
    token: USDC as `0x${string}`,
    withdrawDelay: 86400,
    salt: nonceOf(1),
  };
  const channelId = chain.deposit(channelConfig, 1_000_000n);
  const clientChannel = S.openClientChannel(NET, channelConfig);

  const counter = new S.CapCounter({ ...POLICY, cap: { ...POLICY.cap, amount: "1000000000" } });
  const ctx = { policy: POLICY, counter, signer: account, descriptor: DESCRIPTOR, now: NOW };
  const window = { validAfter: String(NOW - 600), validBefore: String(NOW + 60) };
  let n = 0;

  async function share(accepted: PaymentRequirements, opts: Partial<S.BuildShareInput> = {}, decl: SolidarityInfo | undefined = declared(accepted.scheme)) {
    n += 1;
    const d = await S.buildShare(ctx, { declared: decl, accepted, purchaseWindow: window, fixedId: idOf(n), ...opts });
    if (!d.attached) throw new Error(`case ${n}: ${d.why}`);
    return d.info;
  }
  const payloadWith = (accepted: PaymentRequirements, info: SolidarityInfo, payloadExtra: Record<string, unknown> = {}): PaymentPayload => ({
    x402Version: 2,
    accepted,
    payload: { signature: "0xPurchaseSignatureNotCheckedByTheLog", ...payloadExtra },
    extensions: { solidarity: { info, schema: S.solidaritySchema } },
  });

  const cases: Case[] = [];
  const add = (c: Omit<Case, "expected">) => cases.push({ ...c, expected: null });
  const skip = (reason: string): Want => ({ status: "skipped", reason });
  // The exact share's own window: validBefore at least maxTimeoutSeconds after the purchase's.
  const shareWindow = (id: string, w = window) => ({ validAfter: w.validAfter, validBefore: String(Number(w.validBefore) + 60), nonce: S.shareNonce(id) });

  // 1. exact purchase, exact share: accepted.
  const p48 = exactReq("48000000");
  const i1 = await share(p48);
  add({ name: "exact-accepted", note: "48 USDC exact purchase at rate 0.001: an exact share of 48000 is accepted.", paymentPayload: payloadWith(p48, i1), requirements: p48, settleResponse: ok(), want: { status: "accepted", amount: "48000" } });
  // 2. the same share again: duplicate.
  add({ name: "duplicate", note: "The same id again.", paymentPayload: payloadWith(p48, clone(i1)), requirements: p48, settleResponse: ok(), want: skip("duplicate") });
  // 3. wrong log.
  const i3 = { ...(await share(p48)), log: "https://other.example/solidarity" };
  add({ name: "wrong-log", note: "log is not this log's URL.", paymentPayload: payloadWith(p48, i3), requirements: p48, settleResponse: ok(), want: skip("wrong-log") });
  // 4. fund not on the allow-list.
  const i4 = { ...(await share(p48)), fund: "eip155:84532:0x000000000000000000000000000000000000dead" };
  add({ name: "fund-not-allowed", note: "fund is not in the descriptor's funds.", paymentPayload: payloadWith(p48, i4), requirements: p48, settleResponse: ok(), want: skip("fund-not-allowed") });
  // 5. payTo is not the fund.
  const i5 = await share(p48);
  (i5.payment as NonNullable<SolidarityInfo["payment"]>).accepted.payTo = SELLER;
  add({ name: "payto-not-fund", note: "payment.accepted.payTo is the seller, not the fund.", paymentPayload: payloadWith(p48, i5), requirements: p48, settleResponse: ok(), want: skip("bad-payment") });
  // 6. exact share with an upto purchase.
  const upto = { ...exactReq("10000000"), scheme: "upto" };
  const i6 = { ...(await share(p48)) };
  add({ name: "exact-share-on-upto", note: "An exact share is allowed only with an exact purchase.", paymentPayload: payloadWith(upto, i6), requirements: upto, settleResponse: ok(), want: skip("kind-not-supported") });
  // 7. over the rate ceiling.
  const i7 = { ...(await share(p48)), rate: "0.02" };
  add({ name: "over-rate", note: "rate 0.02 is above 0.01.", paymentPayload: payloadWith(p48, i7), requirements: p48, settleResponse: ok(), want: skip("over-rate") });
  // 8. tampered signature.
  const i8 = await share(p48);
  const pl8 = (i8.payment as NonNullable<SolidarityInfo["payment"]>).payload as { signature: string };
  pl8.signature = `${pl8.signature.slice(0, -4)}${pl8.signature.slice(-4) === "1b1b" ? "1c1c" : "1b1b"}`;
  add({ name: "bad-signature", note: "The share's EIP-3009 signature does not verify.", paymentPayload: payloadWith(p48, i8), requirements: p48, settleResponse: ok(), want: skip("bad-payment") });
  // 9. expired authorization: the purchase's window had all but ended, so the share's ends at now + 3.
  const i9 = await share(p48, { purchaseWindow: { validAfter: String(NOW - 600), validBefore: String(NOW - 57) } });
  add({ name: "expired", note: "validBefore is less than now + 6 seconds.", paymentPayload: payloadWith(p48, i9), requirements: p48, settleResponse: ok(), want: skip("bad-payment") });
  // 10. below the exact minimum (built by hand: a client would leave it out).
  const p5 = exactReq("5000000");
  n += 1;
  const sig10 = await S.signEip3009(account, { ...p48, amount: "5000", payTo: FUND_ADDR }, shareWindow(idOf(n)));
  const i10: SolidarityInfo = {
    version: 2,
    logs: declared().logs,
    log: LOG,
    id: idOf(n),
    rate: "0.001",
    fund: FUND,
    payment: { accepted: { scheme: "exact", network: NET, amount: "5000", asset: USDC, payTo: FUND_ADDR, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }, payload: sig10 as unknown as Record<string, unknown> },
  };
  add({ name: "below-minimum", note: "A 5000 exact share is below the descriptor's minAmount of 10000.", paymentPayload: payloadWith(p5, i10), requirements: p5, settleResponse: ok(), want: skip("below-minimum") });
  // 11. signed more than floor(basis x rate): an exact share cannot settle less.
  n += 1;
  const sig11 = await S.signEip3009(account, { ...p48, amount: "60000", payTo: FUND_ADDR }, shareWindow(idOf(n)));
  const i11: SolidarityInfo = { ...i10, id: idOf(n), payment: { accepted: { ...(i10.payment as NonNullable<SolidarityInfo["payment"]>).accepted, amount: "60000" }, payload: sig11 as unknown as Record<string, unknown> } };
  add({ name: "amount-changed", note: "Signed 60000 on a 48 USDC purchase at 0.001 (48000): exact cannot settle less.", paymentPayload: payloadWith(p48, i11), requirements: p48, settleResponse: ok(), want: skip("amount-changed") });
  // 12. small exact purchase, batch-settlement share.
  const p2 = exactReq("2000000");
  const i12 = await share(p2, { kind: "batch-settlement", channel: clientChannel });
  add({ name: "batch-accepted", note: "2 USDC purchase: a batch-settlement share of 2000 on the owner's channel.", paymentPayload: payloadWith(p2, i12), requirements: p2, settleResponse: ok(), want: { status: "accepted", amount: "2000" } });
  return { account, chain, channelId, channelConfig, clientChannel, ctx, window, cases, payloadWith, share, shareWindow, nextN: () => ++n, p48, p2 };
}

/**
 * Runs the cases in order through one log. Each case's outcome must be the
 * status and reason written by hand in `want` (the generator fails otherwise);
 * `expected` then records the log's full outcome, snapshot included.
 */
export async function runCases() {
  const w = await buildCases();
  const { account, chain, clientChannel, cases } = w;
  const clock = { now: NOW };
  const log = new S.SolidarityLog({ descriptor: DESCRIPTOR, key: S.ed25519FromSeed(TEST_KEYS.log.seed, TEST_KEYS.log.kid), chain, clock: () => clock.now });
  const followUps: Promise<void>[] = [];
  const skip = (reason: string): Want => ({ status: "skipped", reason });
  // Chain setup beyond the owner's main channel, made as the cases need it; a replay applies it first.
  const setup: { mints: Array<{ token: string; to: string; amount: string }>; deposits: Array<{ id: string; config: S.ChannelConfig; amount: string }> } = { mints: [], deposits: [] };

  async function run(c: Case) {
    const r = await log.onSettled(c.paymentPayload, c.requirements, c.settleResponse);
    followUps.push(r.followUp);
    assertWant(c.name, c.want, r.outcome);
    c.expected = r.outcome ?? null;
    return r;
  }
  for (const c of cases) {
    const r = await run(c);
    if (c.name === "batch-accepted") S.applyOutcomeToChannel(clientChannel, r.outcome);
  }

  // 13. the next batch voucher, built from the snapshot: accepted.
  const p3 = { ...w.p2, amount: "3000000" };
  const i13 = await w.share(p3, { kind: "batch-settlement", channel: clientChannel });
  const c13: Case = { name: "batch-next", note: "The next voucher, cumulative from the client's own state (previous plus the amount the log reported).", paymentPayload: w.payloadWith(p3, i13), requirements: p3, settleResponse: ok(), expected: null, want: { status: "accepted", amount: "3000" } };
  cases.push(c13);
  S.applyOutcomeToChannel(clientChannel, (await run(c13)).outcome);

  // 14. a voucher that skips ahead: cumulative-mismatch, with the snapshot.
  const stale = { ...clientChannel, chargedCumulativeAmount: (BigInt(clientChannel.chargedCumulativeAmount) + 1n).toString(), busy: false };
  const i14 = await w.share(w.p2, { kind: "batch-settlement", channel: stale });
  const c14: Case = { name: "cumulative-mismatch", note: "maxClaimableAmount is not chargedCumulativeAmount + amount. The snapshot carries the last voucher the log holds, for the client's resync.", paymentPayload: w.payloadWith(w.p2, i14), requirements: w.p2, settleResponse: ok(), expected: null, want: skip("cumulative-mismatch") };
  cases.push(c14);
  await run(c14);

  // 15. upto purchase settling for less than its maximum: the log charges less.
  const uptoReq: PaymentRequirements = { ...exactReq("10000000"), scheme: "upto" };
  const i15 = await w.share(uptoReq, { kind: "batch-settlement", channel: clientChannel });
  const settleTime = { ...uptoReq, amount: "4000000" };
  const c15: Case = { name: "upto-settles-less", note: "Signed on a 10 USDC maximum (10000); the settle collected 4 USDC, so 4000 is recorded.", paymentPayload: w.payloadWith(uptoReq, i15), requirements: settleTime, settleResponse: ok({ amount: "4000000" }), expected: null, want: { status: "accepted", amount: "4000" } };
  cases.push(c15);
  S.applyOutcomeToChannel(clientChannel, (await run(c15)).outcome);

  // 16. the purchase settle failed.
  const i16 = await w.share(w.p48);
  const c16: Case = { name: "purchase-failed", note: "No purchase, no share.", paymentPayload: w.payloadWith(w.p48, i16), requirements: w.p48, settleResponse: { success: false, errorReason: "insufficient_funds", transaction: "", network: NET }, expected: null, want: skip("purchase-not-final") };
  cases.push(c16);
  await run(c16);

  // 17. escrow flow: never a share.
  const escrow: PaymentRequirements = { ...exactReq("48000000"), scheme: "auth-capture" };
  const i17 = { ...(await w.share(w.p48)) };
  const c17: Case = { name: "escrow", note: "auth-capture defaults to escrow; draft 2 has no shares on escrow flows.", paymentPayload: w.payloadWith(escrow, i17), requirements: escrow, settleResponse: ok(), expected: null, want: skip("purchase-not-supported") };
  cases.push(c17);
  await run(c17);

  // 18. an echo with no payment is not a share.
  const c18: Case = { name: "echo-only", note: "version and logs echoed, no payment: no solidarity entry.", paymentPayload: w.payloadWith(w.p48, declared()), requirements: w.p48, settleResponse: ok(), expected: null, want: null };
  cases.push(c18);
  await run(c18);

  // 19. settlement_pending: held, then processed when the purchase confirms.
  const i19 = await w.share(w.p48);
  const c19: Case = {
    name: "pending",
    note: "The purchase settle returned settlement_pending; the share is held and processed when the purchase confirms.",
    paymentPayload: w.payloadWith(w.p48, i19),
    requirements: w.p48,
    settleResponse: { success: false, errorReason: "settlement_pending", transaction: "0xpendingpurchase", network: NET },
    expected: null,
    want: { status: "pending" },
  };
  cases.push(c19);
  await run(c19);
  const resolved = await log.resolvePending("0xpendingpurchase", true);
  if (!resolved) throw new Error("pending share was not held");
  followUps.push(resolved.followUp);
  const want19: Want = { status: "accepted", amount: "48000" };
  assertWant("pending (resolved)", want19, resolved.outcome);
  c19.resolve = { transaction: "0xpendingpurchase", confirmed: true, expected: resolved.outcome, want: want19 };

  // 20. a kind the log does not list.
  const i20 = await w.share(w.p48);
  (i20.payment as NonNullable<SolidarityInfo["payment"]>).accepted.scheme = "upto";
  const c20: Case = { name: "kind-not-listed", note: "The share's scheme is not listed in the descriptor for this network and asset.", paymentPayload: w.payloadWith(w.p48, i20), requirements: w.p48, settleResponse: ok(), expected: null, want: skip("kind-not-supported") };
  cases.push(c20);
  await run(c20);

  // 21 onwards: one case per bad-payment check, each valid in every other respect, so a log
  // that left the check out would accept it.
  const pay = (i: SolidarityInfo) => i.payment as NonNullable<SolidarityInfo["payment"]>;
  const exactShare = async (name: string, note: string, tweak: { sign?: Partial<PaymentRequirements>; window?: { validAfter: string; validBefore: string; nonce?: `0x${string}` }; accepted?: Partial<PaymentRequirements> }) => {
    const id = idOf(w.nextN());
    const accepted: PaymentRequirements = { scheme: "exact", network: NET, amount: "48000", asset: USDC, payTo: FUND_ADDR, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };
    const sig = await S.signEip3009(account, { ...accepted, ...tweak.sign }, { ...w.shareWindow(id), ...tweak.window });
    const info: SolidarityInfo = { version: 2, logs: declared().logs, log: LOG, id, rate: "0.001", fund: FUND, payment: { accepted: { ...accepted, ...tweak.accepted }, payload: sig as unknown as Record<string, unknown> } };
    const c: Case = { name, note, paymentPayload: w.payloadWith(w.p48, info), requirements: w.p48, settleResponse: ok(), expected: null, want: skip("bad-payment") };
    cases.push(c);
    await run(c);
  };
  await exactShare("exact-to-not-fund", "The EIP-3009 authorization pays the seller, though accepted.payTo is the fund. The signature is valid for what was signed.", { sign: { payTo: SELLER } });
  await exactShare("exact-value-differs", "The authorization's value (50000) is not accepted.amount (48000).", { sign: { amount: "50000" } });
  await exactShare("exact-nonce-not-from-id", "The nonce is not SHA-256(\"solidarity/2|\" + id), so the signed payment does not bind the id.", { window: { ...w.window, nonce: nonceOf(77) } });
  await exactShare("exact-not-yet-valid", "validAfter is in the future.", { window: { validAfter: String(NOW + 600), validBefore: String(NOW + 1200) } });
  await exactShare("terms-max-timeout", "accepted.maxTimeoutSeconds (120) is not the descriptor entry's (60).", { accepted: { maxTimeoutSeconds: 120 } });
  await exactShare("terms-extra", "accepted.extra carries a field the descriptor entry does not.", { accepted: { extra: { name: "USDC", version: "2", note: "x" } } });
  await exactShare("network-mismatch", "The share is on Base mainnet; the fund and the purchase are on Base Sepolia.", { accepted: { network: "eip155:8453" } });
  await exactShare("asset-mismatch", "The share is in another token than the purchase.", { accepted: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } });

  // batch-settlement checks, each on a channel that exists and is funded, so only the one rule fails.
  const batchEntry = DESCRIPTOR.accepts?.find((a) => a.scheme === "batch-settlement") as NonNullable<LogDescriptor["accepts"]>[number];
  const OTHER = "0x4444444444444444444444444444444444444444" as const;
  const OTHER_TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
  chain.mint(OTHER_TOKEN, account.address, 1_000_000n);
  setup.mints.push({ token: OTHER_TOKEN, to: account.address, amount: "1000000" });
  const deposit = (config: S.ChannelConfig, amount: bigint) => {
    chain.deposit(config, amount);
    setup.deposits.push({ id: S.computeChannelId(config, NET).toLowerCase(), config, amount: amount.toString() });
  };
  let salt = 100;
  const voucherShare = async (name: string, note: string, opts: { config?: Partial<S.ChannelConfig>; deposit?: bigint; idFrom?: Partial<S.ChannelConfig>; amount?: string; depositToken?: string }) => {
    salt += 1;
    const config = { ...w.channelConfig, salt: nonceOf(salt), ...opts.config };
    if (opts.deposit !== 0n) deposit(config, opts.deposit ?? 1_000_000n);
    const idConfig = opts.idFrom ? { ...config, ...opts.idFrom } : config;
    if (opts.idFrom) deposit(idConfig, 1_000_000n);
    const amount = opts.amount ?? "2000";
    // An out-of-range withdrawDelay cannot be hashed; the voucher then names the in-range channel's id.
    const hashable = idConfig.withdrawDelay >= 0 ? idConfig : { ...idConfig, withdrawDelay: 86400 };
    const channelId = S.computeChannelId(hashable, NET);
    const voucher = await S.signVoucher(account, channelId, amount, NET);
    const id = idOf(w.nextN());
    const info: SolidarityInfo = {
      version: 2,
      logs: declared().logs,
      log: LOG,
      id,
      rate: "0.001",
      fund: FUND,
      payment: { accepted: { scheme: "batch-settlement", network: NET, amount, asset: USDC, payTo: FUND_ADDR, maxTimeoutSeconds: 60, extra: { ...batchEntry.extra } }, payload: { type: "voucher", channelConfig: config, voucher } },
    };
    const purchase = { ...w.p2, amount: String(BigInt(amount) * 1000n) };
    const c: Case = { name, note, paymentPayload: w.payloadWith(purchase, info), requirements: purchase, settleResponse: ok(), expected: null, want: skip("bad-payment") };
    cases.push(c);
    await run(c);
  };
  await voucherShare("batch-channel-id", "voucher.channelId is another (funded) channel's id, not the hash of channelConfig.", { idFrom: { salt: nonceOf(999) } });
  await voucherShare("batch-receiver", "The channel's receiver is the seller, not the fund.", { config: { receiver: SELLER } });
  await voucherShare("batch-receiver-authorizer", "The channel's receiverAuthorizer is not the log's.", { config: { receiverAuthorizer: OTHER } });
  await voucherShare("batch-token", "The channel's token is not the share's asset.", { config: { token: OTHER_TOKEN } });
  await voucherShare("batch-withdraw-delay", "The channel's withdrawDelay (3600) is not the descriptor entry's (86400).", { config: { withdrawDelay: 3600 } });
  await voucherShare("batch-over-balance", "The voucher's ceiling (2000) is more than the channel holds (1000).", { deposit: 1000n });
  await voucherShare("batch-withdraw-delay-out-of-range", "withdrawDelay -1 cannot be hashed as uint40; the share is skipped and the purchase's response is untouched.", { config: { withdrawDelay: -1 }, deposit: 0n });

  await Promise.all(followUps);
  return { ...w, log, clock, cases, setup };
}

/** The three-month chained statement set: 2026-10 and 2026-11 are the spec's vectors; 2026-12 comes from the cases. */
export async function buildChain() {
  const world = await runCases();
  const { log, clock, chain } = world;
  const logKey = S.ed25519FromSeed(TEST_KEYS.log.seed, TEST_KEYS.log.kid);
  const witnessKey = S.ed25519FromSeed(TEST_KEYS.witness.seed, TEST_KEYS.witness.kid);
  const fundKey = S.ed25519FromSeed(TEST_KEYS.fund.seed, TEST_KEYS.fund.kid);
  const resolveKey = S.staticResolver({ [logKey.kid]: logKey.publicKey, [witnessKey.kid]: witnessKey.publicKey, [fundKey.kid]: fundKey.publicKey });

  // The spec's 2026-10 and 2026-11 periods, closed through the same book.
  for (const e of S.parseFileBody(SPEC_VECTORS.settlements.body)) log.book.addSettlement("2026-10", e);
  log.book.close("2026-10", SPEC_VECTORS.lines.input, SPEC_VECTORS.statements[0].payload.issuedAt);
  log.book.close("2026-11", [], SPEC_VECTORS.statements[1].payload.issuedAt);

  clock.now = CLOSE_AT;
  chain.now = CLOSE_AT;
  const dec = await log.closePeriod("2026-12", CLOSE_AT);

  const witness = new S.Witness(witnessKey);
  const fund = new S.FundCosigner({ fund: FUND, key: fundKey, view: chain.fundView(), logAuthorizers: { [LOG]: AUTHORIZER } });
  const periods = ["2026-10", "2026-11", "2026-12"];
  for (const p of periods) {
    const closed = log.book.get(p) as NonNullable<ReturnType<typeof log.book.get>>;
    log.addCosignature(p, witness.cosign(closed.pub, { resolveKey, descriptor: DESCRIPTOR, files: { lines: closed.lines, settlements: closed.settlements } }));
  }
  const decClosed = log.book.get("2026-12") as NonNullable<ReturnType<typeof log.book.get>>;
  log.addCosignature("2026-12", fund.cosign(decClosed.pub, decClosed.settlements, { resolveKey, descriptor: DESCRIPTOR }));
  return { ...world, periods, resolveKey, keys: { logKey, witnessKey, fundKey }, dec };
}

const json = (v: unknown) => `${JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2)}\n`;

/** RFC 8785 section 3.2.4: the UTF-8 bytes of the canonical form of the section 3.2.2 sample. */
const RFC8785_UTF8_HEX =
  "7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c226e756d62657273223a5b3333333333333333332e333333333333332c31652b33302c342e352c302e3030322c31652d32375d2c22737472696e67223a22e282ac245c75303030665c6e4127425c225c5c5c5c5c222f227d";

function rfc8785Vectors() {
  return {
    source: "RFC 8785 (JSON Canonicalization Scheme), sections 3.2.2, 3.2.3, 3.2.4 and Appendix B, copied from https://www.rfc-editor.org/rfc/rfc8785.txt",
    primitives: {
      input: "{\n  \"numbers\": [333333333.33333329, 1E30, 4.50,\n              2e-3, 0.000000000000000000000000001],\n  \"string\": \"\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\\"\\/\",\n  \"literals\": [null, true, false]\n}",
      canonical: Buffer.from(RFC8785_UTF8_HEX, "hex").toString("utf8"),
      utf8Hex: RFC8785_UTF8_HEX,
    },
    sorting: {
      input: "{\n  \"\\u20ac\": \"Euro Sign\",\n  \"\\r\": \"Carriage Return\",\n  \"\\ufb33\": \"Hebrew Letter Dalet With Dagesh\",\n  \"1\": \"One\",\n  \"\\ud83d\\ude00\": \"Emoji: Grinning Face\",\n  \"\\u0080\": \"Control\",\n  \"\\u00f6\": \"Latin Small Letter O With Diaeresis\"\n}",
      expectedValueOrder: ["Carriage Return", "One", "Control", "Latin Small Letter O With Diaeresis", "Euro Sign", "Emoji: Grinning Face", "Hebrew Letter Dalet With Dagesh"],
    },
    numbers: [
      ["0000000000000000", "0"],
      ["8000000000000000", "0"],
      ["0000000000000001", "5e-324"],
      ["8000000000000001", "-5e-324"],
      ["7fefffffffffffff", "1.7976931348623157e+308"],
      ["ffefffffffffffff", "-1.7976931348623157e+308"],
      ["4340000000000000", "9007199254740992"],
      ["c340000000000000", "-9007199254740992"],
      ["4430000000000000", "295147905179352830000"],
      ["7fffffffffffffff", null],
      ["7ff0000000000000", null],
      ["44b52d02c7e14af5", "9.999999999999997e+22"],
      ["44b52d02c7e14af6", "1e+23"],
      ["44b52d02c7e14af7", "1.0000000000000001e+23"],
      ["444b1ae4d6e2ef4e", "999999999999999700000"],
      ["444b1ae4d6e2ef4f", "999999999999999900000"],
      ["444b1ae4d6e2ef50", "1e+21"],
      ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
      ["3eb0c6f7a0b5ed8d", "0.000001"],
      ["41b3de4355555553", "333333333.3333332"],
      ["41b3de4355555554", "333333333.33333325"],
      ["41b3de4355555555", "333333333.3333333"],
      ["41b3de4355555556", "333333333.3333334"],
      ["41b3de4355555557", "333333333.33333343"],
      ["becbf647612f3696", "-0.0000033333333333333333"],
      ["43143ff3c1cb0959", "1424953923781206.2"],
    ],
    numbersNote: "IEEE 754 double as hex, then the JSON text; null means the value is not valid JSON (NaN, Infinity) and must be rejected.",
  };
}

function merkleVectors() {
  const leaves = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"];
  const bytes = leaves.map((h) => new Uint8Array(Buffer.from(h, "hex")));
  const roots = leaves.map((_, i) => S.merkleRoot(bytes.slice(0, i + 1)));
  const proofs = [
    [0, 8],
    [5, 8],
    [2, 3],
    [1, 5],
    [6, 7],
  ].map(([index, size]) => ({ index, size, proof: S.buildTree(bytes.slice(0, size)).proof(index) }));
  return {
    source:
      "RFC 6962 section 2.1 trees over the Certificate Transparency reference test leaves (the leaves and 8-leaf root the spec lists). Roots are MTH(D[0:n]) for n = 1..8. Audit paths for (0,8), (5,8), (2,3), (1,5) match the Certificate Transparency reference implementation's tests.",
    leavesHex: leaves,
    rootsByPrefixSize: roots,
    emptyRoot: S.EMPTY_ROOT_HEX,
    inclusion: proofs,
  };
}

function shareVectors() {
  const cases: Array<Record<string, string | null>> = [];
  const max = (purchase: string, rate: string, capLeft?: string) => cases.push({ fn: "shareMax", purchase, rate, capLeft: capLeft ?? null, expected: S.shareMax(purchase, rate, capLeft).toString() });
  max("48000000", "0.001");
  max("48000000", "0.01");
  max("48000000", "0.000001");
  max("999", "0.001");
  max("1000", "0.001");
  max("1999", "0.001");
  max("48000000", "0.001", "1250");
  max("48000000", "0.001", "0");
  max("123456789012345678901234567890", "0.0025");
  const rec = (signed: string, basis: string, rate: string) => cases.push({ fn: "recordedShare", signed, basis, rate, expected: S.recordedShare(signed, basis, rate).toString() });
  rec("48000", "48000000", "0.001");
  rec("10000", "4000000", "0.001");
  rec("60000", "48000000", "0.001");
  rec("5", "4999", "0.001");
  // netCredit per purchase: refunded is the total refunded so far, share the amount recorded, alreadyCredited what earlier refunds credited.
  const net = (refunded: string, rate: string, share: string, alreadyCredited = "0") =>
    cases.push({ fn: "netCredit", refunded, rate, share, alreadyCredited, expected: S.netCredit(refunded, rate, share, alreadyCredited).toString() });
  net("1000", "0.01", "48");
  net("48000000", "0.001", "48000");
  net("99999999", "0.001", "48000");
  net("500000", "0.001", "100"); // a share the cap cut to 100: half the purchase refunded credits all of it
  net("1000000", "0.001", "100", "100"); // the rest of the refund finds nothing left
  net("1500", "0.001", "48000", "1"); // two partial refunds of 1500: floor(3.0) - 1
  const rates = ["0.01", "0.001", "0.000001", "0.0025", "0.009999", "0.010", "0.0100", "0.02", "0.0000001", "0.1", "1", "0", "0.000000", ".001", "0.00100"].map((r) => ({ rate: r, valid: S.isValidRate(r) }));
  return {
    note: "Atomic units as decimal strings. floor throughout. rate must match ^0\\.(01|00[0-9]{0,3}[1-9])$.",
    cases,
    rates,
  };
}

function policyVectors() {
  const p = (name: string, mode: "separate" | "processor", policy: unknown) => {
    const problems = S.policyProblems(policy as OwnerPolicy, mode);
    return { name, mode, policy, valid: problems.length === 0, problems };
  };
  return {
    note: "Owner policies (never sent on the wire). policyHash is hex SHA-256 of the JCS bytes, for the holder's own records only.",
    policyHash: { policy: POLICY, sha256: S.policyHash(POLICY) },
    cases: [
      p("separate-keep", "separate", POLICY),
      p("separate-net", "separate", { ...POLICY, refunds: "net" }),
      p("processor-net", "processor", { ...POLICY, cap: { amount: "500", asset: "USD" }, fund: "https://fund.example/solidarity", refunds: "net" }),
      p("rate-too-high", "separate", { ...POLICY, rate: "0.02" }),
      p("rate-trailing-zero", "separate", { ...POLICY, rate: "0.0010" }),
      p("cap-not-integer", "separate", { ...POLICY, cap: { ...POLICY.cap, amount: "5.00" } }),
      p("fund-not-caip10", "separate", { ...POLICY, fund: "https://fund.example/solidarity" }),
      p("logs-not-https", "separate", { ...POLICY, logs: ["http://log.example/solidarity"] }),
      p("version-1", "separate", { ...POLICY, version: 1 }),
    ],
    processorConstraint: S.processorConstraint({ ...POLICY, cap: { amount: "500", asset: "USD" }, fund: "https://fund.example/solidarity" }, { holder: "https://processor.example", logs: ["https://processor.example/solidarity"] }),
  };
}

/** Every generated file, keyed by its path under conformance/. */
export async function generate(): Promise<Record<string, string>> {
  const w = await buildChain();
  const files: Record<string, string> = {};
  files["jcs-rfc8785.json"] = json(rfc8785Vectors());
  files["merkle-rfc6962.json"] = json(merkleVectors());
  files["shares.json"] = json(shareVectors());
  files["policies.json"] = json(policyVectors());
  files["payloads.json"] = json({
    note: "Facilitator cases. Process them in order with ONE log (state carries over: ids seen, channel cumulative amounts). The log's clock is `now`. Before the cases, the owner's channel exists with the given deposit, and the mints and deposits in `setup` have been made. `want` is the outcome each case must have, written by hand; `expected` is the full SettleResponse.extensions.solidarity.info the log returns (null = no entry). Every core SettleResponse field must come back unchanged. Purchase payloads are placeholders: the log does not check them.",
    now: NOW,
    descriptor: DESCRIPTOR,
    policy: POLICY,
    payer: { address: w.account.address, key: TEST_KEYS.payer },
    channel: { id: w.channelId, config: w.chain.channelConfig(w.channelId), deposit: "1000000" },
    setup: w.setup,
    cases: w.cases,
  });
  const periods: Record<string, unknown>[] = [];
  for (const p of w.periods) {
    const c = w.log.book.get(p) as NonNullable<ReturnType<typeof w.log.book.get>>;
    files[`files/${p}.lines`] = c.lines;
    files[`files/${p}.settlements`] = c.settlements;
    files[`files/${p}.statement.json`] = json(c.pub);
    periods.push({ period: p, payload: c.payload, jcs: S.canonicalizeStrict(c.payload), sha256: S.statementHash(c.payload), size: c.batch.size, root: c.batch.root, totals: c.batch.totals, published: c.pub });
  }
  const dec = w.log.book.get("2026-12") as NonNullable<ReturnType<typeof w.log.book.get>>;
  const receipts: Record<string, unknown> = {};
  for (const line of dec.batch.lines) {
    const id = S.parseLine(line).id;
    const r = w.log.receipt(id);
    if (!r) throw new Error(`no receipt for ${id}`);
    files[`receipts/${id}.json`] = json(r);
    receipts[id] = r;
  }
  files["ledger.json"] = json({
    note: "The 2026-12 batch the facilitator cases produced, with every line's audit path. Lines are sorted bytewise.",
    period: "2026-12",
    lines: dec.batch.lines,
    size: dec.batch.size,
    root: dec.batch.root,
    totals: dec.batch.totals,
    proofs: dec.batch.lines.map((_, i) => ({ index: i, proof: dec.batch.proof(i) })),
    settlementsBody: dec.settlements,
    settlementsSha256: S.sha256Hex(dec.settlements),
  });
  files["statements.json"] = json({
    note: "Three chained monthly statements. 2026-10 and 2026-11 are the spec's draft 2 vectors; 2026-12 is the batch from payloads.json. Each is cosigned by the witness (TEST 2); 2026-12 is also cosigned by fund 0x...f00d (TEST 3), whose cosignature attests its settlement references in the simulated chain.",
    descriptor: DESCRIPTOR,
    keys: {
      log: { kid: TEST_KEYS.log.kid, publicKeyHex: S.ed25519PublicKeyHex(w.keys.logKey.publicKey), rfc8032: TEST_KEYS.log.rfc8032 },
      witness: { kid: TEST_KEYS.witness.kid, publicKeyHex: S.ed25519PublicKeyHex(w.keys.witnessKey.publicKey), rfc8032: TEST_KEYS.witness.rfc8032 },
      fund: { kid: TEST_KEYS.fund.kid, publicKeyHex: S.ed25519PublicKeyHex(w.keys.fundKey.publicKey), rfc8032: TEST_KEYS.fund.rfc8032, fund: FUND },
    },
    periods,
  });
  return files;
}

async function main() {
  const files = await generate();
  const check = process.argv.includes("--check");
  let differ = 0;
  for (const [rel, body] of Object.entries(files)) {
    const path = join(ROOT, "conformance", rel);
    if (check) {
      let cur = "";
      try {
        cur = readFileSync(path, "utf8");
      } catch {}
      if (cur !== body) {
        differ += 1;
        console.log(`differs: conformance/${rel}`);
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
  }
  console.log(check ? (differ ? `${differ} file(s) differ` : "conformance/ is up to date") : `wrote ${Object.keys(files).length} files to conformance/`);
  if (differ) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
