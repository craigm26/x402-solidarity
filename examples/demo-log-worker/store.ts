/**
 * Two Stores: SqlStore over a Durable Object's SQLite storage, and
 * MemoryStore for the tests, which can also act out a Durable Object reset.
 *
 * Rules for the events table: append only (never UPDATE or DELETE), and a
 * plain INSERT, so a second row with the same (kind, key) throws and shows
 * the bug instead of hiding it.
 */

import type { Body, EventRow, Kind, KeyRow, SimOpRow, Store } from "./journal.ts";
import { toJson } from "./journal.ts";

/** The parts of DurableObjectStorage this uses. */
export interface SqlStorageLike {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  sync?(): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    seq  INTEGER PRIMARY KEY AUTOINCREMENT,
    at   INTEGER NOT NULL,
    kind TEXT NOT NULL,
    key  TEXT NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (kind, key)
  )`,
  // recent(): the newest rows of one kind without reading and sorting every row of that kind.
  "CREATE INDEX IF NOT EXISTS events_kind_seq ON events (kind, seq)",
  "CREATE TABLE IF NOT EXISTS keys (name TEXT PRIMARY KEY, alg TEXT NOT NULL, kid TEXT NOT NULL, jwk TEXT NOT NULL, created INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS status (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sim_ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, op TEXT NOT NULL, body TEXT NOT NULL)",
];

const eventOf = (r: Record<string, unknown>): EventRow => ({ seq: Number(r.seq), at: Number(r.at), kind: r.kind as Kind, key: String(r.key), body: JSON.parse(String(r.body)) });

export class SqlStore implements Store {
  private readonly storage: SqlStorageLike;

  constructor(storage: SqlStorageLike) {
    this.storage = storage;
    for (const q of SCHEMA) storage.sql.exec(q);
  }

  private q(query: string, ...b: unknown[]): Record<string, unknown>[] {
    return this.storage.sql.exec(query, ...b).toArray();
  }

  events(): EventRow[] {
    return this.q("SELECT seq, at, kind, key, body FROM events ORDER BY seq").map(eventOf);
  }

  get(kind: Kind, key: string): EventRow | undefined {
    const r = this.q("SELECT seq, at, kind, key, body FROM events WHERE kind = ? AND key = ?", kind, key);
    return r.length ? eventOf(r[0]) : undefined;
  }

  recent(kind: Kind, limit: number): EventRow[] {
    return this.q("SELECT seq, at, kind, key, body FROM events WHERE kind = ? ORDER BY seq DESC LIMIT ?", kind, limit).map(eventOf);
  }

  append(kind: Kind, key: string, at: number, body: unknown): EventRow {
    const text = toJson(body);
    const r = this.q("INSERT INTO events (at, kind, key, body) VALUES (?, ?, ?, ?) RETURNING seq", at, kind, key, text);
    return { seq: Number(r[0].seq), at, kind, key, body: JSON.parse(text) };
  }

  getKey(name: string): KeyRow | undefined {
    const r = this.q("SELECT name, alg, kid, jwk, created FROM keys WHERE name = ?", name);
    return r.length ? { name: String(r[0].name), alg: String(r[0].alg), kid: String(r[0].kid), jwk: String(r[0].jwk), created: Number(r[0].created) } : undefined;
  }

  putKey(row: KeyRow): void {
    this.q("INSERT INTO keys (name, alg, kid, jwk, created) VALUES (?, ?, ?, ?, ?)", row.name, row.alg, row.kid, row.jwk, row.created);
  }

  status(k: string): Body {
    const r = this.q("SELECT v FROM status WHERE k = ?", k);
    return r.length ? JSON.parse(String(r[0].v)) : undefined;
  }

  setStatus(k: string, v: unknown): void {
    this.q("INSERT INTO status (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, toJson(v));
  }

  simOps(): SimOpRow[] {
    return this.q("SELECT seq, at, op, body FROM sim_ops ORDER BY seq").map((r) => ({ seq: Number(r.seq), at: Number(r.at), op: String(r.op), body: JSON.parse(String(r.body)) }));
  }

  appendSimOp(at: number, op: string, body: unknown): void {
    this.q("INSERT INTO sim_ops (at, op, body) VALUES (?, ?, ?)", at, op, toJson(body));
  }

  async sync(): Promise<void> {
    // Durable Objects already hold outgoing fetches until earlier writes are confirmed (the
    // output gate). Waiting here as well keeps the write-ahead order explicit.
    if (typeof this.storage.sync === "function") await this.storage.sync();
  }
}

/** Thrown when a test kills the store: the Durable Object is gone mid-step. */
export class Crash extends Error {
  constructor(where = "the Durable Object was reset") {
    super(where);
    this.name = "Crash";
  }
}

type Op =
  | { t: "event"; row: EventRow }
  | { t: "key"; row: KeyRow }
  | { t: "status"; k: string; v: string }
  | { t: "sim"; row: SimOpRow };

/**
 * Memory with a "synced" watermark. sync() and every IO call (gate(), the
 * output gate) move it to the end; crash() drops everything written after it,
 * which is what a Durable Object reset does to unconfirmed writes.
 */
export class MemoryStore implements Store {
  private ops: Op[] = [];
  private synced = 0;
  private dead = false;
  private evs: EventRow[] = [];
  private idx = new Map<string, EventRow>();
  private keys = new Map<string, KeyRow>();
  private st = new Map<string, string>();
  private sims: SimOpRow[] = [];
  /** Test hook, called before each append: throw (usually kill()) to stop there. */
  onAppend: ((kind: Kind, key: string, body: unknown) => void) | undefined;

  private apply(op: Op): void {
    if (op.t === "event") {
      this.evs.push(op.row);
      this.idx.set(`${op.row.kind}\u0000${op.row.key}`, op.row);
    } else if (op.t === "key") this.keys.set(op.row.name, op.row);
    else if (op.t === "status") this.st.set(op.k, op.v);
    else this.sims.push(op.row);
  }

  private write(op: Op): void {
    if (this.dead) throw new Crash("write after the reset");
    this.ops.push(op);
    this.apply(op);
  }

  private alive(): void {
    if (this.dead) throw new Crash("read after the reset");
  }

  events(): EventRow[] {
    this.alive();
    return [...this.evs];
  }

  get(kind: Kind, key: string): EventRow | undefined {
    this.alive();
    return this.idx.get(`${kind}\u0000${key}`);
  }

  recent(kind: Kind, limit: number): EventRow[] {
    this.alive();
    return this.evs.filter((e) => e.kind === kind).reverse().slice(0, limit);
  }

  append(kind: Kind, key: string, at: number, body: unknown): EventRow {
    this.alive();
    this.onAppend?.(kind, key, body);
    if (this.idx.has(`${kind}\u0000${key}`)) throw new Error(`UNIQUE constraint failed: events ${kind} ${key}`);
    const row: EventRow = { seq: (this.evs.at(-1)?.seq ?? 0) + 1, at, kind, key, body: JSON.parse(toJson(body)) };
    this.write({ t: "event", row });
    return row;
  }

  getKey(name: string): KeyRow | undefined {
    this.alive();
    return this.keys.get(name);
  }

  putKey(row: KeyRow): void {
    if (this.keys.has(row.name)) throw new Error(`UNIQUE constraint failed: keys ${row.name}`);
    this.write({ t: "key", row });
  }

  status(k: string): Body {
    this.alive();
    const v = this.st.get(k);
    return v === undefined ? undefined : JSON.parse(v);
  }

  setStatus(k: string, v: unknown): void {
    this.write({ t: "status", k, v: toJson(v) });
  }

  simOps(): SimOpRow[] {
    this.alive();
    return [...this.sims];
  }

  appendSimOp(at: number, op: string, body: unknown): void {
    this.write({ t: "sim", row: { seq: this.sims.length + 1, at, op, body: JSON.parse(toJson(body)) } });
  }

  async sync(): Promise<void> {
    this.alive();
    this.synced = this.ops.length;
  }

  /** An IO call left the object: everything written before it is confirmed. */
  gate(): void {
    if (!this.dead) this.synced = this.ops.length;
  }

  /** Stop the object here: every later read or write throws. Returns the Crash to throw. */
  kill(where?: string): Crash {
    this.dead = true;
    return new Crash(where);
  }

  /** The reset itself: unconfirmed writes are gone and a new instance may start. */
  crash(): void {
    this.ops = this.ops.slice(0, this.synced);
    this.evs = [];
    this.idx = new Map();
    this.keys = new Map();
    this.st = new Map();
    this.sims = [];
    for (const op of this.ops) this.apply(op);
    this.dead = false;
    this.onAppend = undefined;
  }

  /** Tests only: change a stored event in place, as if the storage had been tampered with. */
  tamper(kind: Kind, key: string, change: (body: Body) => Body): void {
    const row = this.idx.get(`${kind}\u0000${key}`);
    if (!row) throw new Error(`no ${kind} ${key}`);
    row.body = change(row.body);
  }

  get unsynced(): number {
    return this.ops.length - this.synced;
  }
}
