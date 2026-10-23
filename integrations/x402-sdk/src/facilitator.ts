/**
 * Facilitator side: a solidarity log on an @x402/core x402Facilitator.
 *
 *   const log = new SolidarityLog({ descriptor, key, chain: facilitatorLogChain(exact) });
 *   const solidarity = attachSolidarity(facilitator, { log });
 *
 * What it does, against "Facilitator behaviour" in solidarity.md:
 * 1. /verify: nothing. No verify hook is registered; the purchase is verified
 *    exactly as without the extension.
 * 2. After the purchase's settle, the share is handed to the log
 *    (SolidarityLog.onSettled, which runs the spec's ordered checks).
 * 3. The outcome is added to `SettleResponse.extensions.solidarity` (for the
 *    buyer) and `{status}` to `extensionResponses` (for the seller, through the
 *    EXTENSION-RESPONSES header).
 * 4. The response is not delayed for the share: an accepted exact share is
 *    submitted afterwards (`followUp`), which `drain()` waits for. The log's
 *    decision itself is bounded by `decisionTimeoutMs` (default 2000): if the
 *    log has not decided by then (a slow scheme verify, or a channel share
 *    waiting for the channel's lock while a claim is on chain), the purchase's
 *    response goes out without a solidarity entry and the decision finishes in
 *    the background, where it shows at /proofs/<id>.
 * 5. A share problem never changes a core field of the purchase's
 *    SettleResponse. The hook never throws, and it puts the core fields back
 *    and drops its entry if they ever differ afterwards.
 * 6. "solidarity" is registered as a facilitator extension, so /supported
 *    lists it.
 *
 * How the outcome gets out. x402Facilitator has no hook that returns an
 * enriched SettleResponse. Its after-settle hooks return void, and settle()
 * returns the same object it passed to them as `ctx.result`. So `afterSettle`
 * writes `ctx.result.extensions` and `ctx.result.extensionResponses`. This
 * relies on two things @x402/core 2.28.0 does that its typings do not promise
 * (pinned exactly, and both checked by the canary in facilitator.test.ts):
 * - `ctx.result` is the object settle() returns;
 * - after-settle hooks run on every result the scheme returns, failed ones
 *   included (a revert, `settlement_pending`), although `onAfterSettle` is
 *   documented as running "after successful facilitator payment settlement".
 *   Holding a pending share and reporting `purchase-not-final` both depend on it.
 * And one thing it does not do: a settle that the operator's own
 * onSettleFailure hook recovers (`{recovered: true, result}`) runs no
 * after-settle hook, so the share would never be processed. An operator who
 * recovers settles calls `await solidarity.afterSettle({ ...ctx, result })`
 * on the recovered result before returning it.
 * An operator who would rather not rely on any of this uses `process()` around
 * its own settle call instead (see the README).
 *
 * settlement_pending: the seller's SDK settles a pending purchase once more
 * (settleWithPendingRetry). On that second settle the held share is resolved
 * with `log.resolvePending`, not handed to `onSettled` again, which would skip
 * it as a `duplicate` and leave it held for good. A held share expires once
 * its validBefore is too close for the log to accept it (`expireHeld`).
 */

