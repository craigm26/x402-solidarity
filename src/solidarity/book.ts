/**
 * A log's book: settlement references per period, closed batches, signed and
 * chained statements, cosignatures and the publication endpoints. Shared by
 * the facilitator's log (separate mode) and a processor's log (processor
 * mode), which publish exactly the same things (https://craigmerry.com/solidarity-levy/spec/attestation.md).
 */

import type { Batch, KeyResolver, SigningKey } from "./ledger.ts";
import { buildBatch, buildReceipt, decodeStatement, fileBody, finalPeriod, isRetired, jwsDecode, jwsVerify, settlementsMatchTotals, signStatement, statementBytes, statementHash, statementPayload } from "./ledger.ts";
import type { JwsEnvelope, LogDescriptor, PublishedStatement, Receipt, StatementPayload } from "./types.ts";
import { nextPeriod } from "./utils.ts";

export interface ClosedPeriod {
  payload: StatementPayload;
  pub: PublishedStatement;
  batch: Batch;
  lines: string;
  settlements: string;
}

export type ProofResult = [number, unknown];

export interface LogBookOptions {
  /**
   * Stores a newly signed statement durably. A log issues one payload per
   * period, ever, and stores it (or every input that determines it, `issuedAt`
   * included) before it publishes it or sends it to a witness or the fund
   * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Statements"). Called before the period is closed and
   * served; if it throws or rejects, the period stays open and nothing is
   * published. Not called for a statement re-added from storage (`signed`).
   *
   * A store that writes asynchronously returns its promise, and is used
   * through `closeAsync` (SolidarityLog.closePeriod, ProcessorHolder.closePeriodAsync),
   * which awaits it before the period is closed and served. The synchronous
   * `close` refuses a hook that returns a promise: it throws, publishes
   * nothing, and closes no period after it, since it cannot tell whether that
   * write landed (rebuild the book from storage).
   */
  persist?: (closed: { period: string; payload: StatementPayload; statement: JwsEnvelope }) => void | Promise<void>;
  /** Unix seconds: `issuedAt` when `close` is given none, the time of that first write. Default: the system clock. */
  clock?: () => number;
}

/** What `retire` checks on the log's statements before it sets `until`. */
export interface RetireOptions {
  /**
   * The cosigners the log expects, each by its exact kid
   * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Witnesses and the fund"). Each must have answered
   * every statement the log issued, the final one included: a valid
   * cosignature attached, or a refusal listed in `refused`.
   */
  requireCosigners?: string[];
  /** Resolves each required cosigner's kid to its public key. */
  resolveKey?: KeyResolver;
  /** Statements a party refused ("Refusals"): a refusal counts as its answer to that statement. */
  refused?: Array<{ kid: string; period: string }>;
}

/** Is `v` a promise (or any thenable)? */
export function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";
}

export class LogBook {
  readonly descriptor: LogDescriptor;
  private readonly key: SigningKey;
  private readonly persist?: LogBookOptions["persist"];
  private readonly clock: () => number;
  private readonly settlements = new Map<string, string[]>();
  private readonly closed = new Map<string, ClosedPeriod>();
  private last: { period: string; hash: string } | undefined;
  private earliest: string | undefined;
  /** The period whose statement `closeAsync` is storing: nothing is added to it meanwhile. */
  private closingPeriod: string | undefined;
  /** Set when a synchronous `close` got a promise from `persist`: whether that write landed is unknown. */
  private unsure: string | undefined;

