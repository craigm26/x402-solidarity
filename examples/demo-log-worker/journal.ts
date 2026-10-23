/**
 * The demo log's records, the storage they live in, and the chain the log
 * talks to.
 *
 * Every step the log takes is an event row, written before the step has any
 * effect outside the Durable Object. On wake the log is rebuilt by replaying
 * the rows in order. This log talks to a real chain (Base Sepolia), so replay
 * must never submit, settle or sign anything there: the log gets a
 * JournalChain, which answers from the recorded rows while replaying and only
 * acts on the chain, write-ahead, while live.
 */

import type { ExactEip3009Payload, LogChain, PaymentRequirements, VoucherFields } from "../../src/solidarity/index.ts";

/**
 * - genesis: written once, pins origin, mode, payer, fund and the first period
 * - cycle: a signed purchase and its share, written before any network call (the purchase's intent)
 * - intent: a share's transfer is about to be submitted
 * - result: the final answer for a submission (purchase or share)
 * - lookup: the chain lookup the log asked for when its own submission of a share failed
 * - settled: the purchase's SettleResponse, as handed to log.onSettled
 * - cycle-end: what the log decided for the share, checked again on every replay
 * - close-intent, close: a month's statement (issuedAt fixed by the intent, the signed JWS stored)
 * - cosign: the demo witness's or the demo fund's cosignature, stored and re-added on replay
 * - fund-check: what the demo fund read on chain about one settlement transaction
 * - fund-refused: the demo fund did not cosign a month, and why
 * - witness-refused: the demo witness refused a month, and why; the statement stays as it is and the log goes on
 * - retire: the log retired after END_DATE, with its final statement's period
 */
export type Kind =
  | "genesis"
  | "cycle"
  | "intent"
  | "result"
  | "lookup"
  | "settled"
  | "cycle-end"
  | "close-intent"
  | "close"
  | "cosign"
  | "fund-check"
  | "fund-refused"
  | "witness-refused"
  | "retire";

// Bodies are JSON with bigints as decimal strings, so `any` is the honest type here.
export type Body = any;

export interface EventRow {
  seq: number;
  /** Unix seconds: the log clock for this step. */
  at: number;
  kind: Kind;
  /** Unique per kind. */
  key: string;
  body: Body;
}

export interface KeyRow {
  name: string;
  alg: string;
  kid: string;
  /** The private JWK (or, for the simulated payer, {hex}), as JSON. */
  jwk: string;
  created: number;
}

export interface SimOpRow {
  seq: number;
  at: number;
  op: string;
  body: Body;
}

/** The Durable Object's SQLite tables, or memory in the tests. */
export interface Store {
  /** Every event, in the order written. */
  events(): EventRow[];
  get(kind: Kind, key: string): EventRow | undefined;
  /** The newest rows of one kind, newest first. */
  recent(kind: Kind, limit: number): EventRow[];
  /** Append one event. A second row with the same kind and key throws: call sites check first. */
  append(kind: Kind, key: string, at: number, body: unknown): EventRow;
  getKey(name: string): KeyRow | undefined;
  putKey(row: KeyRow): void;
  /** Display and backoff only; never replayed. */
  status(k: string): Body;
  setStatus(k: string, v: unknown): void;
  simOps(): SimOpRow[];
  appendSimOp(at: number, op: string, body: unknown): void;
  /** Resolves once every write so far is durable. */
  sync(): Promise<void>;
}

/** JSON with bigints as decimal strings. */
export const toJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/**
 * What a submission came to, once final. A failure says whether the chain
 * showed the authorization used (`used`: by a transfer that is not the one
 * signed) or unused after its validBefore. Rows written before draft 3 have no
 * `used`, and some have `via: "engine"` (a share that was never sent).
 */
export type SubmitAnswer =
  | { ok: true; transaction: string; via: "facilitator" | "chain" }
  | { ok: false; error: string; via: "facilitator" | "chain" | "engine"; used?: boolean };

/**
 * EIP-3009 authorizationState as a recorded answer shows it: used, or unused after validBefore.
 * A row from before draft 3 without `used` is read from its text, and one answered by the engine
 * itself (never sent) is taken as unused, as the code that wrote it took it.
 */