import type { FacilitatorSettleResultContext, x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { snapshotSettleResponseCore } from "@x402/core/server";
import { SOLIDARITY, withOutcome } from "../../../src/solidarity/index.ts";
import type { SettleResponse as SolidaritySettleResponse, SolidarityLog, SolidarityOutcome } from "../../../src/solidarity/index.ts";
import type { PaymentPayload as SolidarityPaymentPayload, PaymentRequirements as SolidarityRequirements } from "../../../src/solidarity/index.ts";

export const SETTLEMENT_PENDING = "settlement_pending";

/** The fields x402 servers treat as the facilitator's own (snapshotSettleResponseCore). */
const CORE_KEYS = ["success", "transaction", "network", "amount", "payer", "errorReason", "errorMessage"] as const;

/** The log skips an exact share whose validBefore is less than this many seconds away (VALID_BEFORE_BUFFER_SECONDS). */
const VALID_BEFORE_BUFFER = 6;

export interface SolidarityFacilitatorOptions {
  log: SolidarityLog;
  /** Errors the extension swallowed, with where they happened. Never thrown back into the SDK. */
  onError?: (error: unknown, where: string) => void;
  /**
   * Each followUp (the exact share's transfer), for runtimes that must be told
   * about work outliving the response (for example waitUntil). It never rejects.
   */
  onFollowUp?: (followUp: Promise<void>) => void;
  /**
   * The longest the purchase's settle response waits for the log's decision,
   * in milliseconds (default 2000). Past it the response goes out without a
   * solidarity entry, and the decision finishes in the background. Infinity
   * (or 0) waits however long the log takes.
   */
  decisionTimeoutMs?: number;
}

export interface ProcessResult {
  /**
   * A new SettleResponse, the input left as it was. Core fields are copied
   * unchanged; with an outcome, it is in `extensions.solidarity` (for the
   * buyer) and `{status}` in `extensionResponses.solidarity` (for the seller).
   */
  response: SettleResponse;
  /** The share's outcome, when the payload carried a share and the log decided in time. */
  outcome?: SolidarityOutcome;
  /** True when the log had not decided within decisionTimeoutMs; the decision goes on in the background. */
  late?: boolean;
  /** Work after the response (submitting an exact share). Never rejects. */
  followUp: Promise<void>;
}

export interface SolidarityFacilitator {
  readonly key: typeof SOLIDARITY;
  readonly log: SolidarityLog;
  /** Purchases held as settlement_pending: transaction to share id. */
  readonly held: ReadonlyMap<string, string>;
  /**
   * The purchase's settle result in, a new SettleResponse with the outcome out.
   * It does not change its inputs, but it is not pure: it records the share in
   * the log and starts the share's transfer. Call it once per settle; a second
   * call for the same share answers `duplicate`.
   */
  process(paymentPayload: PaymentPayload, requirements: PaymentRequirements, result: SettleResponse): Promise<ProcessResult>;
  /**
   * The x402Facilitator after-settle hook. Total: it never throws. Also for an
   * operator's onSettleFailure hook, on a result it recovers.
   */
  afterSettle(ctx: FacilitatorSettleResultContext): Promise<void>;
  /**
   * For an operator's receipt watcher: a settlement_pending purchase confirmed
   * or failed. The buyer already has its response; the result shows at /proofs/<id>.
   */
  resolvePending(transaction: string, confirmed: boolean, finalResponse?: SettleResponse): Promise<{ outcome: SolidarityOutcome; followUp: Promise<void> } | undefined>;
  /**
   * Drop every held share the log could no longer accept because its
   * validBefore is (nearly) past, as `purchase-not-final`. Runs on every
   * settle; call it from a timer if settles are rare. Returns what it dropped.
   */
  expireHeld(): Promise<Array<{ transaction: string; id: string }>>;
  /** Wait for every followUp and late decision started so far (tests, graceful shutdown). */
  drain(): Promise<void>;
}

const isPending = (r: SettleResponse) => !r.success && r.errorReason === SETTLEMENT_PENDING && !!r.transaction;

/** The last second at which the log can still accept this payload's exact share, if it can be read. */
function acceptableUntil(paymentPayload: PaymentPayload): number | undefined {
  const info = (paymentPayload?.extensions?.[SOLIDARITY] as { info?: { payment?: { payload?: { authorization?: { validBefore?: unknown } } } } } | undefined)?.info;
  const vb = info?.payment?.payload?.authorization?.validBefore;
  return typeof vb === "string" && /^[0-9]{1,15}$/.test(vb) ? Number(vb) - VALID_BEFORE_BUFFER : undefined;
}

/** Resolves to {value} if `p` settles within `ms`, or undefined if not. Rejects if `p` rejects first. */
function within<T>(p: Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  const wrapped = p.then((value) => ({ value }));
  if (!(ms > 0 && Number.isFinite(ms))) return wrapped;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, ms, undefined);
  });
  return Promise.race([wrapped, late]).finally(() => clearTimeout(timer));
}

