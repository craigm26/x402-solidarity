/**
 * A log's book: settlement references per period, closed batches, signed and
 * chained statements, cosignatures and the publication endpoints. Shared by
 * the facilitator's log (separate mode) and a processor's log (processor
 * mode), which publish exactly the same things (https://craigmerry.com/solidarity-levy/spec/attestation.md).
 */

import type { Batch, SigningKey } from "./ledger.ts";
import { buildBatch, buildReceipt, decodeStatement, fileBody, jwsVerify, settlementsMatchTotals, signStatement, statementBytes, statementHash, statementPayload } from "./ledger.ts";
import type { JwsEnvelope, LogDescriptor, PublishedStatement, Receipt, StatementPayload } from "./types.ts";
import { nextPeriod, periodStart } from "./utils.ts";

export interface ClosedPeriod {
  payload: StatementPayload;
  pub: PublishedStatement;
  batch: Batch;
  lines: string;
  settlements: string;
}

export type ProofResult = [number, unknown];

export class LogBook {
  readonly descriptor: LogDescriptor;
  private readonly key: SigningKey;
  private readonly settlements = new Map<string, string[]>();
  private readonly closed = new Map<string, ClosedPeriod>();
  private last: { period: string; hash: string } | undefined;
  private earliest: string | undefined;

  constructor(descriptor: LogDescriptor, key: SigningKey) {
    this.descriptor = descriptor;
    this.key = key;
  }

  addSettlement(period: string, entry: string): void {
    if (this.closed.has(period)) throw new Error(`period ${period} is closed; a batch is never edited`);
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
    if (!this.last && (this.earliest === undefined || period < this.earliest)) this.earliest = period;
  }

  get lastClosed(): { period: string; hash: string } | undefined {
    return this.last;
  }

  get(period: string): ClosedPeriod | undefined {
    return this.closed.get(period);
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
   */
  close(period: string, lines: string[], issuedAt?: number, signed?: JwsEnvelope): PublishedStatement {
    if (this.closed.has(period)) throw new Error(`${period} is already closed`);
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
      issuedAt: issuedAt ?? periodStart(nextPeriod(period)),
    });
    const pub = signed ? this.storedStatement(payload, signed) : signStatement(payload, this.key);
    this.closed.set(period, { payload, pub, batch, lines: linesBody, settlements: settlementsBody });
    this.last = { period, hash: statementHash(payload) };
    return pub;
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
