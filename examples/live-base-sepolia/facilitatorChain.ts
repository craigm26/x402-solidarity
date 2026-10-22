/**
 * A LogChain that settles exact payments through an x402 facilitator's
 * POST /settle (x402 v2 section 7.2), for the Base Sepolia example. The
 * share's payment is an ordinary x402 exact payment to the fund, so any
 * facilitator that lists `exact` on the network in /supported can settle it,
 * with paymentPayload = {x402Version: 2, accepted, payload} and
 * paymentRequirements = accepted, as solidarity.md says a log checks it. The
 * facilitator submits the transaction and pays the gas, so the payer needs
 * only the token.
 *
 * Only `exact` is wired up here; batch-settlement channels and claims are
 * not, and neither is findExactTransfer.
 */

import type { ExactEip3009Payload, LogChain, PaymentRequirements, VoucherFields } from "../../src/solidarity/index.ts";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class FacilitatorLogChain implements LogChain {
  private readonly url: string;
  private readonly fetch: Fetch;

  constructor(facilitatorUrl: string, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch) {
    this.url = facilitatorUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
  }

  async submitExact(accepted: PaymentRequirements, payload: ExactEip3009Payload) {
    const body = { x402Version: 2, paymentPayload: { x402Version: 2, accepted, payload }, paymentRequirements: accepted };
    try {
      const res = await this.fetch(`${this.url}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await res.text();
      let settle: { success?: unknown; transaction?: unknown; errorReason?: unknown; errorMessage?: unknown };
      try {
        settle = JSON.parse(text);
      } catch {
        return { ok: false as const, error: `facilitator /settle answered ${res.status} with a body that is not JSON` };
      }
      if (settle.success === true && typeof settle.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(settle.transaction)) {
        return { ok: true as const, transaction: settle.transaction };
      }
      // errorMessage is free text (often a whole viem error); keep its first line.
      const reason = [settle.errorReason, typeof settle.errorMessage === "string" ? settle.errorMessage.split("\n")[0] : undefined].filter((x) => typeof x === "string" && x).join(": ");
      return { ok: false as const, error: `facilitator /settle (${res.status}): ${reason || "no errorReason"}` };
    } catch (e) {
      return { ok: false as const, error: `facilitator /settle: ${(e as Error).message}` };
    }
  }

  channelState(_channelId: string) {
    return undefined;
  }

  async claim(_channelId: string, _voucher: VoucherFields, _totalClaimed: bigint) {
    return { ok: false as const, error: "batch-settlement is not wired up in this example" };
  }
}