export function solidarityFacilitator(opts: SolidarityFacilitatorOptions): SolidarityFacilitator {
  const { log } = opts;
  const held = new Map<string, string>();
  const heldUntil = new Map<string, number | undefined>();
  const running = new Set<Promise<void>>();
  const timeoutMs = opts.decisionTimeoutMs ?? 2000;
  const report = (e: unknown, where: string) => {
    try {
      opts.onError?.(e, where);
    } catch {
      // a reporting callback must not break settlement either
    }
  };
  const track = (p: Promise<void>) => {
    const safe = p.catch((e) => report(e, "followUp"));
    running.add(safe);
    safe.finally(() => running.delete(safe));
    try {
      opts.onFollowUp?.(safe);
    } catch (e) {
      report(e, "onFollowUp");
    }
  };
  const hold = (transaction: string, id: string, paymentPayload: PaymentPayload) => {
    held.set(transaction, id);
    heldUntil.set(transaction, acceptableUntil(paymentPayload));
  };
  const release = (transaction: string) => {
    held.delete(transaction);
    heldUntil.delete(transaction);
  };

  // The two type families describe the same wire objects; the repo's are a subset.
  const asLog = (p: PaymentPayload, q: PaymentRequirements, r: SettleResponse) =>
    [p as unknown as SolidarityPaymentPayload, q as unknown as SolidarityRequirements, r as unknown as SolidaritySettleResponse] as const;

  async function decide(paymentPayload: PaymentPayload, requirements: PaymentRequirements, result: SettleResponse): Promise<ProcessResult> {
    const [p, q, r] = asLog(paymentPayload, requirements, result);
    const respond = (outcome: SolidarityOutcome | undefined, followUp: Promise<void>): ProcessResult => {
      if (!outcome) return { response: { ...result }, followUp };
      track(followUp);
      const response = withOutcome(r, outcome) as unknown as SettleResponse;
      response.extensionResponses = { ...(result.extensionResponses ?? {}), [SOLIDARITY]: { status: outcome.status } };
      return { response, outcome, followUp };
    };

    // (a) The second settle of a purchase that was settlement_pending: resolve the held share.
    // (A final result for a transaction the log does not hold returns undefined and falls through.)
    if (!isPending(result) && result.transaction) {
      const resolved = await log.resolvePending(result.transaction, result.success, r);
      release(result.transaction);
      if (resolved) return respond(resolved.outcome, resolved.followUp);
    }
    // (b) Still pending on the retry: the share stays held, reported as pending again.
    if (isPending(result) && held.has(result.transaction)) {
      const id = held.get(result.transaction) as string;
      return respond({ status: "pending", id, log: log.descriptor.log }, Promise.resolve());
    }
    // (c) Everything else goes through the log's ordered checks.
    const settled = await log.onSettled(p, q, r);
    if (settled.outcome?.status === "pending" && result.transaction) hold(result.transaction, settled.outcome.id, paymentPayload);
    return respond(settled.outcome, settled.followUp);
  }

  async function expireHeld(): Promise<Array<{ transaction: string; id: string }>> {
    const now = Math.floor(Date.now() / 1000);
    const dropped: Array<{ transaction: string; id: string }> = [];
    for (const [transaction, until] of [...heldUntil]) {
      // An unreadable validBefore can never pass the log's checks either.
      if (until !== undefined && now <= until) continue;
      const id = held.get(transaction) as string;
      release(transaction);
      try {
        await log.resolvePending(transaction, false);
      } catch (e) {
        report(e, "expireHeld");
      }
      dropped.push({ transaction, id });
    }
    return dropped;
  }

  async function process(paymentPayload: PaymentPayload, requirements: PaymentRequirements, result: SettleResponse): Promise<ProcessResult> {
    await expireHeld();
    const work = decide(paymentPayload, requirements, result);
    const done = await within(work, timeoutMs);
    if (done) return done.value;
    // The log is still deciding. Its followUp is tracked when it lands; drain() waits for both.
    track(work.then(() => undefined));
    report(new Error(`the log took longer than ${timeoutMs} ms to decide on a share; the purchase's response went out without a solidarity entry, and the decision goes on in the background`), "process");
    return { response: { ...result }, late: true, followUp: work.then((x) => x.followUp, () => undefined) };
  }

  async function afterSettle(ctx: FacilitatorSettleResultContext): Promise<void> {
    const result = ctx?.result;
    if (!result || typeof result !== "object") return;
    const before = snapshotSettleResponseCore(result);
    const prevExtensions = result.extensions;
    const prevResponses = result.extensionResponses;
    try {
      const r = await process(ctx.paymentPayload, ctx.requirements, result);
      if (r.outcome) {
        result.extensions = r.response.extensions;
        result.extensionResponses = r.response.extensionResponses;
      }
    } catch (e) {
      report(e, "afterSettle");
    }
    // Defensive: whatever happened above, the purchase's core fields are as the scheme returned them.
    if (CORE_KEYS.some((k) => result[k] !== before[k])) {
      for (const k of CORE_KEYS) {
        if (before[k] === undefined) delete (result as Record<string, unknown>)[k];
        else (result as Record<string, unknown>)[k] = before[k];
      }
      result.extensions = prevExtensions;
      result.extensionResponses = prevResponses;
      report(new Error("a core SettleResponse field changed while handling the share; restored, and the solidarity entry dropped"), "afterSettle");
    }
  }

  async function resolvePending(transaction: string, confirmed: boolean, finalResponse?: SettleResponse) {
    const r = await log.resolvePending(transaction, confirmed, finalResponse as unknown as SolidaritySettleResponse | undefined);
    release(transaction);
    if (r) track(r.followUp);
    return r;
  }

  async function drain(): Promise<void> {
    while (running.size > 0) await Promise.all([...running]);
  }

  return { key: SOLIDARITY, log, held, process, afterSettle, resolvePending, expireHeld, drain };
}

/**
 * Register the extension and its after-settle hook on an x402Facilitator.
 * Other after-settle hooks the operator registers must never throw either: a
 * throwing hook turns a settled purchase into a failed settle in x402Facilitator.
 * A settle recovered in onSettleFailure skips after-settle hooks: run
 * `solidarity.afterSettle({ ...ctx, result })` on the recovered result there.
 */
export function attachSolidarity(facilitator: x402Facilitator, opts: SolidarityFacilitatorOptions): SolidarityFacilitator {
  const ext = solidarityFacilitator(opts);
  facilitator.registerExtension(ext);
  facilitator.onAfterSettle((ctx) => ext.afterSettle(ctx));
  return ext;
}
