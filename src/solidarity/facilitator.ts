/**
 * Facilitator side: a solidarity log ("Facilitator behaviour", "Receipt
 * attestation", "Publication", "Refunds").
 *
 * - /verify is untouched: `onVerify` returns the purchase's VerifyResponse
 *   unchanged and has no side effects.
 * - The share is processed only after a settle listed in "Purchases that can
 *   carry a share" succeeds (`onSettled`). The outcome goes to the buyer in
 *   `SettleResponse.extensions.solidarity`; an optional `{status}` goes to the
 *   seller in EXTENSION-RESPONSES. Core SettleResponse fields never change.
 * - The log decides from checks it can make at once; an accepted `exact`
 *   share's transfer is submitted afterwards (`followUp`).
 * - Refunds: `keep` only in separate mode. Refund settles never trigger a
 *   share and never adjust one (`onPurchaseRefund`).
 * - Month close: claims, the batch, the settlements file and a JCS statement
 *   signed with the log's key and chained by `previous`.
 */

import { getAddress } from "viem";
import { MAX_WITHDRAW_DELAY, MIN_WITHDRAW_DELAY, VALID_BEFORE_BUFFER_SECONDS } from "./constants.ts";
import type { BatchVoucherPayload, ExactEip3009Payload, VoucherFields } from "./evm.ts";
import { computeChannelId, isBatchVoucherPayload, isExactEip3009Payload, verifyEip3009Signature, verifyVoucherSignature } from "./evm.ts";
import type { SigningKey } from "./ledger.ts";
import { formatLine, formatSettlement } from "./ledger.ts";
import type { ProofResult } from "./book.ts";
import { LogBook } from "./book.ts";
import { resolveFlow } from "./client.ts";
import { solidarityOutcomeSchema, solidaritySchema, validateSchema } from "./schema.ts";
import type {
  ChannelSnapshot,
  DescriptorAccept,
  JwsEnvelope,
  LogDescriptor,
  PaymentPayload,
  PaymentRequirements,
  PublishedStatement,
  Receipt,
  SettleResponse,
  ShareKind,
  SkipReason,
  SolidarityInfo,
  SolidarityOutcome,
} from "./types.ts";
import { RATE_PATTERN, SOLIDARITY } from "./types.ts";
import { extractSolidarity } from "./validation.ts";
import {
  applyRate,
  canonicalAccount,
  compareDecimal,
  isDecimal,
  isValidShareId,
  nextPeriod,
  parseCaip10,
  periodOf,
  periodStart,
  sameAccount,
} from "./utils.ts";

/** What the log needs from the chain. The offline simulation implements it; so would an RPC-backed one. */
export interface LogChain {
  /** Submit an accepted exact share's transferWithAuthorization. */
  submitExact(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<{ ok: true; transaction: string } | { ok: false; error: string }>;
  /** Current on-chain state of a batch-settlement channel, or undefined if it does not exist. */
  channelState(channelId: string): { balance: bigint; totalClaimed: bigint; withdrawRequestedAt: number; refundNonce: bigint } | undefined;
  /** Claim a channel up to `totalClaimed` with the payer's voucher. */
  claim(channelId: string, voucher: VoucherFields, totalClaimed: bigint): Promise<{ ok: true; transaction: string } | { ok: false; error: string }>;
}

type ShareState = "pending" | "queued" | "collected" | "uncollected";

interface ShareRecord {
  id: string;
  kind: ShareKind;
  period: string;
  fund: string;
  asset: string;
  amount: bigint;
  state: ShareState;
  line: string;
  exact?: { accepted: PaymentRequirements; payload: ExactEip3009Payload; transaction?: string; error?: string };
  batch?: { channelId: string; from: bigint; to: bigint };
}

interface ChannelRecord {
  channelId: string;
  config: BatchVoucherPayload["channelConfig"];
  fund: string;
  asset: string;
  charged: bigint;
  claimedByLog: bigint;
  latestVoucher?: VoucherFields;
  shares: string[]; // ids in charge order
}

interface PendingPurchase {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
  settleResponse: SettleResponse;
  id: string;
}

export interface SettledResult {
  /** The SettleResponse with `extensions.solidarity` added (core fields unchanged). */
  settleResponse: SettleResponse;
  /** Base64 JSON for the EXTENSION-RESPONSES header (seller only), when there is a solidarity outcome. */
  extensionResponses?: string;
  /** The outcome, also inside settleResponse.extensions.solidarity.info. */
  outcome?: SolidarityOutcome;
  /** Work done after the response is sent (submitting an exact share). Await it; it never throws. */
  followUp: Promise<void>;
}

export interface SolidarityLogOptions {
  descriptor: LogDescriptor;
  key: SigningKey;
  chain: LogChain;
  /** Unix seconds. */
  clock?: () => number;
}

const CORE_FIELDS = ["success", "errorReason", "payer", "transaction", "network", "amount"] as const;

class Skip extends Error {
  reason: SkipReason;
  constructor(reason: SkipReason, detail?: string) {
    super(detail ?? reason);
    this.reason = reason;
  }
}

export class SolidarityLog {
  readonly descriptor: LogDescriptor;
  private readonly chain: LogChain;
  private readonly clock: () => number;

