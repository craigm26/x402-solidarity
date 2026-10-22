/**
 * Resource server (seller) utilities for the solidarity extension.
 *
 * A seller that wants to offer the slot declares the extension on its routes,
 * with one `logs` entry for each (network, scheme) it settles through a
 * facilitator that runs a solidarity log ("Advertisement"). The seller's price
 * does not change, and the seller never pays the share. It relays the client's
 * payload unchanged.
 */

import type { LogEntry, SolidarityExtension } from "./types.ts";
import { SOLIDARITY, SOLIDARITY_VERSION } from "./types.ts";
import { solidaritySchema } from "./schema.ts";

/** Declares the extension for `PaymentRequired.extensions`. */
export function declareSolidarityExtension(logs: LogEntry[]): SolidarityExtension {
  for (const l of logs) {
    if (!l.network || !l.scheme || !/^https:\/\//.test(l.log)) throw new Error("each logs entry needs network, scheme and an https log URL");
  }
  const seen = new Set<string>();
  for (const l of logs) {
    const key = `${l.network}\u0000${l.scheme}`;
    if (seen.has(key)) throw new Error(`two logs for ${l.network} ${l.scheme}`);
    seen.add(key);
  }
  return { info: { version: SOLIDARITY_VERSION, logs: logs.map((l) => ({ ...l })) }, schema: solidaritySchema };
}

/**
 * Shape-compatible with @x402/core's ResourceServerExtension. Static: the
 * declaration carries everything. A hook that fills `logs` from a
 * facilitator's /supported is future work in the spec.
 */
export const solidarityResourceServerExtension = { key: SOLIDARITY } as const;

/** Conventional log URL for a facilitator ("<facilitator base URL>/solidarity"). */
export const conventionalLogUrl = (facilitatorBaseUrl: string): string => `${facilitatorBaseUrl.replace(/\/+$/, "")}/solidarity`;
