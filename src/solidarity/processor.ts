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
import type { LogBookOptions, ProofResult, RetireOptions } from "./book.ts";
import type { SigningKey } from "./ledger.ts";
import { formatLine, formatSettlement } from "./ledger.ts";
import { mandatePolicy } from "./client.ts";
import { CapCounter, assertPolicy, policyHash, policyProblems } from "./policy.ts";
import { ap2MandateSchema, validateSchema } from "./schema.ts";
import type { Ap2EnrollmentOutcome, Ap2RefusalReason, Ap2SolidarityMandate, LogDescriptor, OwnerPolicy, PublishedStatement, Receipt } from "./types.ts";
import { applyRate, generateShareId, netCredit, nextPeriod, periodOf } from "./utils.ts";

interface Owner {
  policy: OwnerPolicy;
  counter: CapCounter;
  credits: Array<{ amount: bigint; lapsesAfter: string }>;
  suspended: boolean;
  /** For a policy from an AP2 Solidarity Mandate: its iat, and its exp if any. */
  iat?: number;
  until?: number;
}

/** How far ahead of the holder's clock a Solidarity Mandate's iat may be. */
const IAT_SKEW_SECONDS = 300;

/** One policy per owner per currency (solidarity.md, "Owner policy": one policy per asset). */
const ownerKey = (owner: string, asset: string) => `${owner}\n${asset}`;

interface ProcessorShare {
  id: string;
  owner: string;
  purchaseId: string;
  fund: string;
  asset: string;
  amount: bigint;
  /** The rate and refund rule in force when the share was recorded; a later policy never changes them. */
  rate: string;
  refunds: "keep" | "net";
  refunded: bigint;
  credited: bigint;
  committedIn: string;
  collectedIn?: string;
  line?: string;
  /** Never collected: still below minCollection when the log retired. */
  uncollected?: boolean;
}

export class ProcessorHolder {
  readonly book: LogBook;
  private readonly clock: () => number;
  private readonly owners = new Map<string, Owner>();
  /** Owners suspended after a reversed collection, in every currency, including ones they enroll later. */
  private readonly suspendedOwners = new Set<string>();
  private readonly shares = new Map<string, ProcessorShare>();
  private readonly byPurchase = new Map<string, string>();
  private readonly payouts: Array<{ period: string; fund: string; asset: string; reference: string; amount: bigint }> = [];
  private stopped = false;

  /**
   * `persistStatement` stores each statement durably before it is published
   * or sent to a witness or the fund (LogBookOptions.persist;
   * https://craigmerry.com/solidarity-levy/spec/attestation.md, "Statements").
   */
  constructor(opts: { descriptor: LogDescriptor; key: SigningKey; clock?: () => number; persistStatement?: LogBookOptions["persist"] }) {
    if (opts.descriptor.accepts) throw new Error("a processor-mode descriptor omits accepts");
    this.clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
    this.book = new LogBook(opts.descriptor, opts.key, { persist: opts.persistStatement, clock: this.clock });
  }

  private get minCollection(): bigint {
    return BigInt(this.book.descriptor.minCollection ?? "0");
  }

  /** Registers the owner's policy for its cap currency, replacing any policy for that currency. */
  addOwner(owner: string, policy: OwnerPolicy): void {
    assertPolicy(policy, "processor");
    if (!this.book.descriptor.funds.includes(policy.fund)) throw new Error("the log does not list this fund");
    this.owners.set(ownerKey(owner, policy.cap.asset), { policy, counter: new CapCounter(policy), credits: [], suspended: false });
  }