  private readonly shares = new Map<string, ShareRecord>();
  private readonly reserved = new Set<string>();
  private readonly channels = new Map<string, ChannelRecord>();
  private readonly channelLocks = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, PendingPurchase>();
  readonly book: LogBook;

  constructor(opts: SolidarityLogOptions) {
    this.descriptor = opts.descriptor;
    this.book = new LogBook(opts.descriptor, opts.key);
    this.chain = opts.chain;
    this.clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  // ---- verify --------------------------------------------------------------

  /** /verify handles the purchase exactly as it would without the extension. */
  onVerify<T>(_paymentPayload: PaymentPayload, verifyResponse: T): T {
    return verifyResponse;
  }

  // ---- settle ---------------------------------------------------------------

  /**
   * Call after the purchase's /settle returns. Returns the SettleResponse to
   * send, with the solidarity outcome added when the payload carried a share.
   */
  async onSettled(paymentPayload: PaymentPayload, requirements: PaymentRequirements, settleResponse: SettleResponse): Promise<SettledResult> {
    const info = extractSolidarity(paymentPayload);
    if (!info || info.payment === undefined) return { settleResponse, followUp: Promise.resolve() };

    let outcome: SolidarityOutcome;
    let followUp: Promise<void> = Promise.resolve();
    const base = this.baseOutcome(info);

    const basis = purchaseBasis(paymentPayload, requirements, settleResponse);
    if (!basis.ok) {
      // Spec choice: refund payloads, server-written settles and escrow flows never trigger a
      // share; the spec names no reason for them, so they get purchase-not-supported.
      outcome = { ...base, status: "skipped", reason: "purchase-not-supported" };
    } else if (!settleResponse.success && settleResponse.errorReason === "settlement_pending" && settleResponse.transaction) {
      // Spec choice: the share is only held here. Its checks run when the purchase confirms
      // (resolvePending), and its period is the month it is accepted then.
      const id = isValidShareId(info.id) && !this.shares.has(info.id) && !this.reserved.has(info.id) ? info.id : undefined;
      if (id) {
        this.reserved.add(id);
        this.pending.set(settleResponse.transaction, { paymentPayload, requirements, settleResponse, id });
        outcome = { ...base, status: "pending" };
      } else {
        outcome = { ...base, status: "skipped", reason: isValidShareId(info.id) ? "duplicate" : "bad-payment" };
      }
    } else if (!settleResponse.success) {
      outcome = { ...base, status: "skipped", reason: "purchase-not-final" };
    } else {
      const r = await this.process(info, paymentPayload, requirements, basis.basis);
      outcome = r.outcome;
      followUp = r.followUp;
    }

    const out = withOutcome(settleResponse, outcome);
    return {
      settleResponse: out,
      outcome,
      extensionResponses: Buffer.from(JSON.stringify({ [SOLIDARITY]: { status: outcome.status } })).toString("base64"),
      followUp,
    };
  }

  /**
   * A `settlement_pending` purchase was resolved. If it confirmed, the held
   * share is processed now; if it failed, the share is dropped. The buyer
   * already has its response, so the result is visible through /proofs/<id>.
   */
  async resolvePending(transaction: string, confirmed: boolean, finalResponse?: SettleResponse): Promise<{ outcome: SolidarityOutcome; followUp: Promise<void> } | undefined> {
    const p = this.pending.get(transaction);
    if (!p) return undefined;
    this.pending.delete(transaction);
    this.reserved.delete(p.id);
    const info = extractSolidarity(p.paymentPayload) as SolidarityInfo;
    if (!confirmed) return { outcome: { ...this.baseOutcome(info), status: "skipped", reason: "purchase-not-final" }, followUp: Promise.resolve() };
    const sr = finalResponse ?? { ...p.settleResponse, success: true, errorReason: undefined };
    const basis = purchaseBasis(p.paymentPayload, p.requirements, sr);
    if (!basis.ok) return { outcome: { ...this.baseOutcome(info), status: "skipped", reason: "purchase-not-supported" }, followUp: Promise.resolve() };
    return this.process(info, p.paymentPayload, p.requirements, basis.basis);
  }

  /**
   * Refunds never adjust a share in separate mode: a share is a final gift
   * (`keep`), refunds are settles the server writes, and a closed batch is
   * never edited. Returned for the caller's records.
   */
  onPurchaseRefund(_refund: { transaction?: string; amount?: string }): { adjusted: false; rule: "keep" } {
    return { adjusted: false, rule: "keep" };
  }

  private baseOutcome(info: SolidarityInfo): Pick<SolidarityOutcome, "id" | "log"> {
    return { id: typeof info.id === "string" ? info.id : "", log: this.descriptor.log };
  }

  private async process(
    info: SolidarityInfo,
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    basis: bigint,
  ): Promise<{ outcome: SolidarityOutcome; followUp: Promise<void> }> {
    const base = this.baseOutcome(info);
    const payment = info.payment as NonNullable<SolidarityInfo["payment"]>;
    const kind = payment?.accepted?.scheme;
    const channelId = kind === "batch-settlement" ? (payment?.payload as { voucher?: { channelId?: string } })?.voucher?.channelId : undefined;

    const run = async (): Promise<{ outcome: SolidarityOutcome; followUp: Promise<void> }> => {
      let reservedId: string | undefined;
      try {
        const checked = await this.check(info, paymentPayload, requirements, basis, (id) => {
          reservedId = id;
        });
        const now = this.clock();
        const period = periodOf(now);
        const rec = this.record(info, checked, period);
        const outcome: SolidarityOutcome = { ...base, status: "accepted", period, amount: rec.amount.toString() };
        if (rec.batch) outcome.channel = this.snapshot(rec.batch.channelId);
        const followUp = rec.kind === "exact" ? this.submitExact(rec) : Promise.resolve();
        return { outcome, followUp };
      } catch (e) {
        if (!(e instanceof Skip)) throw e;
        const outcome: SolidarityOutcome = { ...base, status: "skipped", reason: e.reason };
        if (channelId && typeof channelId === "string") {
          const snap = this.snapshot(channelId);
          if (snap) outcome.channel = snap;
        }
        return { outcome, followUp: Promise.resolve() };
      } finally {
        if (reservedId) this.reserved.delete(reservedId);
      }
    };

    // Serialize processing per channel ("The log MUST serialize processing per channel").
    if (channelId && typeof channelId === "string") return this.withChannelLock(channelId.toLowerCase(), run);
    return run();
  }

  private async withChannelLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.channelLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => next);
    this.channelLocks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.channelLocks.get(key) === chained) this.channelLocks.delete(key);
    }
  }

  /** The ordered checks of "Facilitator behaviour", steps 3 and 4. Throws Skip at the first failure. */
  private async check(
    info: SolidarityInfo,
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    basis: bigint,
    reserve: (id: string) => void,
  ): Promise<{ kind: ShareKind; amount: bigint; fund: string; asset: string; entry: DescriptorAccept; channel?: { id: string; voucher: VoucherFields; config: BatchVoucherPayload["channelConfig"]; charged: bigint } }> {
    const d = this.descriptor;
    const payment = info.payment;
    const accepted = payment?.accepted;
    const purchase = paymentPayload.accepted ?? requirements;

    // `log` is its own log URL.
    if (info.log !== d.log) throw new Skip("wrong-log");

    // `fund` is on its allow-list.
    if (typeof info.fund !== "string" || !d.funds.some((f) => sameAccount(f, info.fund))) throw new Skip("fund-not-allowed");

    // `payTo` is that fund's address and the network and asset match the purchase.
    if (!accepted || typeof accepted !== "object" || typeof payment?.payload !== "object" || payment.payload === null) throw new Skip("bad-payment", "payment shape");
    let fund: ReturnType<typeof parseCaip10>;
    try {
      fund = parseCaip10(info.fund);
    } catch {
      throw new Skip("bad-payment", "fund is not CAIP-10");
    }
    if (!sameAccount(accepted.payTo, fund.address)) throw new Skip("bad-payment", "payTo is not the fund");
    if (accepted.network !== fund.chain || accepted.network !== purchase.network || requirements.network !== purchase.network) {
      throw new Skip("bad-payment", "network mismatch");
    }
    if (!sameAccount(accepted.asset, purchase.asset)) throw new Skip("bad-payment", "asset mismatch");

    // The kind is listed for that network and asset, and an exact share comes with an exact purchase.
    const kind = accepted.scheme as ShareKind;
    const entry = d.accepts?.find((a) => a.network === accepted.network && sameAccount(a.asset, accepted.asset) && a.scheme === kind);
    if (!entry || (kind !== "exact" && kind !== "batch-settlement")) throw new Skip("kind-not-supported");
    if (kind === "exact" && purchase.scheme !== "exact") throw new Skip("kind-not-supported", "exact share needs an exact purchase");

    // `rate` is at most 0.01.
    if (typeof info.rate !== "string" || !RATE_PATTERN.test(info.rate)) {
      if (isDecimal(info.rate) && compareDecimal(info.rate, "0.01") > 0) throw new Skip("over-rate");
      // Spec choice: no reason exists for a malformed share; a well-formed rate above 0.01 is
      // over-rate, anything else the schema rules out is bad-payment.
      throw new Skip("bad-payment", "rate is not a canonical decimal from 0.000001 to 0.01");
    }

    // `id` has not been seen in this log.
    if (!isValidShareId(info.id)) throw new Skip("bad-payment", "id");
    // Spec choice: only ids the log holds (accepted, pending, or being checked) count as seen,
    // so a share skipped for a reason the client can fix may be retried with the same id.
    if (this.shares.has(info.id) || this.reserved.has(info.id)) throw new Skip("duplicate");
    reserve(info.id);
    this.reserved.add(info.id);

    // Anything else the schema rules out.
    if (validateSchema(solidaritySchema, info).length > 0) throw new Skip("bad-payment", "schema");

    // The share verifies under its scheme.
    let channel: { id: string; voucher: VoucherFields; config: BatchVoucherPayload["channelConfig"]; charged: bigint } | undefined;
    const now = this.clock();
    if (kind === "exact") {
      const p = payment.payload;
      if (!isExactEip3009Payload(p)) throw new Skip("bad-payment", "not an EIP-3009 payload");
      const extra = { ...(entry.extra ?? {}), ...(accepted.extra ?? {}) };
      if (entry.extra && (extra.name !== entry.extra.name || extra.version !== entry.extra.version)) throw new Skip("bad-payment", "EIP-712 domain");
      if (!sameAccount(p.authorization.to, accepted.payTo)) throw new Skip("bad-payment", "authorization.to");
      if (BigInt(p.authorization.value) !== BigInt(accepted.amount)) throw new Skip("bad-payment", "authorization.value");
      if (BigInt(p.authorization.validAfter) > BigInt(now)) throw new Skip("bad-payment", "validAfter in the future");
      if (BigInt(p.authorization.validBefore) < BigInt(now + VALID_BEFORE_BUFFER_SECONDS)) throw new Skip("bad-payment", "validBefore passed");
      if (!(await verifyEip3009Signature({ ...accepted, extra }, p))) throw new Skip("bad-payment", "signature");
    } else {
      const p = payment.payload;
      if (!isBatchVoucherPayload(p)) throw new Skip("bad-payment", "not a voucher payload");
      const c = p.channelConfig;
      const cid = p.voucher.channelId.toLowerCase();
      if (computeChannelId(c, accepted.network).toLowerCase() !== cid) throw new Skip("bad-payment", "channel id");
      if (!sameAccount(c.receiver, accepted.payTo)) throw new Skip("bad-payment", "receiver is not the fund");
      const auth = entry.extra?.receiverAuthorizer;
      if (typeof auth !== "string" || !sameAccount(c.receiverAuthorizer, auth)) throw new Skip("bad-payment", "receiverAuthorizer");
      if (!sameAccount(c.token, accepted.asset)) throw new Skip("bad-payment", "token");
      if (c.withdrawDelay < (d.minWithdrawDelay ?? MIN_WITHDRAW_DELAY) || c.withdrawDelay < MIN_WITHDRAW_DELAY || c.withdrawDelay > MAX_WITHDRAW_DELAY) {
        throw new Skip("bad-payment", "withdrawDelay");
      }
      if (!(await verifyVoucherSignature(c, p.voucher, accepted.network))) throw new Skip("bad-payment", "voucher signature");
      const state = this.chain.channelState(cid);
      if (!state || state.balance === 0n) throw new Skip("bad-payment", "channel not found");
      const known = this.channels.get(cid);
      const charged = known?.charged ?? state.totalClaimed;
      if (BigInt(p.voucher.maxClaimableAmount) !== charged + BigInt(accepted.amount)) throw new Skip("cumulative-mismatch");
      if (BigInt(p.voucher.maxClaimableAmount) > state.balance) throw new Skip("bad-payment", "voucher exceeds channel balance");
      channel = { id: cid, voucher: p.voucher, config: c, charged };
    }

    // Step 4: the recorded amount.
    const signed = BigInt(accepted.amount);
    const cap = applyRate(basis, info.rate);
    const amount = signed < cap ? signed : cap;
    if (amount === 0n) throw new Skip("below-minimum");
    if (kind === "exact" && amount < BigInt(entry.minAmount ?? "1")) throw new Skip("below-minimum");
    if (kind === "exact" && amount < signed) throw new Skip("amount-changed");
    return { kind, amount, fund: canonicalAccount(info.fund), asset: canonicalAccount(accepted.asset), entry, channel };
  }

  private record(
    info: SolidarityInfo,
    c: Awaited<ReturnType<SolidarityLog["check"]>>,
    period: string,
  ): ShareRecord {
    const id = info.id as string;
    const line = formatLine({ period, fund: c.fund, asset: c.asset, id, amount: c.amount });
    const rec: ShareRecord = { id, kind: c.kind, period, fund: c.fund, asset: c.asset, amount: c.amount, state: "queued", line };
    if (c.kind === "exact") {
      rec.exact = { accepted: (info.payment as NonNullable<SolidarityInfo["payment"]>).accepted, payload: (info.payment as NonNullable<SolidarityInfo["payment"]>).payload as unknown as ExactEip3009Payload };
    } else {
      const ch = c.channel as NonNullable<typeof c.channel>;
      let cr = this.channels.get(ch.id);
      if (!cr) {
        cr = { channelId: ch.id, config: ch.config, fund: c.fund, asset: c.asset, charged: ch.charged, claimedByLog: ch.charged, shares: [] };
        this.channels.set(ch.id, cr);
      }
      rec.batch = { channelId: ch.id, from: cr.charged, to: cr.charged + c.amount };
      cr.charged += c.amount;
      cr.latestVoucher = ch.voucher;
      cr.shares.push(id);
    }
    this.shares.set(id, rec);
    return rec;
  }

  private snapshot(channelId: string): ChannelSnapshot | undefined {
    const cid = channelId.toLowerCase();
    const state = this.chain.channelState(cid);
    const known = this.channels.get(cid);
    if (!state && !known) return undefined;
    return {
      channelId: cid,
      balance: (state?.balance ?? 0n).toString(),
      totalClaimed: (state?.totalClaimed ?? 0n).toString(),
      withdrawRequestedAt: state?.withdrawRequestedAt ?? 0,
      refundNonce: (state?.refundNonce ?? 0n).toString(),
      chargedCumulativeAmount: (known?.charged ?? state?.totalClaimed ?? 0n).toString(),
    };
  }

  private async submitExact(rec: ShareRecord): Promise<void> {
    const ex = rec.exact as NonNullable<ShareRecord["exact"]>;
    try {
      const r = await this.chain.submitExact(ex.accepted, ex.payload);
      if (r.ok) {
        ex.transaction = r.transaction;
        rec.state = "collected";
        this.addSettlement(rec.period, formatSettlement({ fund: rec.fund, asset: rec.asset, ref: `exact:${r.transaction}`, amount: rec.amount }));
      } else {
        // Spec choice: "uncollected" is defined for batch-settlement only; an accepted exact
        // share whose transfer fails is treated the same way (left out of the batch).
        ex.error = r.error;
        rec.state = "uncollected";
      }
    } catch (e) {
      ex.error = (e as Error).message;
      rec.state = "uncollected";
    }
  }

  private addSettlement(period: string, entry: string): void {
    this.book.addSettlement(period, entry);
  }

  // ---- batch-settlement claims -------------------------------------------------

  /**
   * Claim every channel's outstanding share vouchers, up to the charged
   * cumulative amount the log has recorded. Each increase in totalClaimed is
   * attributed to the periods of the shares it covers; a claim that covers two
   * periods is split. Shares the channel can no longer pay are uncollected.
   */
  async claimOutstanding(only?: string): Promise<void> {
    for (const cr of this.channels.values()) {
      if (only && cr.channelId !== only.toLowerCase()) continue;
      await this.withChannelLock(cr.channelId, () => this.claimChannel(cr));
    }
  }

  /** "The log MUST claim outstanding share vouchers when it sees a withdrawal initiated." */
  async onWithdrawalInitiated(channelId: string): Promise<void> {
    await this.claimOutstanding(channelId);
  }

  private async claimChannel(cr: ChannelRecord): Promise<void> {
    if (cr.charged <= cr.claimedByLog || !cr.latestVoucher) return;
    const state = this.chain.channelState(cr.channelId);
    const claimable = state ? state.balance : 0n;
    // Claim whole shares only, up to what the channel can still pay.
    let target = cr.claimedByLog;
    const covered: ShareRecord[] = [];
    for (const id of cr.shares) {
      const rec = this.shares.get(id) as ShareRecord;
      const b = rec.batch as NonNullable<ShareRecord["batch"]>;
      if (b.to <= cr.claimedByLog || rec.state !== "queued") continue;
      if (b.to <= claimable && b.from === target) {
        target = b.to;
        covered.push(rec);
      } else {
        rec.state = "uncollected";
      }
    }
    if (target === cr.claimedByLog) return;
    const r = await this.chain.claim(cr.channelId, cr.latestVoucher, target);
    if (!r.ok) {
      for (const rec of covered) rec.state = "uncollected";
      return;
    }
    const byPeriod = new Map<string, bigint>();
    for (const rec of covered) {
      rec.state = "collected";
      byPeriod.set(rec.period, (byPeriod.get(rec.period) ?? 0n) + rec.amount);
    }
    for (const [period, amount] of byPeriod) {
      this.addSettlement(period, formatSettlement({ fund: cr.fund, asset: cr.asset, ref: `claim:${r.transaction}:${cr.channelId}`, amount }));
    }
    cr.claimedByLog = target;
  }

  // ---- month close -------------------------------------------------------------------

  /**
   * Close period P: claim outstanding vouchers, leave out uncollected shares,
   * build the batch and settlements file, and sign a statement whose
   * `previous` is the hash of the previous period's payload.
   */
  async closePeriod(period: string, issuedAt?: number): Promise<PublishedStatement> {
    const now = this.clock();
    if (period >= periodOf(now)) throw new Error(`cannot close ${period} before it ends`);
    const next = this.book.nextToClose;
    if (next && period !== next) throw new Error(`the next statement must be for ${next}`);
    await this.claimOutstanding();
    const inPeriod = [...this.shares.values()].filter((s) => s.period === period);
    if (inPeriod.some((s) => s.state === "queued")) throw new Error(`unresolved shares in ${period}`);
    // Uncollected shares are removed before the tree is built.
    const lines = inPeriod.filter((s) => s.state === "collected").map((s) => s.line);
    return this.book.close(period, lines, issuedAt ?? Math.max(now, periodStart(nextPeriod(period))));
  }

  /** Attach a witness or fund cosignature to a published statement. */
  addCosignature(period: string, cosignature: JwsEnvelope): void {
    this.book.addCosignature(period, cosignature);
  }

  /** The five read endpoints under the log's URL ("", "/statements/<p>", "/lines/<p>", "/settlements/<p>", "/proofs/<id>"). */
  handle(path: string): { status: number; contentType: string; body: string } {
    return this.book.serve(path, (id) => this.proof(id));
  }

  private proof(id: string): ProofResult {
    const rec = this.shares.get(id);
    if (!rec) {
      const held = [...this.pending.values()].some((p) => p.id === id);
      return held ? [200, { status: "queued" }] : [404, { error: "not found" }];
    }
    if (rec.state === "uncollected") return [200, { status: "uncollected" }];
    return (rec.state === "collected" && this.book.included(rec.period, id)) || [200, { status: "queued" }];
  }

  /** Convenience for owners and tests: a full receipt for an included share. */
  receipt(id: string): Receipt | undefined {
    const rec = this.shares.get(id);
    return rec && rec.state === "collected" ? this.book.receipt(rec.period, id) : undefined;
  }

  /** Internal state, for tests and the examples. */
  inspect(id: string): Readonly<ShareRecord> | undefined {
    return this.shares.get(id);
  }
}