  constructor(descriptor: LogDescriptor, key: SigningKey, opts: LogBookOptions = {}) {
    this.descriptor = descriptor;
    this.key = key;
    this.persist = opts.persist;
    this.clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  addSettlement(period: string, entry: string): void {
    if (this.closed.has(period)) throw new Error(`period ${period} is closed; a batch is never edited`);
    if (period === this.closingPeriod) throw new Error(`period ${period} is being closed; a batch is never edited`);
    this.refuseAfterFinal(period);
    const list = this.settlements.get(period) ?? [];
    list.push(entry);
    this.settlements.set(period, list);
    this.markActive(period);
  }

  /**
   * Note that `period` holds a share (recorded, pending or collected). Before
   * its first statement the log may not close a later period, or the shares
   * in this one could never be published: `previous` is null only for the
   * log's first period, and every period after it is closed in order.
   */
  markActive(period: string): void {
    if (this.closed.has(period)) throw new Error(`period ${period} is closed; a batch is never edited`);
    if (period === this.closingPeriod) throw new Error(`period ${period} is being closed; a batch is never edited`);
    this.refuseAfterFinal(period);
    if (!this.last && (this.earliest === undefined || period < this.earliest)) this.earliest = period;
  }

  /** A retired log issues no statement after its final one, so nothing can be recorded for a later period. */
  private refuseAfterFinal(period: string): void {
    const final = this.finalPeriod;
    if (final !== undefined && period > final) throw new Error(`the log has retired: its final statement is for ${final}, and nothing is recorded for ${period}`);
  }

  get lastClosed(): { period: string; hash: string } | undefined {
    return this.last;
  }

  get(period: string): ClosedPeriod | undefined {
    return this.closed.get(period);
  }

  /** Is `period` closed, or is its statement being stored (closeAsync)? Nothing more goes into its batch either way. */
  sealed(period: string): boolean {
    return this.closed.has(period) || period === this.closingPeriod;
  }

  /** The period that must be closed next, or undefined before the first close. */
  get nextToClose(): string | undefined {
    return this.last ? nextPeriod(this.last.period) : undefined;
  }

  /**
   * Close a period: one batch of `lines`, the settlements file, and a statement
   * signed with the log's key, chained to the previous period's payload.
   * Every period gets a statement, including an empty one, so a gap is visible.
   *
   * `signed` is for a log that rebuilds its book from stored records: the
   * statement it signed and published before. The payload is built exactly as
   * without it, and the stored JWS is used only if it is by this log's key
   * (same kid, valid signature) and over exactly these payload bytes; anything
   * else throws before the period is closed. The private key is not used, and
   * the published statement is byte for byte the one stored.
   *
   * A log issues one payload per period, ever
   * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Statements"). Without `signed`, the new statement goes
   * to `persist` before the period is closed and served, and `issuedAt`
   * defaults to the clock when the statement is built, so it is fixed by that
   * first write. With `signed` and no `issuedAt`, the stored statement's own
   * `issuedAt` is used.
   *
   * `close` is synchronous: a `persist` that returns a promise is refused
   * (see LogBookOptions.persist). Use `closeAsync` with an asynchronous store.
   */
  close(period: string, lines: string[], issuedAt?: number, signed?: JwsEnvelope): PublishedStatement {
    const c = this.prepare(period, lines, issuedAt, signed);
    if (!signed) {
      const r = this.persist?.({ period, payload: c.payload, statement: c.pub.statement });
      if (isThenable(r)) {
        // Whether this write lands is unknown, so this book closes nothing more: a later close
        // could build a second payload for the period. The rejection, if any, is the caller's to see
        // through its own store; here it must not surface as an unhandled rejection.
        Promise.resolve(r).catch(() => undefined);
        this.unsure = period;
        throw new Error(`persist returned a promise for ${period}: LogBook.close is synchronous, so nothing was published; rebuild the book from storage and use closeAsync`);
      }
    }
    return this.commit(c);
  }

  /**
   * `close` for a `persist` that writes asynchronously: the new statement is
   * stored, and the write awaited, before the period is closed and served
   * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Statements"). If the write throws or rejects, the
   * period stays open and nothing is published. While it runs, nothing is
   * added to the period (`sealed`), and no other period is closed.
   */
  async closeAsync(period: string, lines: string[], issuedAt?: number, signed?: JwsEnvelope): Promise<PublishedStatement> {
    const c = this.prepare(period, lines, issuedAt, signed);
    if (!signed && this.persist) {
      this.closingPeriod = period;
      try {
        await this.persist({ period, payload: c.payload, statement: c.pub.statement });
      } finally {
        this.closingPeriod = undefined;
      }
    }
    return this.commit(c);
  }

  /** Builds and signs (or checks the stored) statement for `period`, changing nothing. */
  private prepare(period: string, lines: string[], issuedAt: number | undefined, signed: JwsEnvelope | undefined): ClosedPeriod & { period: string; previous: string | null } {
    if (this.unsure !== undefined) throw new Error(`the statement for ${this.unsure} may have been stored without being published; rebuild the book from storage`);
    if (this.closingPeriod !== undefined) throw new Error(`the statement for ${this.closingPeriod} is being stored; try again after it`);
    if (this.closed.has(period)) throw new Error(`${period} is already closed`);
    if (this.retired) throw new Error(`the log has retired: its final statement is for ${this.finalPeriod}, and it issues none after it`);
    if (this.last && period !== nextPeriod(this.last.period)) throw new Error(`the next statement must be for ${nextPeriod(this.last.period)}`);
    if (!this.last && this.earliest !== undefined && period > this.earliest) throw new Error(`the first statement must be for ${this.earliest} or earlier`);
    const batch = buildBatch(lines);
    if (batch.period !== null && batch.period !== period) throw new Error("lines are for another period");
    const entries = this.settlements.get(period) ?? [];
    if (!settlementsMatchTotals(entries, batch.totals)) throw new Error("settlement references do not add up to the totals");
    const linesBody = fileBody(batch.lines);
    const settlementsBody = fileBody(entries);
    const payload = statementPayload({
      log: this.descriptor.log,
      period,
      batch,
      settlementsBody,
      previous: this.last?.hash ?? null,
      issuedAt: issuedAt ?? (signed ? storedIssuedAt(signed) : undefined) ?? this.clock(),
    });
    const pub = signed ? this.storedStatement(payload, signed) : signStatement(payload, this.key);
    return { period, previous: payload.previous, payload, pub, batch, lines: linesBody, settlements: settlementsBody };
  }

  /** Closes the period with a prepared statement, if nothing changed while it was stored. */
  private commit(c: ClosedPeriod & { period: string; previous: string | null }): PublishedStatement {
    if (this.closed.has(c.period) || (this.last?.hash ?? null) !== c.previous) throw new Error(`the book changed while the statement for ${c.period} was stored`);
    this.closed.set(c.period, { payload: c.payload, pub: c.pub, batch: c.batch, lines: c.lines, settlements: c.settlements });
    this.last = { period: c.period, hash: statementHash(c.payload) };
    return c.pub;
  }

  /** The stored statement, checked against the payload this book built. */
  private storedStatement(payload: StatementPayload, signed: JwsEnvelope): PublishedStatement {
    if (signed?.format !== "jws" || typeof signed.signature !== "string") throw new Error("the stored statement is not a JWS envelope");
    const d = decodeStatement(signed);
    if (d.kid !== this.key.kid) throw new Error(`the stored statement is signed by ${d.kid}, not ${this.key.kid}`);
    if (!jwsVerify(signed.signature, this.key.publicKey)) throw new Error("the stored statement's signature does not verify with the log's key");
    if (Buffer.compare(Buffer.from(d.bytes), Buffer.from(statementBytes(payload))) !== 0) throw new Error("the stored statement is over another payload");
    return { statement: { format: "jws", signature: signed.signature }, cosignatures: [] };
  }

  /** Has the log retired (its descriptor lists no current key)? It then closes no more periods. */
  get retired(): boolean {
    return isRetired(this.descriptor);
  }

  /** The final period of a retired log. */
  get finalPeriod(): string | undefined {
    return finalPeriod(this.descriptor);
  }

  /**
   * Step 3 of retiring (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Retiring a log"): set `until` on the current key to
   * the last closed period, whose statement becomes the final one. Witnesses
   * check the key while it is current, so `until` is set only once each party
   * the log expects has answered every statement it issued, the final one
   * included: each kid in `requireCosigners` must have a valid cosignature
   * (checked with `resolveKey`) on every statement this book holds, or a
   * refusal of it listed in `refused`. Once the key is retired, a statement
   * still waiting for a cosignature can no longer get one. The callers
   * (SolidarityLog.retire, ProcessorHolder.retire) check steps 1 and 2 first.
   * After it the descriptor has no current key, and `close` refuses every
   * period. Withdrawing the key's authorization for the host (its root
   * did:web document or DNS record) is the operator's, after this returns.
   */
  retire(opts: RetireOptions = {}): string {
    if (this.retired) throw new Error("the log has already retired");
    if (!this.last) throw new Error("a log retires with a final statement, and it has published none");
    const current = this.descriptor.keys.filter((k) => k.until === null);
    if (current.length !== 1 || current[0].kid !== this.key.kid) throw new Error("the descriptor's current key is not the key this log signs with");
    if (current[0].from > this.last.period) throw new Error(`the current key signs from ${current[0].from}, after the last statement (${this.last.period})`);
    const refused = new Set((opts.refused ?? []).map((r) => `${r.kid} ${r.period}`));
    for (const [period, closed] of [...this.closed].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const bytes = decodeStatement(closed.pub.statement).bytes;
      for (const kid of opts.requireCosigners ?? []) {
        if (refused.has(`${kid} ${period}`)) continue;
        const has = closed.pub.cosignatures.some((c) => {
          try {
            const d = jwsDecode(c.signature);
            if (d.header.kid !== kid || Buffer.compare(Buffer.from(d.payloadBytes), Buffer.from(bytes)) !== 0) return false;
            const key = opts.resolveKey?.(kid, { log: this.descriptor.log, role: "cosigner" });
            return key !== undefined && jwsVerify(c.signature, key);
          } catch {
            return false;
          }
        });
        if (!has) throw new Error(`the statement for ${period} has no valid cosignature or refusal by ${kid} yet`);
      }
    }
    current[0].until = this.last.period;
    return this.last.period;
  }

  addCosignature(period: string, cosignature: JwsEnvelope): void {
    const p = this.closed.get(period);
    if (!p) throw new Error(`${period} is not published`);
    if (!p.pub.cosignatures.some((c) => c.signature === cosignature.signature)) p.pub.cosignatures.push(cosignature);
  }

  receipt(period: string, id: string): Receipt | undefined {
    const p = this.closed.get(period);
    if (!p || p.batch.indexOf(id) < 0) return undefined;
    return buildReceipt(p.pub, p.batch, id);
  }

  /** `{status: "included", period, line, index, proof}` when the id is in the period's batch. */
  included(period: string, id: string): ProofResult | undefined {
    const p = this.closed.get(period);
    if (!p) return undefined;
    const index = p.batch.indexOf(id);
    if (index < 0) return undefined;
    return [200, { status: "included", period, line: p.batch.lines[index], index, proof: p.batch.proof(index) }];
  }

  /**
   * The five read endpoints under the log's URL, served from memory. `path`
   * is relative to the log URL ("", "/statements/2026-10", ...).
   */
  serve(path: string, proof: (id: string) => ProofResult): { status: number; contentType: string; body: string } {
    const json = (status: number, v: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(v) });
    const text = (body: string) => ({ status: 200, contentType: "text/plain; charset=utf-8", body });
    if (path === "" || path === "/") return json(200, this.descriptor);
    let m = /^\/statements\/([0-9]{4}-[0-9]{2})$/.exec(path);
    if (m) {
      const p = this.closed.get(m[1]);
      return p ? json(200, p.pub) : json(404, { error: "not found" });
    }
    m = /^\/lines\/([0-9]{4}-[0-9]{2})$/.exec(path);
    if (m) {
      const p = this.closed.get(m[1]);
      return p ? text(p.lines) : json(404, { error: "not found" });
    }
    m = /^\/settlements\/([0-9]{4}-[0-9]{2})$/.exec(path);
    if (m) {
      const p = this.closed.get(m[1]);
      return p ? text(p.settlements) : json(404, { error: "not found" });
    }
    m = /^\/proofs\/([A-Za-z0-9_-]{22,128})$/.exec(path);
    if (m) return json(...proof(m[1]));
    return json(404, { error: "not found" });
  }
}

/** The `issuedAt` of a stored statement, or undefined if it cannot be read (the stored-statement check then says why). */
function storedIssuedAt(signed: JwsEnvelope): number | undefined {
  try {
    return decodeStatement(signed).payload.issuedAt;
  } catch {
    return undefined;
  }
}
