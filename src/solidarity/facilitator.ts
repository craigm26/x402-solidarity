/**
 * Facilitator side: a solidarity log ("Facilitator behaviour", "Share kinds",
 * "Refunds"; and https://craigmerry.com/solidarity-levy/spec/attestation.md, "Publication" and
 * "Optional share kind: `batch-settlement`").
 *
 * - /verify is untouched: `onVerify` returns the purchase's VerifyResponse
 *   unchanged and has no side effects.
 * - The share is processed only after a settle listed in "Purchases that can
 *   carry a share" succeeds (`onSettled`). The outcome goes to the buyer in
 *   `SettleResponse.extensions.solidarity`; an optional `{status}` goes to the
 *   seller in EXTENSION-RESPONSES. Core SettleResponse fields never change.
 * - The log decides from checks it can make at once; an accepted `exact`
 *   share's transfer is submitted afterwards (`followUp`). It is collected
 *   once its authorization executes, and uncollected only once it can no
 *   longer execute (draft 3); until then it stays queued.
 * - `onSettled` is total: whatever is wrong with a share, it returns the
 *   purchase's SettleResponse with its core fields unchanged.
 * - Refunds: `keep` only in separate mode. Refund settles never trigger a
 *   share and never adjust one (`onPurchaseRefund`).
 * - Month close: claims, the batch, the settlements file and a JCS statement
 *   signed with the log's key and chained by `previous`.
 * - Retiring: stop accepting shares, resolve them all, then set `until` on
 *   the log's key after its final statement (`stopAccepting`, `retire`).
 */

import { getAddress } from "viem";
import { MAX_WITHDRAW_DELAY, MIN_WITHDRAW_DELAY, VALID_BEFORE_BUFFER_SECONDS, ZERO_ADDRESS } from "./constants.ts";
import { canonicalize } from "./jcs.ts";
import type { BatchVoucherPayload, ExactEip3009Payload, VoucherFields } from "./evm.ts";
import { computeChannelId, isBatchVoucherPayload, isExactEip3009Payload, verifyEip3009Signature, verifyVoucherSignature } from "./evm.ts";
import type { SigningKey } from "./ledger.ts";
import { formatLine, formatSettlement } from "./ledger.ts";
import type { LogBookOptions, ProofResult, RetireOptions } from "./book.ts";
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
  shareNonce,
} from "./utils.ts";

