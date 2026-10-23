/**
 * Seller side: the solidarity extension as an @x402/core ResourceServerExtension.
 *
 *   server.registerExtension(solidarityServerExtension());
 *   routes["GET /report"].extensions = {
 *     solidarity: declareSolidarityExtension([{ network: "eip155:84532", scheme: "exact", log: "https://facilitator.example/solidarity" }]),
 *   };
 *
 * The seller only offers the slot: its `info` carries `version` and `logs`,
 * nothing else ("`PaymentRequired` and `PaymentPayload`"). It relays the
 * client's payload unchanged and never pays the share.
 *
 * What this extension deliberately does not have:
 * - No `enrichSettlementResponse`. x402ResourceServer assigns its return value
 *   to `settleResult.extensions[key]`, which would overwrite the log's outcome
 *   on its way to the buyer.
 * - No verify or settle hooks. The share is the facilitator's business, after
 *   the purchase settles.
 *
 * `dynamicInfoFields: ["logs"]` keeps a change to a route's `logs` between the
 * 402 and the paid request (a deploy, or initialize() refreshing support) from
 * failing the purchase with `extension_echo_mismatch`. `version` is still
 * checked, and the log checks `log` itself.
 */

import type { PaymentRequiredContext, ResourceServerExtension } from "@x402/core/types";
import { conventionalLogUrl, declareSolidarityExtension, SOLIDARITY } from "../../../src/solidarity/index.ts";
import type { LogEntry } from "../../../src/solidarity/index.ts";

export { conventionalLogUrl, declareSolidarityExtension };

export interface SolidarityServerOptions {
  /**
   * Fill `logs` per 402 from the route's accepts: the log URL for a (network,
   * scheme), or undefined for none. For example
   * `() => conventionalLogUrl(facilitatorClient.url)`.
   */
  logFor?: (network: string, scheme: string) => string | undefined;
  /**
   * When given, a (network, scheme) gets a log only if the facilitator serving
   * it lists "solidarity" in /supported (after `initialize()`). /supported
   * cannot carry the log URL itself (solidarity.md, "Open questions" 1).
   */
  server?: { getFacilitatorExtensions(x402Version: number, network: string, scheme: string): string[] };
}

export function solidarityServerExtension(opts: SolidarityServerOptions = {}): ResourceServerExtension {
  const ext: ResourceServerExtension = { key: SOLIDARITY, dynamicInfoFields: ["logs"] };
  const logFor = opts.logFor;
  if (logFor) {
    ext.enrichPaymentRequiredResponse = async (_declaration: unknown, ctx: PaymentRequiredContext) => {
      const logs: LogEntry[] = [];
      const seen = new Set<string>();
      for (const r of ctx.requirements) {
        const k = `${r.network}\u0000${r.scheme}`;
        if (seen.has(k)) continue;
        if (opts.server && !opts.server.getFacilitatorExtensions(2, r.network, r.scheme).includes(SOLIDARITY)) continue;
        const log = logFor(r.network, r.scheme);
        if (typeof log !== "string" || !/^https:\/\//.test(log)) continue;
        seen.add(k);
        logs.push({ network: r.network, scheme: r.scheme, log });
      }
      // With no entries the info is {version: 2, logs: []}, which clients read as
      // "no log for this network and scheme" and add no share.
      return declareSolidarityExtension(logs);
    };
  }
  return ext;
}
