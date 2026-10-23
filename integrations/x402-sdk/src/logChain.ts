/**
 * The log's chain access (the repo's LogChain) built on the operator's own
 * x402 exact scheme.
 *
 * An accepted `exact` share is the share's own x402 payment. The spec says the
 * log "checks it with its existing scheme code, as /verify and /settle would,
 * with paymentPayload set to {x402Version: 2, accepted: payment.accepted,
 * payload: payment.payload} and paymentRequirements set to payment.accepted"
 * (solidarity.md, "`PaymentRequired` and `PaymentPayload`"). That is exactly
 * what `submitExact` does, through the operator's ExactEvmScheme instance.
 *
 * Pass the ExactEvmScheme instance, not the x402Facilitator: share transfers
 * then skip the facilitator's hooks (the share is not a purchase, and must not
 * run the solidarity hook on itself). registerExactEvmScheme hides its
 * instance, so construct it yourself:
 *
 *   const exact = new ExactEvmScheme(signer);
 *   facilitator.register("eip155:84532", exact);
 *   const chain = facilitatorLogChain(exact);
 *
 * Not provided here, because a FacilitatorEvmSigner cannot do them:
 * - batch-settlement channel reads and claims (`channelState`, `claim`): pass
 *   them in `fallback`, or batch-settlement shares are skipped (channel not found).
 * - `findExactTransfer` (finding an authorization someone else executed): it
 *   needs event logs (AuthorizationUsed and Transfer) from an RPC client.
 *   Without it, such a share is reported uncollected.
 */

import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { ExactEip3009Payload, LogChain, PaymentRequirements as SolidarityRequirements } from "../../../src/solidarity/index.ts";

/** Anything with the scheme's settle: an ExactEvmScheme (preferred) or an x402Facilitator. */
export interface ShareSettler {
  settle(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export interface FacilitatorLogChainOptions {
  /** Channel reads, claims and findExactTransfer from elsewhere (an RPC client; the simulated chain in tests). */
  fallback?: Partial<LogChain>;
  /**
   * How many more times to settle a share whose settle came back
   * settlement_pending (default 2). The scheme's pending store reconciles the
   * same broadcast rather than sending a second one.
   */
  pendingRetries?: number;
}

const pending = (r: SettleResponse) => !r.success && r.errorReason === "settlement_pending" && !!r.transaction;

export function facilitatorLogChain(settler: ShareSettler, opts: FacilitatorLogChainOptions = {}): LogChain {
  const retries = Math.max(0, opts.pendingRetries ?? 2);
  const fb = opts.fallback;
  const chain: LogChain = {
    async submitExact(accepted: SolidarityRequirements, payload: ExactEip3009Payload) {
      try {
        const p = { x402Version: 2, accepted, payload } as unknown as PaymentPayload;
        const q = accepted as unknown as PaymentRequirements;
        let r = await settler.settle(p, q);
        for (let i = 0; i < retries && pending(r); i++) r = await settler.settle(p, q);
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
  if (fb?.findExactTransfer) {
    chain.findExactTransfer = (accepted, payload) => (fb.findExactTransfer as NonNullable<LogChain["findExactTransfer"]>).call(fb, accepted, payload);
  }
  return chain;
}