export function usedOf(r: { ok: boolean; via?: string; error?: string; used?: unknown }): boolean {
  if (r.ok) return true;
  if (typeof r.used === "boolean") return r.used;
  return r.via === "chain" && typeof r.error === "string" && r.error.startsWith("the authorization was used by ");
}

export interface LookupAnswer {
  found: { transaction: string; token: string; to: string; value: string } | null;
  window: { fromBlock: string; toBlock: string } | null;
}

/** What JournalChain needs from the engine. */
export interface JournalBackend {
  /**
   * A recorded result or lookup body for this nonce (lowercase), if any. The
   * engine moves the log's clock to that row's time: the log reads the clock
   * after an answer (an exact share is uncollected only once its validBefore
   * has passed), and every reading comes from the record.
   */
  recorded(kind: "result" | "lookup", nonce: string): Body | undefined;
  /** Live only: submit write-ahead, wait for a final answer, record it, return it. */
  submitShare(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<SubmitAnswer>;
  /** Live only: look the authorization up on chain, record it, return it. */
  lookupShare(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<LookupAnswer>;
}

/**
 * The LogChain handed to SolidarityLog. It has submitExact,
 * findExactTransfer and authorizationUsed, journaled by nonce. It deliberately
 * has no verifyExact: with one, the log's check would take another path.
 * channelState is always undefined and claim always fails, since this log
 * lists only `exact`.
 *
 * authorizationUsed makes no chain call of its own: the log asks only after a
 * failed submission, whose recorded answer is final (the engine waits for the
 * chain to show the authorization used, or unused after validBefore) and says
 * which.
 *
 * replay: answers come only from recorded rows. A missing answer is a
 *   divergence and throws; the share then stays queued, and the engine's
 *   comparison with the recorded cycle-end catches it.
 * live: a recorded answer still comes first. Otherwise the engine acts.
 *   Anything that goes wrong inside the engine (not an answer from the
 *   chain) is kept as `fault`, so the engine can stop before it records a
 *   decision the log made only because of it.
 */
export class JournalChain implements LogChain {
  mode: "replay" | "live" = "replay";
  readonly divergence: string[] = [];
  fault: unknown = undefined;
  private readonly backend: JournalBackend;

  constructor(backend: JournalBackend) {
    this.backend = backend;
  }

  async submitExact(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<{ ok: true; transaction: string } | { ok: false; error: string }> {
    const nonce = payload.authorization.nonce.toLowerCase();
    const r = this.backend.recorded("result", nonce);
    if (r) return r.ok ? { ok: true, transaction: r.transaction } : { ok: false, error: r.error };
    if (this.mode === "replay") {
      this.divergence.push(`replay: no recorded submission for share nonce ${nonce}`);
      throw new Error("replay: no recorded submission");
    }
    try {
      const a = await this.backend.submitShare(accepted, payload);
      return a.ok ? { ok: true, transaction: a.transaction } : { ok: false, error: a.error };
    } catch (e) {
      this.fault ??= e;
      throw e;
    }
  }

  async findExactTransfer(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<{ transaction: string; token: string; to: string; value: bigint } | undefined> {
    const nonce = payload.authorization.nonce.toLowerCase();
    let r: LookupAnswer | undefined = this.backend.recorded("lookup", nonce);
    if (!r) {
      if (this.mode === "replay") {
        this.divergence.push(`replay: no recorded lookup for share nonce ${nonce}`);
        throw new Error("replay: no recorded lookup");
      }
      try {
        r = await this.backend.lookupShare(accepted, payload);
      } catch (e) {
        this.fault ??= e;
        throw e;
      }
    }
    return r.found ? { ...r.found, value: BigInt(r.found.value) } : undefined;
  }

  async authorizationUsed(_accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<boolean> {
    const nonce = payload.authorization.nonce.toLowerCase();
    const r = this.backend.recorded("result", nonce);
    if (r) return usedOf(r);
    const why = `no recorded submission to read authorizationState from for share nonce ${nonce}`;
    if (this.mode === "replay") this.divergence.push(`replay: ${why}`);
    else this.fault ??= new Error(why);
    throw new Error(why);
  }

  channelState(_channelId: string): undefined {
    return undefined;
  }

  async claim(_channelId: string, _voucher: VoucherFields, _totalClaimed: bigint): Promise<{ ok: false; error: string }> {
    this.divergence.push("claim called, but this log lists only exact shares");
    return { ok: false, error: "this log lists only exact shares" };
  }
}
