/**
 * Processor mode (https://craigmerry.com/solidarity-levy/spec/processor-mode.md,
 * "Processor mode", "The processor's log", "Refunds"). Nothing here goes on the x402
 * wire. A buyer-side party that holds the owner's credential applies the
 * policy: one line per finalized purchase, collection in aggregate once per
 * period (amounts below `minCollection` carry forward), one payout per fund
 * per period, and the same lines, statements and receipts as any log.
 *
 * This is an arithmetic and bookkeeping model, not a payment processor: it
 * charges no one and pays no one. Running processor mode for real involves
 * money transmission, charitable-solicitation and card-network rules that
 * processor-mode.md lists as open questions.
 */

import { LogBook } from "./book.ts";
import type { ProofResult } from "./book.ts";
import type { SigningKey } from "./ledger.ts";
import { formatLine, formatSettlement } from "./ledger.ts";
import { constraintPolicy } from "./client.ts";
import { CapCounter, assertPolicy, policyHash, policyProblems } from "./policy.ts";
import { ap2ConstraintSchema, validateSchema } from "./schema.ts";
import { SHARE_ID_PATTERN } from "./types.ts";
import type { Ap2ReceiptOutcome, Ap2SkipReason, Ap2SolidarityConstraint, LogDescriptor, OwnerPolicy, PublishedStatement, Receipt } from "./types.ts";
import { applyRate, generateShareId, netCredit, nextPeriod, periodOf } from "./utils.ts";

interface Owner {
  policy: OwnerPolicy;
  counter: CapCounter;
  credits: Array<{ amount: bigint; lapsesAfter: string }>;
  suspended: boolean;
}

interface ProcessorShare {
  id: string;
  owner: string;
  purchaseId: string;
  fund: string;
  asset: string;
  amount: bigint;
  refunded: bigint;
  credited: bigint;
  committedIn: string;
  collectedIn?: string;
  line?: string;
}

export class ProcessorHolder {
  readonly book: LogBook;
  private readonly clock: () => number;
  private readonly owners = new Map<string, Owner>();
  private readonly shares = new Map<string, ProcessorShare>();
  private readonly byPurchase = new Map<string, string>();
  private readonly payouts: Array<{ period: string; fund: string; asset: string; reference: string; amount: bigint }> = [];
  /** Share ids promised in AP2 Payment Receipts, by owner, until the purchase is final. */
  private readonly reserved = new Map<string, string>();

