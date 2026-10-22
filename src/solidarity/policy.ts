/**
 * The owner policy ("Owner policy") and the holder's cap counter.
 *
 * The policy is held by exactly one party per purchase and never goes on the
 * wire. `policyHash` exists for the holder's own records (for example, to tie
 * a cap counter and a consent screen to one policy version). It must not be
 * sent anywhere: draft 1 put a policy hash on the wire, and draft 2 removed it
 * because it made every share an owner signed in a month linkable.
 */

import { createHash } from "node:crypto";
import { canonicalizeStrict } from "./jcs.ts";
import type { Mode, OwnerPolicy, ShareKind } from "./types.ts";
import { AMOUNT_PATTERN, CAIP10_PATTERN, RATE_PATTERN } from "./types.ts";
import { periodOf, sameAccount } from "./utils.ts";

/** Problems with a policy for a mode; [] when it is fine. */
export function policyProblems(policy: OwnerPolicy, mode: Mode): string[] {
  const out: string[] = [];
  if (mode !== "separate" && mode !== "processor") out.push("mode must be separate or processor");
  if (policy?.version !== 2) out.push("version must be 2");
  if (!RATE_PATTERN.test(policy?.rate ?? "")) out.push("rate must be from 0.000001 to 0.01 with no trailing zeros");
  if (!AMOUNT_PATTERN.test(policy?.cap?.amount ?? "")) out.push("cap.amount must be a positive integer string (atomic units)");
  if (typeof policy?.cap?.asset !== "string" || policy.cap.asset.length === 0) out.push("cap.asset is required");
  if (typeof policy?.fund !== "string" || policy.fund.length === 0) out.push("fund is required");
  else if (mode === "separate" && !CAIP10_PATTERN.test(policy.fund)) out.push("fund must be a CAIP-10 account in separate mode");
  if (policy?.logs !== undefined) {
    if (!Array.isArray(policy.logs) || !policy.logs.every((l) => typeof l === "string" && l.startsWith("https://"))) {
      out.push("logs must be a list of https URLs");
    }
  }
  const refunds = policy?.refunds ?? "keep";
  if (refunds !== "keep" && refunds !== "net") out.push("refunds must be keep or net");
  if (mode === "separate" && refunds === "net") out.push("separate mode is keep only");
  if (typeof policy?.since !== "string" || Number.isNaN(Date.parse(policy.since))) out.push("since must be a date-time");
  return out;
}

export function assertPolicy(policy: OwnerPolicy, mode: Mode): void {
  const p = policyProblems(policy, mode);
  if (p.length) throw new Error(`invalid owner policy: ${p.join("; ")}`);
}

/** Hex SHA-256 of the policy's JCS bytes. Local use only; never put it on the wire. */
export function policyHash(policy: OwnerPolicy): string {
  return createHash("sha256").update(canonicalizeStrict(policy)).digest("hex");
}

/** What the holder must show the owner at consent ("Owner policy": rate, cap, fund, refund rule). */
export function consentSummary(policy: OwnerPolicy): { rate: string; cap: string; fund: string; refunds: string; note: string } {
  return {
    rate: policy.rate,
    cap: `${policy.cap.amount} atomic units of ${policy.cap.asset} per UTC calendar month`,
    fund: policy.fund,
    refunds: policy.refunds ?? "keep",
    note:
      (policy.refunds ?? "keep") === "keep"
        ? "A share is a final gift. A refund of the purchase does not reverse or reduce it."
        : "Refunds lower later shares by a credit; nothing is ever paid back from a fund.",
  };
}

interface Commitment {
  id: string;
  amount: bigint;
  period: string;
  kind: ShareKind | "processor";
  validBefore?: number;
  released: boolean;
}

/**
 * The cap counter. Counts a share from the moment it is signed or committed,
 * whatever status is reported later, per UTC calendar month of signing.
 *
 * One owner running several clients under one policy shares one instance
 * (or the owner splits the cap and each client holds a policy for its part).
 * In a single Node process the methods are synchronous, so commit is atomic.
 */
export class CapCounter {
  readonly policy: OwnerPolicy;
  readonly cap: bigint;
  private readonly byId = new Map<string, Commitment>();
  private readonly totals = new Map<string, bigint>();
  private off = false;

  constructor(policy: OwnerPolicy) {
    this.policy = policy;
    this.cap = BigInt(policy.cap.amount);
  }

  /** The owner turned the policy off: stop adding shares at once. */
  turnOff(): void {
    this.off = true;
  }
  get isOff(): boolean {
    return this.off;
  }

  /** Is `asset` the asset the cap is counted in? Shares in any other asset are not added. */
  counts(asset: string): boolean {
    return sameAccount(asset, this.policy.cap.asset);
  }

  committed(period: string): bigint {
    return this.totals.get(period) ?? 0n;
  }

  left(period: string): bigint {
    if (this.off) return 0n;
    const l = this.cap - this.committed(period);
    return l > 0n ? l : 0n;
  }

  leftAt(unixSeconds: number): bigint {
    return this.left(periodOf(unixSeconds));
  }

  /**
   * Count a share. Throws if it would pass the cap, if the policy is off, or if
   * the id was used. Synchronous, so a caller that reads `left` and commits with
   * no await in between reserves its room atomically.
   */
  commit(c: { id: string; amount: bigint; period: string; kind: ShareKind | "processor"; validBefore?: number }): void {
    if (this.off) throw new Error("policy is off");
    if (this.byId.has(c.id)) throw new Error(`share ${c.id} already counted`);
    if (c.amount <= 0n) throw new Error("a share must be positive");
    if (c.amount > this.left(c.period)) throw new Error("share would pass the cap");
    this.byId.set(c.id, { ...c, released: false });
    this.totals.set(c.period, this.committed(c.period) + c.amount);
  }

  /**
   * Undo a commitment whose signing failed, so nothing was signed. Only for
   * the holder's own failure path, right after `commit`.
   */
  abort(id: string): boolean {
    const c = this.byId.get(id);
    if (!c || c.released) return false;
    this.byId.delete(id);
    this.totals.set(c.period, this.committed(c.period) - c.amount);
    return true;
  }

  /**
   * Release an `exact` share the holder can show was never executed, once its
   * validBefore has passed. `executed` must come from the chain (for EIP-3009,
   * `authorizationState(from, nonce)` is false). Returns true when released.
   */
  release(id: string, opts: { now: number; executed: boolean }): boolean {
    const c = this.byId.get(id);
    if (!c || c.released) return false;
    if (c.kind !== "exact" || c.validBefore === undefined) return false;
    if (opts.now <= c.validBefore || opts.executed) return false;
    c.released = true;
    this.totals.set(c.period, this.committed(c.period) - c.amount);
    return true;
  }

  get(id: string): Readonly<Commitment> | undefined {
    return this.byId.get(id);
  }

  /**
   * The same owner's counter under a new policy (for example a new AP2 open
   * Payment Mandate): what was already committed keeps counting against the
   * new cap, so changing the policy mid-month never makes room.
   */
  withPolicy(policy: OwnerPolicy): CapCounter {
    const next = new CapCounter(policy);
    for (const [id, c] of this.byId) next.byId.set(id, { ...c });
    for (const [period, total] of this.totals) next.totals.set(period, total);
    next.off = this.off;
    return next;
  }
}
