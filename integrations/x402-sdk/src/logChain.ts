/**
 * The log's chain access (the repo's LogChain) built on the operator's own
 * x402 exact scheme.
 *
 * An accepted `exact` share is the share's own x402 payment. The spec says the
 * log "checks it with its existing scheme code, as /verify and /settle would,
 * with paymentPayload set to {x402Version: 2, accepted: payment.accepted,
 * payload: payment.payload} and paymentRequirements set to payment.accepted"
 * (solidarity.md, "`PaymentRequired` and `PaymentPayload`"). That is what
 * `verifyExact` (the share's acceptance check) and `submitExact` (its
 * transfer) do, through the operator's ExactEvmScheme instance. So a share
 * from a smart wallet (ERC-1271, ERC-6492) is checked exactly as a purchase
 * from it would be, and so are the payer's balance and the nonce, by the
 * scheme's own simulation.
 *
 * Pass the ExactEvmScheme instance, not the x402Facilitator: share checks and
 * transfers then skip the facilitator's hooks (the share is not a purchase, and
 * must not run the solidarity hook on itself). registerExactEvmScheme hides its
 * instance, so construct it yourself:
 *
 *   const exact = new ExactEvmScheme(signer);
 *   facilitator.register("eip155:84532", exact);
 *   const chain = facilitatorLogChain(exact);
 *
 * settlement_pending on the share's own settle (the transfer was broadcast,
 * and its receipt wait timed out): the share is settled again, after a delay
 * that grows, until the scheme gives a final answer. The scheme's pending
 * store re-waits on the same broadcast; nothing is sent twice. The share stays
 * `queued` meanwhile (closePeriod refuses to close its month while it is), so
 * a share that does reach the fund is never left out of the batch because a
 * receipt was slow. Only once the share's validBefore has passed (after which
 * an unexecuted authorization can never execute) and `pendingGraceSeconds`
 * more without a receipt does it report the transfer as not made.
 *
 * A transfer reported as not made is not an uncollected share. Under draft 3
 * the log reports an exact share uncollected only once its validBefore has
 * passed and the chain shows the authorization unused (solidarity.md, "Share
 * kinds"), which takes `authorizationUsed` (EIP-3009 authorizationState) and,
 * for a cancelled authorization, `authorizationCanceled`. Pass them in
 * `fallback`. Without them the share stays queued: its month closes without
 * it after the claim grace, and it is recorded late if `findExactTransfer`
 * later finds it executed (`log.reconcileExact()`).
 *
 * Not provided here, because a FacilitatorEvmSigner cannot do them:
 * - batch-settlement channel reads and claims (`channelState`, `claim`): pass
 *   them in `fallback`, or batch-settlement shares are skipped (channel not found).
 * - `findExactTransfer` (finding an authorization someone else executed): it
 *   needs event logs (AuthorizationUsed and Transfer) from an RPC client.
 *   Without it, such a share is never seen collected.
 * - `authorizationUsed` and `authorizationCanceled` (above): a contract read
 *   and an event log from an RPC client.
 */

import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import type { ExactEip3009Payload, LogChain, PaymentRequirements as SolidarityRequirements } from "../../../src/solidarity/index.ts";

/**
 * Anything with the scheme's settle, and preferably its verify: an
 * ExactEvmScheme (preferred) or an x402Facilitator (whose hooks would then run
 * on the share too). Without `verify`, the log falls back to its offline EOA
 * signature check, which cannot check smart-wallet signatures.
 */
export interface ShareSettler {
  settle(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  verify?(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
}

export interface FacilitatorLogChainOptions {
  /**
   * Channel reads, claims, findExactTransfer, authorizationUsed and authorizationCanceled from
   * elsewhere (an RPC client; the simulated chain in tests).
   */
  fallback?: Partial<LogChain>;
  /**
   * The wait before the n-th re-settle of a share whose settle came back
   * settlement_pending, in milliseconds. Default: 5 s, doubling, at most 60 s.
   */
  retryDelayMs?: (attempt: number) => number;
  /**
   * How long after the share's validBefore to keep asking for a receipt before
   * the transfer is reported as not made (default 3600 seconds).
   */
  pendingGraceSeconds?: number;
  /** The wait itself (tests pass one that moves a simulated clock). Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Unix seconds. Default: the clock. */
  now?: () => number;
}

const isPending = (r: SettleResponse) => !r.success && r.errorReason === "settlement_pending" && !!r.transaction;
const defaultDelay = (attempt: number) => Math.min(5000 * 2 ** Math.max(0, attempt - 1), 60_000);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function facilitatorLogChain(settler: ShareSettler, opts: FacilitatorLogChainOptions = {}): LogChain {
  const fb = opts.fallback;
  const delay = opts.retryDelayMs ?? defaultDelay;
  const grace = opts.pendingGraceSeconds ?? 3600;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const asSdk = (accepted: SolidarityRequirements, payload: ExactEip3009Payload) =>
    [{ x402Version: 2, accepted, payload } as unknown as PaymentPayload, accepted as unknown as PaymentRequirements] as const;

  const chain: LogChain = {
    async submitExact(accepted: SolidarityRequirements, payload: ExactEip3009Payload) {
      try {
        const [p, q] = asSdk(accepted, payload);
        const vb = Number(payload?.authorization?.validBefore);
        const giveUpAt = (Number.isSafeInteger(vb) ? vb : now()) + grace;
        let r = await settler.settle(p, q);
        for (let attempt = 1; isPending(r); attempt++) {
          if (now() > giveUpAt) return { ok: false as const, error: `settlement_pending: no receipt for ${r.transaction} by validBefore + ${grace} s` };
          await sleep(delay(attempt));
          r = await settler.settle(p, q);
        }
        // A failed settle with a transaction (a reverted transfer) is not collected.
        if (r.success && r.transaction) return { ok: true as const, transaction: r.transaction };
        return { ok: false as const, error: r.errorReason ?? "settle failed" };
      } catch (e) {
        return { ok: false as const, error: (e as Error)?.message ?? String(e) };
      }
    },
    channelState(channelId: string) {
      return fb?.channelState ? fb.channelState(channelId) : undefined;
    },
    async claim(channelId, voucher, totalClaimed) {
      if (!fb?.claim) return { ok: false as const, error: "claims are not wired: pass fallback.claim" };
      return fb.claim(channelId, voucher, totalClaimed);
    },
  };
  if (typeof settler.verify === "function") {
    chain.verifyExact = async (accepted, payload) => {
      const [p, q] = asSdk(accepted, payload);
      const v = await (settler.verify as NonNullable<ShareSettler["verify"]>).call(settler, p, q);
      return v.isValid ? { ok: true as const } : { ok: false as const, error: v.invalidReason ?? "invalid" };
    };
  }
  if (fb?.findExactTransfer) {
    chain.findExactTransfer = (accepted, payload) => (fb.findExactTransfer as NonNullable<LogChain["findExactTransfer"]>).call(fb, accepted, payload);
  }
  if (fb?.authorizationUsed) {
    chain.authorizationUsed = (accepted, payload) => (fb.authorizationUsed as NonNullable<LogChain["authorizationUsed"]>).call(fb, accepted, payload);
  }
  if (fb?.authorizationCanceled) {
    chain.authorizationCanceled = (accepted, payload) => (fb.authorizationCanceled as NonNullable<LogChain["authorizationCanceled"]>).call(fb, accepted, payload);
  }
  return chain;
}