  constructor(opts: { descriptor: LogDescriptor; key: SigningKey; clock?: () => number }) {
    if (opts.descriptor.accepts) throw new Error("a processor-mode descriptor omits accepts");
    this.book = new LogBook(opts.descriptor, opts.key);
    this.clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  private get minCollection(): bigint {
    return BigInt(this.book.descriptor.minCollection ?? "0");
  }

  addOwner(owner: string, policy: OwnerPolicy): void {
    assertPolicy(policy, "processor");
    if (!this.book.descriptor.funds.includes(policy.fund)) throw new Error("the log does not list this fund");
    this.owners.set(owner, { policy, counter: new CapCounter(policy), credits: [], suspended: false });
  }

  /**
   * AP2 (https://craigmerry.com/solidarity-levy/spec/processor-mode.md, "AP2: a Payment Mandate Constraint",
   * "Evaluation"). Evaluates the constraint for one closed Payment Mandate. It
   * always passes: the constraint never limits what the closed Payment Mandate
   * may contain, so a share can never block a purchase. A party that is not the
   * constraint's `holder` gets no receipt property and does nothing else. The
   * holder gets the `solidarity` property for its Payment Receipt: `pending`
   * with the id it will record the line under once the payment is final
   * (pass that id to recordPurchase), or `skipped` with a reason.
   *
   * `owner` is however the holder knows the owner (one cap counter per owner,
   * across every open Payment Mandate); `iat` is the open Payment Mandate's.
   * Throws only if `self` is not an https origin, a caller bug.
   */
  evaluateAp2(p: { self: string; owner: string; constraint: unknown; iat: number; payment: { amount: number; currency: string } }): { pass: true; receipt?: Ap2ReceiptOutcome } {
    if (!/^https:\/\/[^/?#\s]+$/.test(p.self)) throw new Error("self must be the holder's https origin");
    const c = p.constraint as Partial<Ap2SolidarityConstraint> | null;
    if (!c || typeof c !== "object" || c.holder !== p.self) return { pass: true };
    const log = this.book.descriptor.log;
    const skip = (reason: Ap2SkipReason) => ({ pass: true as const, receipt: { status: "skipped" as const, reason, log } });
    if (validateSchema(ap2ConstraintSchema, c).length) return skip("bad-policy");
    const policy = constraintPolicy(c as Ap2SolidarityConstraint, p.iat);
    if (policyProblems(policy, "processor").length) return skip("bad-policy");
    if (!policy.logs?.includes(log)) return skip("wrong-log");
    if (!this.book.descriptor.funds.includes(policy.fund)) return skip("fund-not-allowed");
    if (p.payment.currency !== policy.cap.asset || !Number.isSafeInteger(p.payment.amount) || p.payment.amount <= 0) return skip("purchase-not-supported");
    const known = this.owners.get(p.owner);
    if (!known) this.addOwner(p.owner, policy);
    else if (policyHash(known.policy) !== policyHash(policy)) {
      known.policy = policy;
      known.counter = known.counter.withPolicy(policy);
    }
    const o = this.owners.get(p.owner) as Owner;
    if (o.suspended || o.counter.isOff) return skip("cap-reached");
    if (applyRate(String(p.payment.amount), policy.rate) === 0n) return skip("below-minimum");
    if (o.counter.left(periodOf(this.clock())) === 0n) return skip("cap-reached");
    const id = generateShareId();
    this.reserved.set(id, p.owner);
    return { pass: true, receipt: { status: "pending", id, log } };
  }

  /**
   * A purchase was finalized. Records the owner's share for it: floor(amount x
   * rate), stopped at the cap, less any open `net` credit. Returns the share id,
   * or undefined when there is no share (zero, cap reached, credit used it up).
   * `id` is the id evaluateAp2 promised in the Payment Receipt, if any.
   */
  recordPurchase(p: { owner: string; purchaseId: string; amount: string; asset: string; id?: string }): string | undefined {
    if (p.id !== undefined) {
      if (!SHARE_ID_PATTERN.test(p.id) || this.reserved.get(p.id) !== p.owner) throw new Error("id was not reserved for this owner");
      this.reserved.delete(p.id);
    }
    const o = this.owners.get(p.owner);
    if (!o || o.suspended || o.counter.isOff) return undefined;
    if (p.asset !== o.policy.cap.asset) return undefined;
    if (this.byPurchase.has(p.purchaseId)) throw new Error("purchase already recorded");
    const period = periodOf(this.clock());
    let share = applyRate(p.amount, o.policy.rate);
    const left = o.counter.left(period);
    if (share > left) share = left;
    // net credits lower later shares; they never produce a zero or negative line.
    o.credits = o.credits.filter((c) => c.lapsesAfter >= period && c.amount > 0n);
    for (const c of o.credits) {
      const use = c.amount < share ? c.amount : share;
      c.amount -= use;
      share -= use;
    }
    if (share <= 0n) return undefined;
    const id = p.id ?? generateShareId();
    o.counter.commit({ id, amount: share, period, kind: "processor" });
    this.shares.set(id, { id, owner: p.owner, purchaseId: p.purchaseId, fund: o.policy.fund, asset: p.asset, amount: share, refunded: 0n, credited: 0n, committedIn: period });
    this.byPurchase.set(p.purchaseId, id);
    return id;
  }

  /**
   * A purchase that carried a share was refunded (in whole or in part). Under
   * `keep` nothing happens. Under `net` the owner gets a credit, counted per
   * purchase: the credits for one purchase never add up to more than
   * min(floor(total refunded x rate), the share recorded for it), so several
   * partial refunds credit exactly what one refund of the same total would.
   * A credit is usable in the refund's period and the next, wherever the
   * purchase's batch was, and then lapses. Nothing is ever paid back, and no
   * closed batch changes.
   */
  refund(p: { purchaseId: string; refunded: string }): { credit: bigint; lapsesAfter?: string } {
    const id = this.byPurchase.get(p.purchaseId);
    const s = id ? this.shares.get(id) : undefined;
    if (!s) return { credit: 0n };
    const o = this.owners.get(s.owner) as Owner;
    if ((o.policy.refunds ?? "keep") === "keep") return { credit: 0n };
    s.refunded += BigInt(p.refunded);
    const credit = netCredit(s.refunded, o.policy.rate, s.amount, s.credited);
    if (credit <= 0n) return { credit: 0n };
    s.credited += credit;
    const lapsesAfter = nextPeriod(periodOf(this.clock()));
    o.credits.push({ amount: credit, lapsesAfter });
    return { credit, lapsesAfter };
  }

  /** The processor's own collection from the owner was reversed: the loss is the processor's; it may suspend the policy. */
  onCollectionReversed(owner: string): void {
    const o = this.owners.get(owner);
    if (o) o.suspended = true;
  }

  /**
   * Collect for the current period: per owner, all uncollected shares if their
   * sum reaches `minCollection`, else they carry forward. A line's period is
   * the month the processor collected it. Pays each fund once for the period
   * (recorded as `payout:<reference>`; this model moves no money).
   */
  collect(): { period: string; collected: string[]; carried: string[] } {
    const period = periodOf(this.clock());
    const collected: string[] = [];
    const carried: string[] = [];
    const perOwner = new Map<string, ProcessorShare[]>();
    for (const s of this.shares.values()) {
      if (s.collectedIn) continue;
      perOwner.set(s.owner, [...(perOwner.get(s.owner) ?? []), s]);
    }
    const perFund = new Map<string, bigint>();
    for (const list of perOwner.values()) {
      const sum = list.reduce((a, s) => a + s.amount, 0n);
      if (sum < this.minCollection) {
        carried.push(...list.map((s) => s.id));
        continue;
      }
      for (const s of list) {
        s.collectedIn = period;
        s.line = formatLine({ period, fund: s.fund, asset: s.asset, id: s.id, amount: s.amount });
        collected.push(s.id);
        const key = `${s.fund}|${s.asset}`;
        perFund.set(key, (perFund.get(key) ?? 0n) + s.amount);
      }
    }
    // Payout references must be unique among the logs paying a fund, so they start with this log's host.
    const host = new URL(this.book.descriptor.log).host;
    for (const [key, amount] of perFund) {
      const [fund, asset] = key.split("|");
      const reference = `${host}/${period}/${this.payouts.length + 1}`;
      this.payouts.push({ period, fund, asset, reference, amount });
      this.book.addSettlement(period, formatSettlement({ fund, asset, ref: `payout:${reference}`, amount }));
    }
    return { period, collected, carried };
  }

  /** Close a period after its collection. */
  closePeriod(period: string, issuedAt?: number): PublishedStatement {
    if (period >= periodOf(this.clock())) throw new Error(`cannot close ${period} before it ends`);
    const lines = [...this.shares.values()].filter((s) => s.collectedIn === period).map((s) => s.line as string);
    return this.book.close(period, lines, issuedAt);
  }

  /** What the fund sees of its payouts (for its "money arrived" check). */
  payoutRecord(reference: string): { asset: string; amount: bigint } | undefined {
    const p = this.payouts.find((x) => x.reference === reference);
    return p ? { asset: p.asset, amount: p.amount } : undefined;
  }

  handle(path: string): { status: number; contentType: string; body: string } {
    return this.book.serve(path, (id) => this.proof(id));
  }

  private proof(id: string): ProofResult {
    const s = this.shares.get(id);
    if (!s) return [404, { error: "not found" }];
    if (!s.collectedIn) return [200, { status: "queued" }];
    return this.book.included(s.collectedIn, id) ?? [200, { status: "queued" }];
  }

  receipt(id: string): Receipt | undefined {
    const s = this.shares.get(id);
    return s?.collectedIn ? this.book.receipt(s.collectedIn, id) : undefined;
  }

  shareAmount(id: string): bigint | undefined {
    return this.shares.get(id)?.amount;
  }
}
