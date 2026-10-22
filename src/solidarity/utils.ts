/**
 * Utility functions for the solidarity extension: ids, share arithmetic,
 * CAIP-10 accounts, periods and encodings. BigInt throughout, so nothing is
 * rounded except by the floor the spec asks for.
 */

import { createHash, randomBytes } from "node:crypto";
import { AMOUNT_PATTERN, CAIP10_PATTERN, PERIOD_PATTERN, RATE_PATTERN, SHARE_ID_PATTERN } from "./types.ts";

/**
 * A new share id: 16 bytes (128 bits) from the CSPRNG, base64url without
 * padding, which is exactly 22 characters of [A-Za-z0-9_-]. Never derived
 * from anything else ("`PaymentRequired` and `PaymentPayload`", `id`).
 */
export function generateShareId(): string {
  return b64url(randomBytes(16));
}

export const isValidShareId = (id: unknown): id is string => typeof id === "string" && SHARE_ID_PATTERN.test(id);

/**
 * The EIP-3009 nonce of an `exact` share: SHA-256("solidarity/2|" + id) as
 * 0x-prefixed lowercase hex ("Share kinds", `exact`). The id stays random; the
 * nonce ties it to what the payer signs, so a relaying seller cannot record
 * the share under an id of its own.
 */
export function shareNonce(id: string): `0x${string}` {
  return `0x${createHash("sha256").update(`solidarity/2|${id}`).digest("hex")}`;
}
export const isValidRate = (rate: unknown): rate is string => typeof rate === "string" && RATE_PATTERN.test(rate);
export const isPositiveAmount = (a: unknown): a is string => typeof a === "string" && AMOUNT_PATTERN.test(a);
export const isPeriod = (p: unknown): p is string => typeof p === "string" && PERIOD_PATTERN.test(p);

/** floor(amount x rate) in atomic units. Throws on a rate outside "0.000001" to "0.01". */
export function applyRate(amount: string | bigint, rate: string): bigint {
  if (!isValidRate(rate)) throw new Error(`rate ${rate} is not between 0.000001 and 0.01 with no trailing zeros`);
  const a = BigInt(amount);
  if (a < 0n) throw new Error("amount must not be negative");
  const frac = rate.slice(2);
  return (a * BigInt(frac)) / 10n ** BigInt(frac.length);
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** The most a holder may commit for one share: floor(purchase x rate), less when the cap is nearly used. */
export function shareMax(purchaseAmount: string | bigint, rate: string, capLeft?: string | bigint): bigint {
  const m = applyRate(purchaseAmount, rate);
  return capLeft === undefined ? m : min(m, BigInt(capLeft) < 0n ? 0n : BigInt(capLeft));
}

/** What a log records: min(signed share, floor(basis x rate)). 0n means not recorded. */
export function recordedShare(signed: string | bigint, basis: string | bigint, rate: string): bigint {
  return min(BigInt(signed), applyRate(basis, rate));
}

/**
 * `net` refunds (processor mode), counted per purchase. `refunded` is the total
 * refunded for that purchase so far, `share` the amount recorded for it and
 * `alreadyCredited` what earlier refunds of it credited. The credits for one
 * purchase never add up to more than min(floor(total refunded x rate), share),
 * so several partial refunds credit exactly what one refund of the same total would.
 */
export function netCredit(refunded: string | bigint, rate: string, share: string | bigint, alreadyCredited: string | bigint = 0n): bigint {
  const left = min(applyRate(refunded, rate), BigInt(share)) - BigInt(alreadyCredited);
  return left > 0n ? left : 0n;
}

/**
 * Compare two decimal rate strings without floating point. Returns -1, 0 or 1.
 * Accepts any non-negative decimal ("0.0100", "1", "0.5").
 */
export function compareDecimal(a: string, b: string): number {
  const re = /^([0-9]+)(?:\.([0-9]+))?$/;
  const ma = re.exec(a);
  const mb = re.exec(b);
  if (!ma || !mb) throw new Error("not a non-negative decimal");
  const scale = Math.max(ma[2]?.length ?? 0, mb[2]?.length ?? 0);
  const va = BigInt(ma[1] + (ma[2] ?? "").padEnd(scale, "0"));
  const vb = BigInt(mb[1] + (mb[2] ?? "").padEnd(scale, "0"));
  return va < vb ? -1 : va > vb ? 1 : 0;
}

export const isDecimal = (s: unknown): s is string => typeof s === "string" && /^[0-9]+(\.[0-9]+)?$/.test(s);

/** CAIP-10 account split into CAIP-2 chain and account address. */
export function parseCaip10(account: string): { chain: string; namespace: string; reference: string; address: string } {
  if (!CAIP10_PATTERN.test(account)) throw new Error(`not a CAIP-10 account: ${account}`);
  const [namespace, reference, address] = account.split(":");
  return { chain: `${namespace}:${reference}`, namespace, reference, address };
}

/** Chain id of an `eip155:<id>` network. */
export function evmChainId(network: string): number {
  const m = /^eip155:([0-9]{1,32})$/.exec(network);
  if (!m) throw new Error(`not an eip155 network: ${network}`);
  return Number(m[1]);
}

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isEvmAddress = (s: unknown): s is string => typeof s === "string" && EVM_ADDR.test(s);

/** EVM hex addresses lowercase (bare or in an eip155 CAIP-10 account); anything else unchanged (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Lines"). */
export function canonicalAccount(s: string): string {
  const m = /^(eip155:[0-9]{1,32}:)(0x[0-9a-fA-F]{40})$/.exec(s);
  if (m) return m[1] + m[2].toLowerCase();
  return EVM_ADDR.test(s) ? s.toLowerCase() : s;
}

/** Address or asset equality: case-insensitive for EVM hex, exact otherwise. */
export const sameAccount = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && canonicalAccount(a) === canonicalAccount(b);

/** UTC calendar month of a Unix time in seconds. */
export function periodOf(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function nextPeriod(period: string): string {
  if (!isPeriod(period)) throw new Error("period must be YYYY-MM");
  const [y, m] = period.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export function previousPeriod(period: string): string {
  if (!isPeriod(period)) throw new Error("period must be YYYY-MM");
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Unix seconds at the first instant of a period. */
export function periodStart(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return Date.UTC(y, m - 1, 1) / 1000;
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function unb64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/** Bytewise comparison of ASCII strings (code units equal bytes for ASCII). */
export const bytewise = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