  /**
   * AP2 (https://craigmerry.com/solidarity-levy/spec/processor-mode.md, "AP2: a Solidarity Mandate").
   * The agent presented the owner's Solidarity Mandate to this holder, which
   * has verified its signature under AP2's rules. Returns the `solidarity`
   * property for the holder's Mandate Receipt, or nothing when this party is
   * not the mandate's `holder` (it then ignores the mandate). Never throws on
   * the mandate's content; throws only if `self` is not a lowercase https
   * origin, a caller bug.
   *
   * `owner` is however the holder knows the owner. One policy per owner per
   * cap currency: a mandate with a later `iat` replaces the one for its
   * currency, keeps what the owner already committed that month and restarts
   * a stopped policy; one with an earlier or equal `iat` is refused as
   * `superseded`; a retry of the enrolled mandate is answered `enrolled` again,
   * or `stopped` if the owner has stopped it. A suspended owner is refused as
   * `suspended`, in every currency. On a refusal the holder's Mandate Receipt
   * has `result: "error"` and `error: "invalid_mandate"`.
   */
  enrollAp2(p: { self: string; owner: string; mandate: unknown }): { receipt?: Ap2EnrollmentOutcome } {
    if (!/^https:\/\/[^/?#\sA-Z]+$/.test(p.self) || new URL(p.self).origin !== p.self) throw new Error("self must be the holder's lowercase https origin");
    const m = p.mandate as Partial<Ap2SolidarityMandate> | null;
    if (!m || typeof m !== "object" || typeof m.holder !== "string" || !URL.canParse(m.holder) || new URL(m.holder).origin !== p.self) return {};
    const log = this.book.descriptor.log;
    const refuse = (reason: Ap2RefusalReason) => ({ receipt: { status: "refused" as const, reason, log } });
    // Meant for this holder but not written as its exact origin (case, trailing slash, port): refused, never ignored.
    if (m.holder !== p.self || validateSchema(ap2MandateSchema, m).length) return refuse("bad-policy");
    const mandate = m as Ap2SolidarityMandate;
    const now = this.clock();
    if (!Number.isSafeInteger(mandate.cap.amount) || !Number.isSafeInteger(mandate.iat) || mandate.iat <= 0 || mandate.iat > now + IAT_SKEW_SECONDS) return refuse("bad-policy");
    if (mandate.exp !== undefined && (!Number.isSafeInteger(mandate.exp) || mandate.exp <= mandate.iat || mandate.exp <= now)) return refuse("bad-policy");
    const policy = mandatePolicy(mandate);
    if (policyProblems(policy, "processor").length) return refuse("bad-policy");
    if (!policy.logs?.includes(log)) return refuse("wrong-log");
    if (!this.book.descriptor.funds.includes(policy.fund)) return refuse("fund-not-allowed");
    const key = ownerKey(p.owner, policy.cap.asset);
    const known = this.owners.get(key);
    // The holder suspended this owner after a reversed collection; no mandate lifts that.
    if (this.suspendedOwners.has(p.owner)) return refuse("suspended");
    // A retry of the mandate already enrolled gets the same answer, unless the owner has since stopped it.
    if (known && known.iat === mandate.iat && known.until === mandate.exp && policyHash(known.policy) === policyHash(policy)) {
      return known.counter.isOff ? refuse("stopped") : { receipt: { status: "enrolled", log } };
    }
    const knownSince = known ? (known.iat ?? Math.floor(Date.parse(known.policy.since) / 1000)) : undefined;
    if (knownSince !== undefined && knownSince >= mandate.iat) return refuse("superseded");
    const counter = known ? known.counter.withPolicy(policy) : new CapCounter(policy);
    counter.turnOn(); // a newer mandate is a new consent, even after the owner stopped the old one
    this.owners.set(key, { policy, counter, credits: known?.credits ?? [], suspended: false, iat: mandate.iat, until: mandate.exp });
    return { receipt: { status: "enrolled", log } };
  }

  /**
   * A purchase was finalized. Records the owner's share for it under the
   * policy for its currency in force now: floor(amount x rate), stopped at the
   * cap, less any open `net` credit. Returns the share id, or undefined when
   * there is no share (no policy for that currency, a policy past its `exp`,
   * zero, cap reached, credit used it up).
   */
  recordPurchase(p: { owner: string; purchaseId: string; amount: string; asset: string }): string | undefined {
    if (this.stopped) return undefined;
    const key = ownerKey(p.owner, p.asset);
    const o = this.owners.get(key);
    if (!o || o.suspended || this.suspendedOwners.has(p.owner) || o.counter.isOff) return undefined;
    if (o.until !== undefined && this.clock() >= o.until) return undefined;
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
    const id = generateShareId();
    o.counter.commit({ id, amount: share, period, kind: "processor" });
    this.shares.set(id, { id, owner: key, purchaseId: p.purchaseId, fund: o.policy.fund, asset: p.asset, amount: share, rate: o.policy.rate, refunds: o.policy.refunds ?? "keep", refunded: 0n, credited: 0n, committedIn: period });
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
    if (s.refunds === "keep") return { credit: 0n };
    s.refunded += BigInt(p.refunded);
    const credit = netCredit(s.refunded, s.rate, s.amount, s.credited);
    if (credit <= 0n) return { credit: 0n };
    s.credited += credit;
    const lapsesAfter = nextPeriod(periodOf(this.clock()));
    o.credits.push({ amount: credit, lapsesAfter });
    return { credit, lapsesAfter };
  }

  /**
   * The owner told the holder to stop the policy for `asset` ("Owner policy":
   * stop at once when the owner turns the policy off). A newer Solidarity
   * Mandate starts it again. Returns false if there was no such policy.
   */
  stop(owner: string, asset: string): boolean {
    const o = this.owners.get(ownerKey(owner, asset));
    if (!o) return false;
    o.counter.turnOff();
    return true;
  }

  /** The processor's own collection from the owner was reversed: the loss is the processor's; it may suspend the policy. */
  onCollectionReversed(owner: string): void {
    this.suspendedOwners.add(owner);
    for (const [k, o] of this.owners) if (k.startsWith(`${owner}\n`)) o.suspended = true;
  }

  /**
   * Collect for the current period: per owner, all shares not yet collected if their
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
      if (s.collectedIn || s.uncollected) continue;
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

  /**
   * Close a period after its collection. `issuedAt` defaults to the holder's
   * clock when the statement is built, and is fixed by its first write.
   * Synchronous: a `persistStatement` that returns a promise is refused (see
   * LogBookOptions.persist); use `closePeriodAsync` with an asynchronous store.
   */
  closePeriod(period: string, issuedAt?: number): PublishedStatement {
    if (period >= periodOf(this.clock())) throw new Error(`cannot close ${period} before it ends`);
    return this.book.close(period, this.linesOf(period), issuedAt);
  }

  /** `closePeriod` that awaits an asynchronous `persistStatement` before the period is closed and served. */
  async closePeriodAsync(period: string, issuedAt?: number): Promise<PublishedStatement> {
    if (period >= periodOf(this.clock())) throw new Error(`cannot close ${period} before it ends`);
    return this.book.closeAsync(period, this.linesOf(period), issuedAt);
  }

  private linesOf(period: string): string[] {
    return [...this.shares.values()].filter((s) => s.collectedIn === period).map((s) => s.line as string);
  }

  /** Step 1 of retiring (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Retiring a log"): the holder records no more shares. */
  stopAccepting(): void {
    this.stopped = true;
  }

  /**
   * Retire this log (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Retiring a log"). It refuses, and changes nothing,
   * until the last period with a collected line has its statement and each
   * kid in `requireCosigners` has cosigned every statement, or refused it
   * (`refused`). Then it records no more shares (step 1, which `stopAccepting`
   * does on its own first), shares still carried below `minCollection` become
   * uncollected (step 2: a processor's log MAY collect them below its minimum
   * in its final period instead, which `collect` here does not), and `until`
   * is set on the log's key to the last closed period, whose statement is the
   * final one (step 3). Collect first. Returns the final period.
   */
  retire(opts: RetireOptions = {}): string {
    const last = this.book.lastClosed;
    if (!last) throw new Error("a log retires with a final statement, and this one has published none");
    const latest = [...this.shares.values()].reduce<string | undefined>((m, s) => (s.collectedIn !== undefined && (m === undefined || s.collectedIn > m) ? s.collectedIn : m), undefined);
    if (latest !== undefined && latest > last.period) throw new Error(`${latest} holds collected shares and has no statement yet`);
    const period = this.book.retire(opts);
    this.stopped = true;
    for (const s of this.shares.values()) if (!s.collectedIn) s.uncollected = true;
    return period;
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
    if (s.uncollected) return [200, { status: "uncollected" }];
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
