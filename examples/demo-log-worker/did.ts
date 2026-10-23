/**
 * did:web documents for the three demo keys (offer-and-receipt section 4.5.1:
 * the key is listed in verificationMethod).
 *
 *   did:web:<host>          the log's statement key    /.well-known/did.json
 *   did:web:<host>:witness  the demo witness           /witness/did.json
 *   did:web:<host>:fund     the demo fund's key        /fund/did.json
 *
 * All three are on the log's own host and held by the same Worker, so they
 * show how the pieces fit, not that the witness or the fund is independent.
 */

import type { PublicJwk } from "../../src/solidarity/index.ts";

export type DidRole = "log" | "witness" | "fund";

/** did:web encodes a port's colon as %3A. */
export const didHost = (origin: string): string => new URL(origin).host.replace(":", "%3A");

export function didOf(origin: string, role: DidRole): string {
  const base = `did:web:${didHost(origin)}`;
  return role === "log" ? base : `${base}:${role}`;
}

export const kidOf = (origin: string, role: DidRole): string => `${didOf(origin, role)}#${role}-1`;

/** The path a did:web DID resolves to on the host. */
export const didPath = (role: DidRole): string => (role === "log" ? "/.well-known/did.json" : `/${role}/did.json`);

export function didDocument(origin: string, role: DidRole, jwk: PublicJwk): Record<string, unknown> {
  const id = didOf(origin, role);
  const vm = kidOf(origin, role);
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id,
    verificationMethod: [{ id: vm, type: "JsonWebKey2020", controller: id, publicKeyJwk: jwk }],
    assertionMethod: [vm],
  };
}