/**
 * The basis of a share: the amount the settle that carries the client's
 * PaymentPayload collected ("Purchases that can carry a share").
 */
export function purchaseBasis(
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
  settleResponse: SettleResponse,
): { ok: true; basis: bigint } | { ok: false } {
  const accepted = paymentPayload.accepted ?? requirements;
  const flow = resolveFlow(accepted);
  const ptype = (paymentPayload.payload as { type?: unknown } | undefined)?.type;
  if (ptype === "refund") return { ok: false };
  if (flow === "escrow") return { ok: false };
  const asInt = (v: unknown): bigint | undefined => (typeof v === "string" && /^[0-9]+$/.test(v) ? BigInt(v) : undefined);
  let basis: bigint | undefined;
  switch (accepted.scheme) {
    case "exact":
      if (flow === "authorization" || flow === "upfront") basis = asInt(accepted.amount);
      break;
    case "upto":
      if (flow === "authorization") basis = asInt(requirements.amount);
      break;
    case "batch-settlement":
      if (ptype === "voucher" || ptype === "deposit") basis = asInt(settleResponse.extra?.chargedAmount);
      break;
    case "auth-capture":
      if (flow === "authorization" && (ptype === undefined || ptype === "charge")) basis = asInt(settleResponse.amount) ?? asInt(requirements.amount);
      break;
  }
  return basis === undefined ? { ok: false } : { ok: true, basis };
}

/** A copy of the SettleResponse with the outcome added; core fields are copied untouched. */
export function withOutcome(settleResponse: SettleResponse, outcome: SolidarityOutcome): SettleResponse {
  const out: SettleResponse = { ...settleResponse, extensions: { ...(settleResponse.extensions ?? {}), [SOLIDARITY]: { info: outcome, schema: solidarityOutcomeSchema } } };
  for (const k of CORE_FIELDS) {
    if (k in settleResponse) (out as unknown as Record<string, unknown>)[k] = (settleResponse as unknown as Record<string, unknown>)[k];
  }
  return out;
}

/** Decode an EXTENSION-RESPONSES header value. */
export function decodeExtensionResponses(header: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

/** Checksummed fund address of a CAIP-10 account (display only). */
export const checksumFund = (fund: string): string => getAddress(parseCaip10(fund).address);
