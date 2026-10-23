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
 *    submitted afterwards (`followUp`), which `drain()` waits for.
 * 5. A share problem never changes a core field of the purchase's
 *    SettleResponse. The hook never throws, and it puts the core fields back
 *    and drops its entry if they ever differ afterwards.
 * 6. "solidarity" is registered as a facilitator extension, so /supported
 *    lists it.
 *
 * How the outcome gets out: x402Facilitator has no hook that returns an
 * enriched SettleResponse. Its after-settle hooks return void, and settle()
 * returns the same object it passed to them as `ctx.result`. So `afterSettle`
 * writes `ctx.result.extensions` and `ctx.result.extensionResponses`. This
 * relies on @x402/core 2.28.0 behaviour (pinned exactly, and checked by a
 * test). An operator who would rather not rely on it uses `process()`, a pure
 * function, around its own settle call instead (see the README).
 *
 * settlement_pending: the seller's SDK settles a pending purchase once more
 * (settleWithPendingRetry). On that second settle the held share is resolved
 * with `log.resolvePending`, not handed to `onSettled` again, which would skip
 * it as a `duplicate` and leave it held for good.
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

export interface SolidarityFacilitatorOptions {
  log: SolidarityLog;
  /** Errors the extension swallowed, with where they happened. Never thrown back into the SDK. */
  onError?: (error: unknown, where: string) => void;
  /**
   * Each followUp (the exact share's transfer), for runtimes that must be told
   * about work outliving the response (for example waitUntil). It never rejects.
   */
  onFollowUp?: (followUp: Promise<void>) => void;
}

export interface ProcessResult {
  /** A new SettleResponse: the purchase's, with the outcome added. Core fields are copied unchanged. */
  response: SettleResponse;
  /** The share's outcome, when the payload carried a share. */
  outcome?: SolidarityOutcome;
  /** Work after the response (submitting an exact share). Never rejects. */
  followUp: Promise<void>;
}

export interface SolidarityFacilitator {
  readonly key: typeof SOLIDARITY;
  readonly log: SolidarityLog;
  /** Purchases held as settlement_pending: transaction to share id. */
  readonly held: ReadonlyMap<string, string>;
  /** Pure: the purchase's settle result in, a new SettleResponse with the outcome out. */
  process(paymentPayload: PaymentPayload, requirements: PaymentRequirements, result: SettleResponse): Promise<ProcessResult>;
  /** The x402Facilitator after-settle hook. Total: it never throws. */
  afterSettle(ctx: FacilitatorSettleResultContext): Promise<void>;
  /**
   * For an operator's receipt watcher: a settlement_pending purchase confirmed
   * or failed. The buyer already has its response; the result shows at /proofs/<id>.
   */
  resolvePending(transaction: string, confirmed: boolean, finalResponse?: SettleResponse): Promise<{ outcome: SolidarityOutcome; followUp: Promise<void> } | undefined>;
  /** Wait for every followUp started so far (tests, graceful shutdown). */
  drain(): Promise<void>;
}

const isPending = (r: SettleResponse) => !r.success && r.errorReason === SETTLEMENT_PENDING && !!r.transaction;

export function solidarityFacilitator(opts: SolidarityFacilitatorOptions): SolidarityFacilitator {
  const { log } = opts;
  const held = new Map<string, string>();
  const running = new Set<Promise<void>>();
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

  // The two type families describe the same wire objects; the repo's are a subset.
  const asLog = (p: PaymentPayload, q: PaymentRequirements, r: SettleResponse) =>
    [p as unknown as SolidarityPaymentPayload, q as unknown as SolidarityRequirements, r as unknown as SolidaritySettleResponse] as const;

  async function process(paymentPayload: PaymentPayload, requirements: PaymentRequirements, result: SettleResponse): Promise<ProcessResult> {
    const [p, q, r] = asLog(paymentPayload, requirements, result);
    const respond = (outcome: SolidarityOutcome | undefined, followUp: Promise<void>): ProcessResult => {
      if (!outcome) return { response: result, followUp };
      track(followUp);
      return { response: withOutcome(r, outcome) as unknown as SettleResponse, outcome, followUp };
    };

    // (a) The second settle of a purchase that was settlement_pending: resolve the held share.
    // (A final result for a transaction the log does not hold returns undefined and falls through.)
    if (!isPending(result) && result.transaction) {
      const resolved = await log.resolvePending(result.transaction, result.success, r);
      held.delete(result.transaction);
      if (resolved) return respond(resolved.outcome, resolved.followUp);
    }
    // (b) Still pending on the retry: the share stays held, reported as pending again.
    if (isPending(result) && held.has(result.transaction)) {
      const id = held.get(result.transaction) as string;
      return respond({ status: "pending", id, log: log.descriptor.log }, Promise.resolve());
    }
    // (c) Everything else goes through the log's ordered checks.
    const settled = await log.onSettled(p, q, r);
    if (settled.outcome?.status === "pending" && result.transaction) held.set(result.transaction, settled.outcome.id);
    return respond(settled.outcome, settled.followUp);
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
        result.extensionResponses = { ...(result.extensionResponses ?? {}), [SOLIDARITY]: { status: r.outcome.status } };
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
    held.delete(transaction);
    if (r) track(r.followUp);
    return r;
  }

  async function drain(): Promise<void> {
    while (running.size > 0) await Promise.all([...running]);
  }

  return { key: SOLIDARITY, log, held, process, afterSettle, resolvePending, drain };
}

/**
 * Register the extension and its after-settle hook on an x402Facilitator.
 * Other after-settle hooks the operator registers must never throw either: a
 * throwing hook turns a settled purchase into a failed settle in x402Facilitator.
 */
export function attachSolidarity(facilitator: x402Facilitator, opts: SolidarityFacilitatorOptions): SolidarityFacilitator {
  const ext = solidarityFacilitator(opts);
  facilitator.registerExtension(ext);
  facilitator.onAfterSettle((ctx) => ext.afterSettle(ctx));
  return ext;
}