/** What the log needs from the chain. The offline simulation implements it; so would an RPC-backed one. */
export interface LogChain {
  /** Submit an accepted exact share's transferWithAuthorization. */
  submitExact(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<{ ok: true; transaction: string } | { ok: false; error: string }>;
  /** Current on-chain state of a batch-settlement channel, or undefined if it does not exist. */
  channelState(channelId: string): { balance: bigint; totalClaimed: bigint; withdrawRequestedAt: number; refundNonce: bigint } | undefined;
  /** Claim a channel up to `totalClaimed` with the payer's voucher. */
  claim(channelId: string, voucher: VoucherFields, totalClaimed: bigint): Promise<{ ok: true; transaction: string } | { ok: false; error: string }>;
  /**
   * Optional: the transaction that executed this EIP-3009 authorization, whoever submitted it, and
   * what it moved (a real chain reads the token's AuthorizationUsed and Transfer events). Without
   * it, a share whose authorization someone else executed first is never seen collected: it stays
   * queued (authorizationUsed says used), and is recorded late if this is added and finds it.
   */
  findExactTransfer?(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<{ transaction: string; token: string; to: string; value: bigint } | undefined>;
  /**
   * Optional: EIP-3009 `authorizationState(from, nonce)` of an exact share's authorization on its
   * token, at the latest block: true once it was used or cancelled. "A failed or unanswered
   * submit does not show" that a transfer never executed: the log reports an exact share
   * uncollected only once the chain, read at a block whose timestamp is at or after its
   * validBefore, shows that no transfer under the authorization executed ("Share kinds"): this
   * says false, or authorizationCanceled says true. Without it the log can never show that, so a
   * share whose transfer failed stays queued: closePeriod waits for it until the claim grace runs
   * out, then closes without it, and it is recorded late if it ever executes.
   */
  authorizationUsed?(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<boolean>;
  /**
   * Optional: whether the chain shows this authorization cancelled (EIP-3009 cancelAuthorization;
   * USDC emits AuthorizationCanceled(authorizer, nonce)). Match both: anyone can cancel the same
   * nonce under their own address, and a share's nonce is public. USDC's authorizationState reads true for a
   * cancelled authorization as for a used one, but a cancelled one never executed and never can,
   * so with this a cancelled share is uncollected as an unused one is ("Share kinds": "an
   * `AuthorizationCanceled` event for the payer's address and its nonce"). Without it, a
   * cancelled share stays queued.
   */
  authorizationCanceled?(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<boolean>;
  /**
   * Optional: the timestamp of the latest block, in Unix seconds. Block time decides whether an
   * exact share's validBefore has passed ("Share kinds"): the log reads this first, and reads
   * authorizationUsed and authorizationCanceled only once it is at or after validBefore, so they
   * must read the chain at that block or a later one. Without it the log cannot show that a
   * block at or after validBefore exists, so it never reports an exact share uncollected: the
   * share stays queued, as without authorizationUsed. A LogChain that supplies authorizationUsed
   * should supply this too. It is given the share being looked at, which a chain that reads the
   * latest block ignores, and a chain that answers from its own records (a journal replayed on
   * restart) uses to answer for that share.
   */
  blockTime?(accepted?: PaymentRequirements, payload?: ExactEip3009Payload): Promise<number>;
  /**
   * Optional: check an `exact` share with the facilitator's own scheme code, "as /verify and
   * /settle would", with paymentPayload {x402Version: 2, accepted, payload} and
   * paymentRequirements `accepted` (solidarity.md, "`PaymentRequired` and `PaymentPayload`").
   * When present it replaces the offline EOA signature check, so smart-wallet signatures
   * (ERC-1271, ERC-6492), the payer's balance and the nonce are checked as the scheme checks
   * them. A thrown error skips the share with `bad-payment`; it never touches the purchase.
   */
  verifyExact?(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<{ ok: true } | { ok: false; error: string }>;
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
  /** `inFlight` while a submit or a look at the chain runs, so a second one never starts beside it. */
  exact?: { accepted: PaymentRequirements; payload: ExactEip3009Payload; transaction?: string; error?: string; inFlight?: boolean };
  batch?: { channelId: string; from: bigint; to: bigint };
}

interface ChannelRecord {
  channelId: string;
  config: BatchVoucherPayload["channelConfig"];
  fund: string;
  asset: string;
  /** chargedCumulativeAmount: the voucher base. It moves by what each share signed. */
  charged: bigint;
  /** Where the next share's recorded amount starts: claims go up to these positions, never to `charged`. */
  recorded: bigint;
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
  /**
   * How long after a period ends the log keeps retrying failed claims before it closes the period
   * anyway, with those shares uncollected. Default 14 days: draft 3 says that while a claim covering
   * a share of P fails and the channel can still pay, a log SHOULD keep retrying it and SHOULD NOT
   * issue P's statement, until 14 days after P ends, so the statement can still appear within the
   * 15 days of "Statements" (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Optional share kind: `batch-settlement`").
   * An exact share whose transfer is not final holds P's statement back as long, then P closes
   * without it, still queued (attestation.md, "Accepted and uncollected shares").
   */
  claimGraceSeconds?: number;
  /**
   * Stores each statement durably before it is published or sent to a witness or the fund (see
   * LogBookOptions.persist). Without it, keeping the statement (or `issuedAt` with every other
   * input) before publishing it is the caller's job.
   */
  persistStatement?: LogBookOptions["persist"];
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
  private readonly claimGraceSeconds: number;
  private acceptingShares = true;

  private readonly shares = new Map<string, ShareRecord>();
  private readonly reserved = new Set<string>();
  private readonly channels = new Map<string, ChannelRecord>();
  private readonly channelLocks = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, PendingPurchase>();
  readonly book: LogBook;

  constructor(opts: SolidarityLogOptions) {
    this.descriptor = opts.descriptor;
    this.clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
    this.book = new LogBook(opts.descriptor, opts.key, { persist: opts.persistStatement, clock: this.clock });
    this.chain = opts.chain;
    this.claimGraceSeconds = opts.claimGraceSeconds ?? 14 * 86400;
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
   *
   * If the settle's response was lost, the log MAY treat it as succeeded once
   * the chain shows the purchase collected ("Facilitator behaviour", step 2):
   * pass a SettleResponse built from the chain (success, its transaction, and
   * the amount collected, which is the basis). Every check still applies, so a
   * share whose validBefore is too close is skipped, and the buyer learns the
   * outcome from /proofs/<id>.
   *
   * Once the log has stopped accepting shares (retiring), the purchase's
   * response passes through with no outcome, as from a facilitator without
   * the extension.
   */
  async onSettled(paymentPayload: PaymentPayload, requirements: PaymentRequirements, settleResponse: SettleResponse): Promise<SettledResult> {
    if (!this.acceptingShares) return { settleResponse, followUp: Promise.resolve() };
    let info: SolidarityInfo | undefined;
    try {
      info = extractSolidarity(paymentPayload);
    } catch {
      info = undefined;
    }
    if (!info || info.payment === undefined) return { settleResponse, followUp: Promise.resolve() };

    let outcome: SolidarityOutcome;
    let followUp: Promise<void> = Promise.resolve();
    const base = this.baseOutcome(info);
    try {
      const r = await this.decide(info, paymentPayload, requirements, settleResponse);
      outcome = r.outcome;
      followUp = r.followUp;
    } catch {
      // A share never blocks or changes the purchase: anything unexpected about it is a
      // malformed share, and the purchase's response goes back with its core fields intact.
      outcome = this.withChannel({ ...base, status: "skipped", reason: "bad-payment" }, info);
    }

    const out = withOutcome(settleResponse, outcome);
    return {
      settleResponse: out,
      outcome,
      extensionResponses: Buffer.from(JSON.stringify({ [SOLIDARITY]: { status: outcome.status } })).toString("base64"),
      followUp,
    };
  }

  private async decide(
    info: SolidarityInfo,
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    settleResponse: SettleResponse,
  ): Promise<{ outcome: SolidarityOutcome; followUp: Promise<void> }> {
    let outcome: SolidarityOutcome;
    let followUp: Promise<void> = Promise.resolve();
    const base = this.baseOutcome(info);

    const basis = purchaseBasis(paymentPayload, requirements, settleResponse);
    if (!basis.ok) {
      // "Purchases that can carry a share": a share on a refund payload, an escrow flow, a
      // batch-settlement purchase or any other scheme "is skipped with purchase-not-supported".
      outcome = this.withChannel({ ...base, status: "skipped", reason: "purchase-not-supported" }, info);
    } else if (!settleResponse.success && settleResponse.errorReason === "settlement_pending" && settleResponse.transaction && shareScheme(info) !== "exact") {
      // Only exact shares are held for a pending purchase. A held voucher would be signed on the
      // same chargedCumulativeAmount as the client's next one, so it is skipped at once and
      // nothing is charged; the client leaves its channel state as it was.
      outcome = this.withChannel({ ...base, status: "skipped", reason: "purchase-not-final" }, info);
    } else if (!settleResponse.success && settleResponse.errorReason === "settlement_pending" && settleResponse.transaction) {
      // The share is only held here ("Purchases that can carry a share"): its checks run when the
      // purchase confirms (resolvePending), as if its settle had just succeeded, and its period is
      // the month in which it is accepted then.
      const id = isValidShareId(info.id) && !this.shares.has(info.id) && !this.reserved.has(info.id) ? info.id : undefined;
      if (id) {
        this.reserved.add(id);
        this.pending.set(settleResponse.transaction, { paymentPayload, requirements, settleResponse, id });
        outcome = { ...base, status: "pending" };
      } else {
        outcome = { ...base, status: "skipped", reason: isValidShareId(info.id) ? "duplicate" : "bad-payment" };
      }
    } else if (!settleResponse.success) {
      outcome = this.withChannel({ ...base, status: "skipped", reason: "purchase-not-final" }, info);
    } else {
      const r = await this.process(info, paymentPayload, requirements, basis.basis);
      outcome = r.outcome;
      followUp = r.followUp;
    }
    return { outcome, followUp };
  }

  /**
   * A `settlement_pending` purchase was resolved. If it confirmed, the held
   * share is processed now, as if its settle had just succeeded: its checks
   * run now, and its period is the month in which it is accepted now
   * ("Purchases that can carry a share";
   * https://craigmerry.com/solidarity-levy/spec/attestation.md, "Accepted and uncollected shares"). If it
   * failed, the share is dropped. The buyer already has its response, so the
   * result is visible through /proofs/<id>. A share held before the log
   * stopped accepting shares is still processed.
   */
  async resolvePending(transaction: string, confirmed: boolean, finalResponse?: SettleResponse): Promise<{ outcome: SolidarityOutcome; followUp: Promise<void> } | undefined> {
    const p = this.pending.get(transaction);
    if (!p) return undefined;
    this.pending.delete(transaction);
    this.reserved.delete(p.id);
    const info = extractSolidarity(p.paymentPayload) as SolidarityInfo;
    if (!confirmed) return { outcome: { ...this.baseOutcome(info), status: "skipped", reason: "purchase-not-final" }, followUp: Promise.resolve() };
    try {
      const sr = finalResponse ?? { ...p.settleResponse, success: true, errorReason: undefined };
      const basis = purchaseBasis(p.paymentPayload, p.requirements, sr);
      if (!basis.ok) return { outcome: { ...this.baseOutcome(info), status: "skipped", reason: "purchase-not-supported" }, followUp: Promise.resolve() };
      return await this.process(info, p.paymentPayload, p.requirements, basis.basis);
    } catch {
      return { outcome: { ...this.baseOutcome(info), status: "skipped", reason: "bad-payment" }, followUp: Promise.resolve() };
    }
  }

  /**
   * Refunds never adjust a share in separate mode: a share is a final gift
   * (`keep`), the client has no reliable way to learn of a refund, and a
   * closed batch is never edited. Returned for the caller's records.
   */
  onPurchaseRefund(_refund: { transaction?: string; amount?: string }): { adjusted: false; rule: "keep" } {
    return { adjusted: false, rule: "keep" };
  }

  /**
   * Adds the channel snapshot to a skip decided before the share's checks ran:
   * "Every solidarity response for a `batch-settlement` share, skipped or not,
   * carries `channel` whenever the log can identify the channel"
   * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Optional share kind: `batch-settlement`").
   * The voucher is never returned here: only a cumulative-mismatch carries it.
   */
  private withChannel(outcome: SolidarityOutcome, info: SolidarityInfo): SolidarityOutcome {
    try {
      const cid = voucherChannelId(info);
      const snap = cid ? this.snapshot(cid) : undefined;
      if (snap) outcome.channel = snap;
    } catch {
      // The snapshot is best effort; the skip stands without it.
    }
    return outcome;
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
    const channelId = voucherChannelId(info);

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
        let followUp: Promise<void> = Promise.resolve();
        if (rec.batch) {
          outcome.channel = this.snapshot(rec.batch.channelId);
          // "The log MUST claim outstanding share vouchers ... before the withdrawal delay elapses":
          // a share accepted while a withdrawal is pending is claimed at once.
          if ((this.chain.channelState(rec.batch.channelId)?.withdrawRequestedAt ?? 0) !== 0) {
            followUp = this.claimOutstanding(rec.batch.channelId).catch(() => undefined);
          }
        } else if (rec.kind === "exact") {
          followUp = this.submitExact(rec);
        }
        return { outcome, followUp };
      } catch (e) {
        if (!(e instanceof Skip)) throw e;
        const outcome: SolidarityOutcome = { ...base, status: "skipped", reason: e.reason };
        if (channelId) {
          // The last voucher goes back only with a cumulative-mismatch, whose voucher verified for
          // the channel, so the client can resync (as with the binding's Corrective 402).
          const snap = this.snapshot(channelId, e.reason === "cumulative-mismatch");
          if (snap) outcome.channel = snap;
        }
        return { outcome, followUp: Promise.resolve() };
      } finally {
        if (reservedId) this.reserved.delete(reservedId);
      }
    };

    // Serialize processing per channel (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Optional share kind: `batch-settlement`": "The log MUST serialize processing per channel").
    if (channelId) return this.withChannelLock(channelId.toLowerCase(), run);
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
  ): Promise<{ kind: ShareKind; amount: bigint; signed: bigint; fund: string; asset: string; entry: DescriptorAccept; channel?: { id: string; voucher: VoucherFields; config: BatchVoucherPayload["channelConfig"]; charged: bigint } }> {
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

    // `accepted.maxTimeoutSeconds` and `accepted.extra` equal that descriptor entry's.
    if (accepted.maxTimeoutSeconds !== entry.maxTimeoutSeconds || !sameExtra(accepted.extra, entry.extra)) {
      throw new Skip("bad-payment", "terms differ from the descriptor entry");
    }

    // "`rate`, if it is a decimal string (digits, optionally a point and more digits), is at most 0.01";
    // a rate in any other form fails the schema.
    if (typeof info.rate !== "string" || !RATE_PATTERN.test(info.rate)) {
      if (isDecimal(info.rate) && compareDecimal(info.rate, "0.01") > 0) throw new Skip("over-rate");
      throw new Skip("bad-payment", "rate is not a canonical decimal from 0.000001 to 0.01");
    }

    // The info validates against the schema (the id's form included).
    if (!isValidShareId(info.id)) throw new Skip("bad-payment", "id");
    if (validateSchema(solidaritySchema, info).length > 0) throw new Skip("bad-payment", "schema");

    // "`id` is not that of a share this log has accepted, holds as `pending` or is processing":
    // a share skipped for a reason the client can fix may be retried with the same id.
    if (this.shares.has(info.id) || this.reserved.has(info.id)) throw new Skip("duplicate");
    reserve(info.id);
    this.reserved.add(info.id);

    // The share verifies under its scheme.
    let channel: { id: string; voucher: VoucherFields; config: BatchVoucherPayload["channelConfig"]; charged: bigint } | undefined;
    const now = this.clock();
    if (kind === "exact") {
      const p = payment.payload;
      if (!isExactEip3009Payload(p)) throw new Skip("bad-payment", "not an EIP-3009 payload");
      if (!sameAccount(p.authorization.to, accepted.payTo)) throw new Skip("bad-payment", "authorization.to");
      if (BigInt(p.authorization.value) !== BigInt(accepted.amount)) throw new Skip("bad-payment", "authorization.value");
      // The nonce binds the id, so a relaying seller cannot record the share under another id.
      if (p.authorization.nonce.toLowerCase() !== shareNonce(info.id)) throw new Skip("bad-payment", "nonce does not match the id");
      if (BigInt(p.authorization.validAfter) > BigInt(now)) throw new Skip("bad-payment", "validAfter in the future");
      if (BigInt(p.authorization.validBefore) < BigInt(now + VALID_BEFORE_BUFFER_SECONDS)) throw new Skip("bad-payment", "validBefore passed");
      // "its validBefore is at most the purchase's maxTimeoutSeconds plus twice the share's after
      // the time the log checks it": an accepted exact share can execute only for a short time, so
      // it is collected or uncollected soon after, and never holds a statement or retiring back.
      if (typeof purchase.maxTimeoutSeconds !== "number" || !Number.isSafeInteger(purchase.maxTimeoutSeconds) || purchase.maxTimeoutSeconds < 0) {
        throw new Skip("bad-payment", "the purchase has no maxTimeoutSeconds");
      }
      const latest = BigInt(now) + BigInt(purchase.maxTimeoutSeconds) + 2n * BigInt(accepted.maxTimeoutSeconds);
      if (BigInt(p.authorization.validBefore) > latest) throw new Skip("bad-payment", "validBefore is too far ahead");
      // The EIP-712 domain comes from the descriptor entry's extra (checked equal above).
      // With the facilitator's scheme code (verifyExact), the share is checked as /verify would
      // check it; without it, offline, which covers EOA signatures only.
      if (this.chain.verifyExact) {
        let v: { ok: true } | { ok: false; error: string };
        try {
          v = await this.chain.verifyExact({ ...accepted, extra: entry.extra }, p);
        } catch (e) {
          throw new Skip("bad-payment", `scheme verify failed: ${(e as Error)?.message ?? String(e)}`);
        }
        if (!v.ok) throw new Skip("bad-payment", `scheme verify: ${v.error}`);
      } else if (!(await verifyEip3009Signature({ ...accepted, extra: entry.extra }, p))) {
        throw new Skip("bad-payment", "signature");
      }
    } else {
      const p = payment.payload;
      if (!isBatchVoucherPayload(p)) throw new Skip("bad-payment", "not a voucher payload");
      const c = p.channelConfig;
      const cid = p.voucher.channelId.toLowerCase();
      // The binding's verification rules 1 to 5, against the descriptor entry. The delay is
      // checked first so no out-of-range value ever reaches the EIP-712 hash.
      if (c.withdrawDelay !== entry.extra?.withdrawDelay || c.withdrawDelay < MIN_WITHDRAW_DELAY || c.withdrawDelay > MAX_WITHDRAW_DELAY) {
        throw new Skip("bad-payment", "withdrawDelay");
      }
      if (computeChannelId(c, accepted.network).toLowerCase() !== cid) throw new Skip("bad-payment", "channel id");
      if (!sameAccount(c.receiver, accepted.payTo)) throw new Skip("bad-payment", "receiver is not the fund");
      const auth = entry.extra?.receiverAuthorizer;
      if (typeof auth !== "string" || !sameAccount(c.receiverAuthorizer, auth)) throw new Skip("bad-payment", "receiverAuthorizer");
      if (!sameAccount(c.token, accepted.asset)) throw new Skip("bad-payment", "token");
      // An implementation limit, not a spec rule: with payerAuthorizer = 0 the contract checks the
      // payer's signature with EIP-1271 when the payer has code, which this offline check cannot do,
      // so a voucher that looks valid here could make every claim revert. Such channels are refused.
      if (sameAccount(c.payerAuthorizer, ZERO_ADDRESS)) throw new Skip("bad-payment", "payerAuthorizer is zero");
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
    return { kind, amount, signed, fund: canonicalAccount(info.fund), asset: canonicalAccount(accepted.asset), entry, channel };
  }

  private record(
    info: SolidarityInfo,
    c: Awaited<ReturnType<SolidarityLog["check"]>>,
    period: string,
  ): ShareRecord {
    const id = info.id as string;
    const line = formatLine({ period, fund: c.fund, asset: c.asset, id, amount: c.amount });
    const rec: ShareRecord = { id, kind: c.kind, period, fund: c.fund, asset: c.asset, amount: c.amount, state: "queued", line };
    this.book.markActive(period);
    if (c.kind === "exact") {
      rec.exact = { accepted: (info.payment as NonNullable<SolidarityInfo["payment"]>).accepted, payload: (info.payment as NonNullable<SolidarityInfo["payment"]>).payload as unknown as ExactEip3009Payload };
    } else {
      const ch = c.channel as NonNullable<typeof c.channel>;
      let cr = this.channels.get(ch.id);
      if (!cr) {
        cr = { channelId: ch.id, config: ch.config, fund: c.fund, asset: c.asset, charged: ch.charged, recorded: ch.charged, claimedByLog: ch.charged, shares: [] };
        this.channels.set(ch.id, cr);
      }
      rec.batch = { channelId: ch.id, from: cr.recorded, to: cr.recorded + c.amount };
      cr.recorded += c.amount;
      // The voucher base moves by the full amount the payer signed, even when less is recorded
      // (an upto purchase that settled lower). Each voucher then backs exactly one share, and no
      // signed headroom is left for another share, under another id, to spend. The difference is
      // never claimed; it stays in the payer's unspent deposit.
      cr.charged += c.signed;
      cr.latestVoucher = ch.voucher;
      cr.shares.push(id);
    }
    this.shares.set(id, rec);
    return rec;
  }

  private snapshot(channelId: string, withVoucher = false): ChannelSnapshot | undefined {
    const cid = channelId.toLowerCase();
    const state = this.chain.channelState(cid);
    const known = this.channels.get(cid);
    if (!state && !known) return undefined;
    const snap: ChannelSnapshot = {
      channelId: cid,
      balance: (state?.balance ?? 0n).toString(),
      totalClaimed: (state?.totalClaimed ?? 0n).toString(),
      withdrawRequestedAt: state?.withdrawRequestedAt ?? 0,
      refundNonce: (state?.refundNonce ?? 0n).toString(),
      chargedCumulativeAmount: (known?.charged ?? state?.totalClaimed ?? 0n).toString(),
    };
    // The last voucher the log holds, so a client can resync after a cumulative-mismatch
    // (the binding's Corrective 402 carries the same pair in extra.voucherState). Only then.
    if (withVoucher && known?.latestVoucher) {
      snap.signedMaxClaimable = known.latestVoucher.maxClaimableAmount;
      snap.signature = known.latestVoucher.signature;
    }
    return snap;
  }

  /**
   * The follow-up of an accepted exact share: submit its transfer. It is
   * collected once its authorization has executed and paid the fund, whoever
   * submitted it. A failed or unanswered submit does not make it uncollected
   * ("Share kinds", draft 3): only once its validBefore has passed and the
   * chain shows the authorization unused. Until then it stays queued, and
   * closePeriod or reconcileExact looks again.
   */
  private async submitExact(rec: ShareRecord): Promise<void> {
    const ex = rec.exact as NonNullable<ShareRecord["exact"]>;
    if (ex.inFlight) return;
    ex.inFlight = true;
    try {
      const r = await this.chain.submitExact(ex.accepted, ex.payload);
      if (r.ok) {
        this.collectExact(rec, r.transaction);
        return;
      }
      ex.error = r.error;
      await this.readExactFromChain(rec);
    } catch (e) {
      // Nothing is concluded from an error: the share stays as it was, queued.
      ex.error = (e as Error)?.message ?? String(e);
    } finally {
      ex.inFlight = false;
    }
  }

  /**
   * After a submit failed, or when the log looks again: what the chain says.
   * Executed (by anyone: the relaying seller can submit it first) and paid the
   * fund the share's amount: collected, with that transaction as its
   * reference. Can no longer execute: uncollected. Anything else: unchanged.
   */
  private async readExactFromChain(rec: ShareRecord): Promise<void> {
    const ex = rec.exact as NonNullable<ShareRecord["exact"]>;
    const transaction = await this.executedElsewhere(ex, rec.amount);
    if (transaction) this.collectExact(rec, transaction);
    else if (rec.state === "queued" && (await this.cannotExecute(ex))) rec.state = "uncollected";
  }

  private async executedElsewhere(ex: NonNullable<ShareRecord["exact"]>, amount: bigint): Promise<string | undefined> {
    const t = await this.chain.findExactTransfer?.(ex.accepted, ex.payload);
    if (!t || !sameAccount(t.token, ex.accepted.asset) || !sameAccount(t.to, ex.accepted.payTo) || t.value !== amount) return undefined;
    return t.transaction;
  }

  /**
   * "If the transfer never executes (expired, cancelled, or the balance was
   * too low), the share is uncollected", but the log "MUST NOT report the
   * share uncollected until the chain, read at a block whose timestamp is at
   * or after validBefore, shows that no transfer under the authorization
   * executed (EIP-3009 authorizationState false, or an AuthorizationCanceled
   * event for the payer's address and its nonce)" ("Share kinds"). The
   * latest block's time is read first (LogChain.blockTime), so the state read
   * after it is at that block or a later one. Without blockTime nothing shows
   * such a block, so the share stays queued.
   */
  private async cannotExecute(ex: NonNullable<ShareRecord["exact"]>): Promise<boolean> {
    if (!this.chain.authorizationUsed) return false;
    let validBefore: bigint;
    try {
      validBefore = BigInt(ex.payload.authorization.validBefore);
    } catch {
      return false;
    }
    if (BigInt(this.clock()) < validBefore) return false;
    // "Block time decides, not the log's clock": without blockTime, no block is known to be past validBefore.
    if (!this.chain.blockTime) return false;
    if (BigInt(await this.chain.blockTime(ex.accepted, ex.payload)) < validBefore) return false;
    if ((await this.chain.authorizationUsed(ex.accepted, ex.payload)) === false) return true;
    return (await this.chain.authorizationCanceled?.(ex.accepted, ex.payload)) === true;
  }

  /**
   * The share is collected, with `transaction` as its settlement reference: in
   * its own period while that is open. A share the log reported uncollected,
   * or one its period's statement went out without (or is being stored
   * without), is recorded late instead: in the period in which the log sees it
   * executed, with the amount it accepted
   * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Accepted and uncollected shares"; "Lines", `period`).
   * /proofs/<id> follows the new line.
   */
  private collectExact(rec: ShareRecord, transaction: string): void {
    const ex = rec.exact as NonNullable<ShareRecord["exact"]>;
    const late = rec.state === "uncollected" || this.book.sealed(rec.period);
    const period = late ? periodOf(this.clock()) : rec.period;
    // Written first: if the period is closed (a clock that ran backwards), nothing changes.
    this.book.addSettlement(period, formatSettlement({ fund: rec.fund, asset: rec.asset, ref: `exact:${transaction}`, amount: rec.amount }));
    if (late) {
      rec.period = period;
      rec.line = formatLine({ period, fund: rec.fund, asset: rec.asset, id: rec.id, amount: rec.amount });
    }
    ex.transaction = transaction;
    rec.state = "collected";
  }

  /**
   * Look again at one exact share that is queued or was reported uncollected.
   * A queued one still valid and unused is submitted again. A retired log
   * looks no more: it issues no statement after its final one, so it could
   * not record a share late (it resolved every share before retiring).
   */
  private async recheckExact(rec: ShareRecord): Promise<void> {
    const ex = rec.exact;
    if (!ex || ex.inFlight || rec.state === "collected" || this.book.retired) return;
    ex.inFlight = true;
    try {
      await this.readExactFromChain(rec);
      if (rec.state !== "queued") return;
      if (BigInt(this.clock()) >= BigInt(ex.payload.authorization.validBefore)) return;
      const r = await this.chain.submitExact(ex.accepted, ex.payload);
      if (r.ok) this.collectExact(rec, r.transaction);
      else ex.error = r.error;
    } catch (e) {
      ex.error = (e as Error)?.message ?? String(e);
    } finally {
      ex.inFlight = false;
    }
  }

  /**
   * Look again at every exact share that is not collected
   * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Accepted and uncollected shares"). A queued share is
   * collected if its authorization executed, uncollected once it can no longer
   * execute, and submitted again while it is still valid and unused. A share
   * the log reported uncollected whose transfer it now sees executed (its view
   * of the chain was behind) is recorded late, in the current period. Shares
   * whose submit is still running are left to it. closePeriod looks at the
   * queued ones itself; call this from a timer for the rest.
   */
  async reconcileExact(): Promise<void> {
    for (const rec of [...this.shares.values()]) if (rec.kind === "exact") await this.recheckExact(rec);
  }

  private addSettlement(period: string, entry: string): void {
    this.book.addSettlement(period, entry);
  }

  // ---- batch-settlement claims -------------------------------------------------

  /**
   * Claim every channel's outstanding share vouchers, up to a charged
   * cumulative amount the log has recorded. Each share is attributed its own
   * amount in its own period; a claim that covers two periods is split. A
   * claim that fails while the channel can pay is retried later (its shares
   * stay queued). Shares the channel can no longer pay are uncollected, and
   * the log lowers its charged cumulative amount to what it can still collect.
   */
  async claimOutstanding(only?: string): Promise<void> {
    for (const cr of this.channels.values()) {
      if (only && cr.channelId !== only.toLowerCase()) continue;
      await this.withChannelLock(cr.channelId, () => this.claimChannel(cr));
    }
  }

  /** "The log MUST claim outstanding share vouchers when it sees a withdrawal initiated, ..." */
  async onWithdrawalInitiated(channelId: string): Promise<void> {
    await this.claimOutstanding(channelId);
  }

  private async claimChannel(cr: ChannelRecord): Promise<void> {
    const queued = cr.shares.map((id) => this.shares.get(id) as ShareRecord).filter((r) => r.state === "queued");
    if (queued.length === 0 || !cr.latestVoucher) return;
    const state = this.chain.channelState(cr.channelId);
    const batchOf = (r: ShareRecord) => r.batch as NonNullable<ShareRecord["batch"]>;

    // An increase in totalClaimed the log did not make (the binding lets the receiver, the
    // fund, call claim itself) is unattributed: the shares it covers are uncollected.
    const onChain = state?.totalClaimed ?? 0n;
    if (onChain > cr.claimedByLog) {
      for (const rec of queued) if (batchOf(rec).from < onChain) rec.state = "uncollected";
      cr.claimedByLog = onChain;
      if (cr.recorded < onChain) cr.recorded = onChain;
      if (cr.charged < onChain) cr.charged = onChain; // a voucher can only build on what is claimed
    }

    // Shares the channel can no longer pay are uncollected. They are the last ones in charge
    // order, so the log lowers its charged amount to the end of what it can still collect and
    // the client's next voucher resyncs through a cumulative-mismatch.
    const balance = state ? state.balance : 0n;
    const covered: ShareRecord[] = [];
    let lost = false;
    for (const rec of queued) {
      if (rec.state !== "queued") continue;
      if (batchOf(rec).to <= balance) covered.push(rec);
      else {
        rec.state = "uncollected";
        lost = true;
      }
    }
    const target = covered.reduce((t, r) => (batchOf(r).to > t ? batchOf(r).to : t), cr.claimedByLog);
    if (lost) {
      cr.recorded = target;
      cr.charged = target;
    }
    if (covered.length === 0 || target === cr.claimedByLog) return;

    const r = await this.chain.claim(cr.channelId, cr.latestVoucher, target);
    // A failed claim on a channel that can still pay is retried at the next claim or at close;
    // its shares stay queued until the claim grace runs out (see closePeriod).
    if (!r.ok) return;
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
   * Close period P: claim outstanding vouchers, look again at exact shares
   * whose transfer is not final, leave out uncollected shares, build the batch
   * and settlements file, and sign a statement whose `previous` is the hash of
   * the previous period's payload.
   *
   * While a claim keeps failing, or an exact share's transfer is not final,
   * closing refuses (try again) until the claim grace after P ends has run
   * out: 14 days by default, so the statement can still appear within the 15
   * days of https://craigmerry.com/solidarity-levy/spec/attestation.md, "Statements". Then a batch-settlement share still queued is
   * uncollected, and so is every later share on its channel, since claims are
   * cumulative; the log lowers that channel's chargedCumulativeAmount to what
   * it has claimed, as for a channel that can no longer pay. An exact share
   * still queued is left out but never reported uncollected for that: it stays
   * queued (/proofs answers `queued` after the statement too), and is recorded
   * late if it executes, or uncollected once it can no longer execute
   * (reconcileExact; attestation.md, "Accepted and uncollected shares"). One
   * stuck share can then never hold back P's statement, or every statement
   * after it.
   *
   * The statement goes to `persistStatement`, which may return a promise, and
   * that write is awaited before P is closed and served.
   *
   * `opts.signed` is the statement this log signed for P before, for a log
   * that rebuilds itself from stored records: see LogBook.close. With it the
   * log's private key is not used, and the statement is byte for byte the
   * stored one, or closing throws and P stays open. A log issues one payload
   * per period, ever: a log that restarts closes P with its stored statement
   * (and the `issuedAt` it stored, or none to take the statement's own), never
   * a new one
   * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Statements"; `persistStatement`).
   */
  async closePeriod(period: string, issuedAt?: number, opts: { signed?: JwsEnvelope } = {}): Promise<PublishedStatement> {
    const now = this.clock();
    if (this.book.retired) throw new Error(`the log has retired: its final statement is for ${this.book.finalPeriod}`);
    if (period >= periodOf(now)) throw new Error(`cannot close ${period} before it ends`);
    const next = this.book.nextToClose;
    if (next && period !== next) throw new Error(`the next statement must be for ${next}`);
    await this.claimOutstanding();
    for (const rec of [...this.shares.values()]) if (rec.kind === "exact" && rec.state === "queued" && rec.period <= period) await this.recheckExact(rec);
    const inPeriod = [...this.shares.values()].filter((s) => s.period === period);
    const stuck = inPeriod.filter((s) => s.state === "queued");
    if (stuck.length > 0) {
      if (now < periodStart(nextPeriod(period)) + this.claimGraceSeconds) throw new Error(`unresolved shares in ${period} (a claim failed or a transfer is not final; try again)`);
      await this.giveUp(stuck);
    }
    // Uncollected shares are removed before the tree is built.
    const lines = inPeriod.filter((s) => s.state === "collected").map((s) => s.line);
    // Without `signed`, issuedAt is now: the time of the statement's first write. With it, the
    // stored statement's own issuedAt unless one is given.
    return this.book.closeAsync(period, lines, issuedAt ?? (opts.signed ? undefined : Math.max(now, periodStart(nextPeriod(period)))), opts.signed);
  }

  private async giveUp(stuck: ShareRecord[]): Promise<void> {
    for (const rec of stuck) {
      // An exact share whose transfer is not final is left out of the batch, still queued: it may
      // only be reported uncollected once it can no longer execute ("Share kinds").
      if (!rec.batch) continue;
      const cr = this.channels.get(rec.batch.channelId) as ChannelRecord;
      await this.withChannelLock(cr.channelId, async () => {
        for (const id of cr.shares) {
          const r = this.shares.get(id) as ShareRecord;
          if (r.state === "queued") r.state = "uncollected";
        }
        cr.recorded = cr.claimedByLog;
        cr.charged = cr.claimedByLog;
      });
    }
  }

  /** Attach a witness or fund cosignature to a published statement. */
  addCosignature(period: string, cosignature: JwsEnvelope): void {
    this.book.addCosignature(period, cosignature);
  }

  // ---- retiring ------------------------------------------------------------------------

  /** Does the log still accept shares? False once it stops, before it retires. */
  get accepting(): boolean {
    return this.acceptingShares;
  }

  /** Has the log retired (its descriptor lists no current key)? */
  get retired(): boolean {
    return this.book.retired;
  }

  /**
   * Step 1 of retiring (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Retiring a log"): the log accepts no more shares.
   * onSettled then passes a purchase's response through with no outcome, as a
   * facilitator without the extension does (the operator also removes
   * `solidarity` from /supported). A share already held for a
   * settlement_pending purchase is still processed when the purchase resolves.
   */
  stopAccepting(): void {
    this.acceptingShares = false;
  }

  /**
   * Retire the log (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Retiring a log"). It refuses, and changes nothing,
   * unless every share it accepted is resolved, as collected or uncollected,
   * nothing is held for a settlement_pending purchase, and the last period in
   * which it recorded a share has its statement (step 2). Then it stops
   * accepting shares (step 1, which `stopAccepting` does on its own first),
   * sets `until` on its key to the last closed period, whose statement is its
   * final one (step 3), and closes no period after it. Call it once each
   * party the log expects has cosigned or refused every statement it issued,
   * the final one included: witnesses check the key while it is current.
   * `requireCosigners` checks that, each cosigner named by its exact kid and
   * resolved with `resolveKey`, with the refusals listed in `refused`. Then
   * withdraw the key's authorization for the host (its root did:web document
   * or DNS record). Returns the final period.
   */
  retire(opts: RetireOptions = {}): string {
    if (this.book.retired) throw new Error("the log has already retired");
    if (this.pending.size > 0) throw new Error(`${this.pending.size} share(s) are held for settlement_pending purchases; resolve them first`);
    const open = [...this.shares.values()].filter((s) => s.state === "queued");
    if (open.length > 0) throw new Error(`${open.length} share(s) are not resolved yet (collected or uncollected)`);
    const last = this.book.lastClosed;
    if (!last) throw new Error("a log retires with a final statement, and this one has published none");
    const latest = [...this.shares.values()].reduce<string | undefined>((m, s) => (m === undefined || s.period > m ? s.period : m), undefined);
    if (latest !== undefined && latest > last.period) throw new Error(`${latest} holds shares and has no statement yet`);
    const final = this.book.retire(opts);
    this.acceptingShares = false;
    return final;
  }

  /** The five read endpoints under the log's URL ("", "/statements/<p>", "/lines/<p>", "/settlements/<p>", "/proofs/<id>"). */
  handle(path: string): { status: number; contentType: string; body: string } {
    return this.book.serve(path, (id) => this.proof(id));
  }

  private proof(id: string): ProofResult {
    const rec = this.shares.get(id);
    if (!rec) {
      const held = [...this.pending.values()].some((p) => p.id === id);
      return held ? [200, { status: "pending" }] : [404, { error: "not found" }];
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
    // batch-settlement purchases carry no share in draft 3: the server charges each request
    // itself, often without calling the facilitator, so the log never sees the charge.
    case "auth-capture":
      if (flow === "authorization" && (ptype === undefined || ptype === "charge")) basis = asInt(settleResponse.amount) ?? asInt(requirements.amount);
      break;
  }
  return basis === undefined ? { ok: false } : { ok: true, basis };
}

/** The share's scheme, from a payment that may be malformed. */
function shareScheme(info: SolidarityInfo): unknown {
  return (info.payment as { accepted?: { scheme?: unknown } } | undefined)?.accepted?.scheme;
}

/** The channel a batch-settlement share's voucher names, if it names one. */
function voucherChannelId(info: SolidarityInfo): string | undefined {
  if (shareScheme(info) !== "batch-settlement") return undefined;
  const id = (info.payment as { payload?: { voucher?: { channelId?: unknown } } } | undefined)?.payload?.voucher?.channelId;
  return typeof id === "string" ? id : undefined;
}

/** Two `extra` objects are the same terms: equal JSON, with EVM hex compared case-insensitively. */
function sameExtra(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  const norm = (x: Record<string, unknown> | undefined) => JSON.parse(JSON.stringify(x ?? {}), (_k, v) => (typeof v === "string" ? canonicalAccount(v) : v));
  return canonicalize(norm(a)) === canonicalize(norm(b));
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
