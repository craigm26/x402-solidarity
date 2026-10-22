/**
 * Receipt attestation ("Receipt attestation"): lines, batches, settlement
 * references, statements, JWS signatures, witnesses and receipts. The same in
 * both modes.
 *
 * Signatures use node:crypto: Ed25519 ("EdDSA") and P-256 ("ES256", with the
 * raw r||s encoding JWS requires).
 */

import type { KeyObject } from "node:crypto";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { canonicalizeStrict, isCanonical } from "./jcs.ts";
import { buildTree, EMPTY_ROOT_HEX, verifyInclusion } from "./merkle.ts";
import type { JwsEnvelope, LogDescriptor, PublishedStatement, Receipt, StatementPayload, TotalsRow } from "./types.ts";
import { AMOUNT_PATTERN, LINE_PREFIX, PERIOD_PATTERN, SHARE_ID_PATTERN } from "./types.ts";
import { b64url, bytewise, canonicalAccount, nextPeriod, parseCaip10, unb64url } from "./utils.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const FIELD = /^[\x21-\x7b\x7d\x7e]+$/; // printable ASCII, no space, no '|'

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

// ---- lines -----------------------------------------------------------------

export interface LineFields {
  period: string;
  fund: string;
  asset: string;
  id: string;
  amount: string | bigint;
}

/** `solidarity/2|<period>|<fund>|<asset>|<id>|<amount>`, with EVM addresses lowercased. */
export function formatLine(f: LineFields): string {
  const v = { period: f.period, fund: canonicalAccount(f.fund), asset: canonicalAccount(f.asset), id: f.id, amount: String(f.amount) };
  for (const [k, x] of Object.entries(v)) if (!FIELD.test(x)) throw new Error(`line field ${k} must be printable ASCII with no '|' or space`);
  if (!PERIOD_PATTERN.test(v.period)) throw new Error("period must be YYYY-MM");
  if (!SHARE_ID_PATTERN.test(v.id)) throw new Error("id must be 22 to 128 characters of [A-Za-z0-9_-]");
  if (!AMOUNT_PATTERN.test(v.amount)) throw new Error("amount must be a positive integer with no leading zeros");
  return `${LINE_PREFIX}|${v.period}|${v.fund}|${v.asset}|${v.id}|${v.amount}`;
}

export function parseLine(line: string): { period: string; fund: string; asset: string; id: string; amount: string } {
  const parts = line.split("|");
  if (parts.length !== 6 || parts[0] !== LINE_PREFIX) throw new Error("not a solidarity/2 line");
  const [, period, fund, asset, id, amount] = parts;
  const out = { period, fund, asset, id, amount };
  if (formatLine(out) !== line) throw new Error("line is not in canonical form");
  return out;
}

/** A /lines or /settlements file: entries sorted bytewise, each followed by one LF. */
export const fileBody = (entries: string[]): string => [...entries].sort(bytewise).map((e) => `${e}\n`).join("");

export function parseFileBody(body: string): string[] {
  if (body === "") return [];
  if (!body.endsWith("\n")) throw new Error("every entry must end with LF");
  const entries = body.slice(0, -1).split("\n");
  if (entries.some((e) => e === "")) throw new Error("empty entry");
  const sorted = [...entries].sort(bytewise);
  if (sorted.some((e, i) => e !== entries[i])) throw new Error("entries are not sorted bytewise");
  return entries;
}

// ---- batches -----------------------------------------------------------------

export interface Batch {
  period: string | null;
  lines: string[];
  size: number;
  root: string;
  totals: TotalsRow[];
  proof(index: number): string[];
  indexOf(id: string): number;
}

/** One closed batch for one (log, period). An empty batch has size 0 and root SHA-256(""). */
export function buildBatch(lines: string[]): Batch {
  const sorted = [...lines].sort(bytewise);
  const ids = new Map<string, number>();
  const periods = new Set<string>();
  const sums = new Map<string, { fund: string; asset: string; lines: number; amount: bigint }>();
  sorted.forEach((line, i) => {
    const l = parseLine(line);
    if (ids.has(l.id)) throw new Error(`id ${l.id} appears twice`);
    ids.set(l.id, i);
    periods.add(l.period);
    const key = `${l.fund}|${l.asset}`;
    const t = sums.get(key) ?? { fund: l.fund, asset: l.asset, lines: 0, amount: 0n };
    t.lines += 1;
    t.amount += BigInt(l.amount);
    sums.set(key, t);
  });
  if (periods.size > 1) throw new Error("a batch holds one period");
  const totals = [...sums.values()]
    .sort((a, b) => bytewise(a.fund, b.fund) || bytewise(a.asset, b.asset))
    .map((t) => ({ fund: t.fund, asset: t.asset, lines: t.lines, amount: t.amount.toString() }));
  const tree = buildTree(sorted);
  if (sorted.length === 0 && tree.rootHex !== EMPTY_ROOT_HEX) throw new Error("empty root mismatch");
  return {
    period: [...periods][0] ?? null,
    lines: sorted,
    size: tree.size,
    root: tree.rootHex,
    totals,
    proof: (i) => tree.proof(i),
    indexOf: (id) => ids.get(id) ?? -1,
  };
}

// ---- settlement references -------------------------------------------------------

export interface SettlementFields {
  fund: string;
  asset: string;
  ref: string;
  amount: string | bigint;
}

/** `<fund>|<asset>|<ref>|<amount>`, ref one of exact:<tx>, claim:<tx>:<channelId>, payout:<reference>. */
export function formatSettlement(f: SettlementFields): string {
  const v = { fund: canonicalAccount(f.fund), asset: canonicalAccount(f.asset), ref: f.ref, amount: String(f.amount) };
  for (const [k, x] of Object.entries(v)) if (!FIELD.test(x)) throw new Error(`settlement field ${k} must be printable ASCII with no '|' or space`);
  if (!/^(exact:[^:]+|claim:[^:]+:[^:]+|payout:.+)$/.test(v.ref)) throw new Error("ref must be exact:<tx>, claim:<tx>:<channelId> or payout:<reference>");
  if (!AMOUNT_PATTERN.test(v.amount)) throw new Error("amount must be a positive integer with no leading zeros");
  return `${v.fund}|${v.asset}|${v.ref}|${v.amount}`;
}

export function parseSettlement(entry: string): { fund: string; asset: string; ref: string; amount: string } {
  const parts = entry.split("|");
  if (parts.length !== 4) throw new Error("not a settlement entry");
  const [fund, asset, ref, amount] = parts;
  const out = { fund, asset, ref, amount };
  if (formatSettlement(out) !== entry) throw new Error("settlement entry is not in canonical form");
  return out;
}

/** For each (fund, asset), the settlement amounts add up to the totals row, and no other pair appears. */
export function settlementsMatchTotals(entries: string[], totals: TotalsRow[]): boolean {
  const sums = new Map<string, bigint>();
  for (const e of entries) {
    const s = parseSettlement(e);
    const key = `${s.fund}|${s.asset}`;
    sums.set(key, (sums.get(key) ?? 0n) + BigInt(s.amount));
  }
  if (sums.size !== totals.length) return false;
  return totals.every((t) => sums.get(`${t.fund}|${t.asset}`) === BigInt(t.amount));
}

// ---- statements -----------------------------------------------------------------

export function statementPayload(p: {
  log: string;
  period: string;
  batch: Pick<Batch, "size" | "root" | "totals">;
  settlementsBody: string;
  previous: string | null;
  issuedAt: number;
}): StatementPayload {
  return {
    version: 2,
    log: p.log,
    period: p.period,
    size: p.batch.size,
    root: p.batch.root,
    totals: p.batch.totals,
    settlements: sha256Hex(p.settlementsBody),
    previous: p.previous,
    issuedAt: p.issuedAt,
  };
}

export const statementBytes = (payload: StatementPayload): Uint8Array => enc.encode(canonicalizeStrict(payload));
export const statementHash = (payload: StatementPayload): string => sha256Hex(statementBytes(payload));

// ---- keys and JWS -------------------------------------------------------------------

export type JwsAlg = "EdDSA" | "ES256";

export interface SigningKey {
  alg: JwsAlg;
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** An Ed25519 key from its 32-byte seed (RFC 8032 secret key), as hex. */
export function ed25519FromSeed(seedHex: string, kid: string): SigningKey {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  return { alg: "EdDSA", kid, privateKey, publicKey: createPublicKey(privateKey) };
}

export function ed25519PublicKey(publicKeyHex: string): KeyObject {
  const raw = Buffer.from(publicKeyHex, "hex");
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function ed25519PublicKeyHex(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" }) as Buffer;
  return der.subarray(ED25519_SPKI_PREFIX.length).toString("hex");
}

/** A fresh throwaway key. */
export function generateSigningKey(alg: JwsAlg, kid: string): SigningKey {
  const pair = alg === "EdDSA" ? generateKeyPairSync("ed25519") : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { alg, kid, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

function rawSign(alg: JwsAlg, data: Uint8Array, key: KeyObject): Uint8Array {
  if (alg === "EdDSA") return new Uint8Array(nodeSign(null, data, key));
  return new Uint8Array(nodeSign("sha256", data, { key, dsaEncoding: "ieee-p1363" }));
}

function rawVerify(alg: JwsAlg, data: Uint8Array, key: KeyObject, sig: Uint8Array): boolean {
  try {
    if (alg === "EdDSA") return nodeVerify(null, data, key, sig);
    if (sig.length !== 64) return false;
    return nodeVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}

/** JWS compact serialization (RFC 7515). The protected header is `{alg, kid}` in JCS form. */
export function jwsSign(payloadBytes: Uint8Array, key: SigningKey): string {
  const header = canonicalizeStrict({ alg: key.alg, kid: key.kid });
  const input = `${b64url(enc.encode(header))}.${b64url(payloadBytes)}`;
  return `${input}.${b64url(rawSign(key.alg, enc.encode(input), key.privateKey))}`;
}

export interface DecodedJws {
  header: { alg: string; kid: string; [k: string]: unknown };
  payloadBytes: Uint8Array;
  payloadText: string;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

export function jwsDecode(compact: string): DecodedJws {
  const parts = compact.split(".");
  if (parts.length !== 3) throw new Error("not a JWS compact serialization");
  const header = JSON.parse(dec.decode(unb64url(parts[0])));
  if (typeof header?.alg !== "string" || typeof header?.kid !== "string") throw new Error("JWS header needs alg and kid");
  const payloadBytes = unb64url(parts[1]);
  return {
    header,
    payloadBytes,
    payloadText: dec.decode(payloadBytes),
    signingInput: enc.encode(`${parts[0]}.${parts[1]}`),
    signature: unb64url(parts[2]),
  };
}

export function jwsVerify(compact: string, publicKey: KeyObject): boolean {
  let d: DecodedJws;
  try {
    d = jwsDecode(compact);
  } catch {
    return false;
  }
  if (d.header.alg !== "EdDSA" && d.header.alg !== "ES256") return false;
  return rawVerify(d.header.alg, d.signingInput, publicKey, d.signature);
}

/** Sign a statement payload: `{statement, cosignatures: []}` as published at /statements/<period>. */
export function signStatement(payload: StatementPayload, key: SigningKey): PublishedStatement {
  return { statement: { format: "jws", signature: jwsSign(statementBytes(payload), key) }, cosignatures: [] };
}

/** Decode a statement envelope; rejects a payload whose bytes are not the JCS form of its content. */
export function decodeStatement(env: JwsEnvelope): { payload: StatementPayload; bytes: Uint8Array; hash: string; kid: string; alg: string } {
  if (env?.format !== "jws") throw new Error("statement format must be jws");
  const d = jwsDecode(env.signature);
  if (!isCanonical(d.payloadText, { strictIntegers: true })) throw new Error("statement payload is not in JCS form");
  const payload = JSON.parse(d.payloadText) as StatementPayload;
  if (payload.version !== 2) throw new Error("not a version 2 statement");
  return { payload, bytes: d.payloadBytes, hash: sha256Hex(d.payloadBytes), kid: d.header.kid, alg: d.header.alg };
}

/** Resolves a DID URL `kid` to a public key. A real verifier uses did:web or DNS (offer-and-receipt section 4.5.1). */
export type KeyResolver = (kid: string) => KeyObject | undefined;

export function staticResolver(keys: Record<string, KeyObject>): KeyResolver {
  return (kid) => keys[kid];
}

/** Is `kid` listed in the descriptor for `period` (from <= period <= until, until null = current)? */
export function keyCoversPeriod(descriptor: Pick<LogDescriptor, "keys">, kid: string, period: string): boolean {
  return descriptor.keys.some((k) => k.kid === kid && k.from <= period && (k.until === null || period <= k.until));
}

export interface StatementCheck {
  ok: boolean;
  payload?: StatementPayload;
  hash?: string;
  problems: string[];
  cosigners: string[];
}

/**
 * Verify a published statement: JCS form, version, the log's signature (by a
 * key the descriptor lists for that period, when a descriptor is given) and
 * every cosignature the verifier requires (by kid).
 */
export function verifyStatement(
  pub: PublishedStatement,
  opts: { resolveKey: KeyResolver; descriptor?: Pick<LogDescriptor, "keys" | "log">; requireCosigners?: string[] },
): StatementCheck {
  const problems: string[] = [];
  let d: ReturnType<typeof decodeStatement>;
  try {
    d = decodeStatement(pub.statement);
  } catch (e) {
    return { ok: false, problems: [(e as Error).message], cosigners: [] };
  }
  if (opts.descriptor) {
    if (opts.descriptor.log !== d.payload.log) problems.push("statement is for another log");
    if (!keyCoversPeriod(opts.descriptor, d.kid, d.payload.period)) problems.push(`key ${d.kid} is not listed for ${d.payload.period}`);
  }
  const logKey = opts.resolveKey(d.kid);
  if (!logKey) problems.push(`no key for ${d.kid}`);
  else if (!jwsVerify(pub.statement.signature, logKey)) problems.push("log signature invalid");

  const cosigners: string[] = [];
  for (const c of pub.cosignatures ?? []) {
    try {
      const cd = jwsDecode(c.signature);
      if (Buffer.compare(Buffer.from(cd.payloadBytes), Buffer.from(d.bytes)) !== 0) continue;
      const k = opts.resolveKey(cd.header.kid);
      if (k && jwsVerify(c.signature, k)) cosigners.push(cd.header.kid);
    } catch {
      // an unreadable cosignature simply does not count
    }
  }
  for (const r of opts.requireCosigners ?? []) if (!cosigners.includes(r)) problems.push(`missing valid cosignature by ${r}`);
  return { ok: problems.length === 0, payload: d.payload, hash: d.hash, problems, cosigners };
}

/** Statements chain by `previous` and cover consecutive periods (a gap is visible). */
export function verifyChain(pubs: PublishedStatement[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  let prev: { hash: string; period: string; log: string } | undefined;
  // The first statement given may be mid-chain (its `previous` is not checked here).
  pubs.forEach((p) => {
    const d = decodeStatement(p.statement);
    if (prev) {
      if (d.payload.log !== prev.log) problems.push(`${d.payload.period}: another log`);
      if (d.payload.period !== nextPeriod(prev.period)) problems.push(`${d.payload.period}: does not follow ${prev.period}`);
      if (d.payload.previous !== prev.hash) problems.push(`${d.payload.period}: previous does not match`);
    }
    prev = { hash: d.hash, period: d.payload.period, log: d.payload.log };
  });
  return { ok: problems.length === 0, problems };
}

// ---- receipts -------------------------------------------------------------------------

export function buildReceipt(pub: PublishedStatement, batch: Batch, id: string): Receipt {
  const index = batch.indexOf(id);
  if (index < 0) throw new Error(`id ${id} is not in the batch`);
  return { version: 2, line: batch.lines[index], index, proof: batch.proof(index), statement: pub.statement, cosignatures: pub.cosignatures };
}

export interface ReceiptCheck {
  ok: boolean;
  canonical: boolean;
  period: boolean;
  included: boolean;
  signature: boolean;
  cosigners: string[];
  problems: string[];
}

/**
 * "To verify a receipt, decode the statement payload and check that it is in
 * JCS form, verify the log's signature and the cosignatures the verifier
 * requires, check that the line's period equals the statement's, and verify
 * the audit path."
 */
export function verifyReceipt(
  receipt: Receipt,
  opts: { resolveKey: KeyResolver; descriptor?: Pick<LogDescriptor, "keys" | "log">; requireCosigners?: string[] },
): ReceiptCheck {
  const out: ReceiptCheck = { ok: false, canonical: false, period: false, included: false, signature: false, cosigners: [], problems: [] };
  if (receipt?.version !== 2) {
    out.problems.push("receipt version must be 2");
    return out;
  }
  const st = verifyStatement({ statement: receipt.statement, cosignatures: receipt.cosignatures ?? [] }, opts);
  out.cosigners = st.cosigners;
  out.problems.push(...st.problems);
  if (!st.payload) return out;
  out.canonical = true;
  out.signature = !st.problems.some((p) => p.startsWith("log signature") || p.startsWith("no key"));
  try {
    out.period = parseLine(receipt.line).period === st.payload.period;
  } catch (e) {
    out.problems.push((e as Error).message);
  }
  if (!out.period) out.problems.push("line period does not match the statement");
  out.included = verifyInclusion(receipt.line, receipt.index, st.payload.size, receipt.proof, st.payload.root);
  if (!out.included) out.problems.push("audit path does not lead to the root");
  out.ok = out.problems.length === 0;
  return out;
}

// ---- witnesses ---------------------------------------------------------------------------

/**
 * A witness ("Witnesses"). Before cosigning it verifies the log's signature,
 * checks that `previous` equals the hash of the last payload it cosigned for
 * this log (or walks the chain back to it through `history`), and never
 * cosigns two different payloads for one (log, period). It may also recompute
 * root, size, totals and settlements from the published files.
 */
export class Witness {
  readonly key: SigningKey;
  private readonly last = new Map<string, { hash: string; period: string }>();
  private readonly signed = new Map<string, string>(); // `${log} ${period}` -> payload hash

  constructor(key: SigningKey) {
    this.key = key;
  }

  cosign(
    pub: PublishedStatement,
    opts: {
      resolveKey: KeyResolver;
      descriptor?: Pick<LogDescriptor, "keys" | "log">;
      history?: PublishedStatement[];
      files?: { lines: string; settlements: string };
    },
  ): JwsEnvelope {
    const st = verifyStatement({ statement: pub.statement, cosignatures: [] }, { resolveKey: opts.resolveKey, descriptor: opts.descriptor });
    if (!st.ok || !st.payload || !st.hash) throw new Error(`witness refuses: ${st.problems.join("; ")}`);
    const p = st.payload;
    const slot = `${p.log} ${p.period}`;
    const already = this.signed.get(slot);
    if (already !== undefined && already !== st.hash) throw new Error(`witness refuses: already cosigned another payload for ${p.period}`);

    if (already === undefined) {
      const last = this.last.get(p.log);
      if (last) {
        let hash = last.hash;
        let period = last.period;
        for (const h of opts.history ?? []) {
          const hs = verifyStatement({ statement: h.statement, cosignatures: [] }, { resolveKey: opts.resolveKey, descriptor: opts.descriptor });
          if (!hs.ok || !hs.payload || !hs.hash) throw new Error("witness refuses: a history statement does not verify");
          if (hs.payload.log !== p.log || hs.payload.previous !== hash || hs.payload.period !== nextPeriod(period)) {
            throw new Error("witness refuses: history does not chain to the last cosigned payload");
          }
          hash = hs.hash;
          period = hs.payload.period;
        }
        if (p.previous !== hash || p.period !== nextPeriod(period)) {
          throw new Error("witness refuses: previous does not chain to the last payload it cosigned");
        }
      }
      if (opts.files) {
        const lines = parseFileBody(opts.files.lines);
        const b = buildBatch(lines);
        if (b.root !== p.root || b.size !== p.size || canonicalizeStrict(b.totals) !== canonicalizeStrict(p.totals)) {
          throw new Error("witness refuses: lines do not reproduce root, size and totals");
        }
        if (sha256Hex(opts.files.settlements) !== p.settlements) throw new Error("witness refuses: settlements file hash differs");
        if (!settlementsMatchTotals(parseFileBody(opts.files.settlements), p.totals)) throw new Error("witness refuses: settlements do not add up to totals");
      }
    }
    this.signed.set(slot, st.hash);
    const prevLast = this.last.get(p.log);
    if (!prevLast || p.period > prevLast.period) this.last.set(p.log, { hash: st.hash, period: p.period });
    return { format: "jws", signature: jwsSign(statementBytesFrom(pub), this.key) };
  }
}

/** The exact payload bytes of a published statement (the bytes cosignatures sign). */
export function statementBytesFrom(pub: PublishedStatement): Uint8Array {
  return decodeStatement(pub.statement).bytes;
}

// ---- the fund's "money arrived" attestation -------------------------------------------------

/** What the fund can see of its own receipts (its chain view, or its bank records for payouts). */
export interface FundView {
  /** An exact share transfer: token, recipient and value of the transfer in transaction `tx`. */
  exactTransfer(tx: string): { token: string; to: string; value: bigint } | undefined;
  /** The increase in `totalClaimed` that claim transaction `tx` made on `channelId`, with that channel's config. */
  claimIncrease(tx: string, channelId: string): { receiver: string; receiverAuthorizer: string; token: string; increase: bigint } | undefined;
  /** A processor-mode payout the fund received. */
  payout?(reference: string): { asset: string; amount: bigint } | undefined;
}

/**
 * A fund that cosigns a statement attests, for every totals row that names it,
 * that each settlement reference listed for it exists and is credited to it,
 * that no other log it has cosigned lists the same reference, and that the
 * amounts add up to the row.
 */
export class FundCosigner {
  readonly fund: string;
  readonly key: SigningKey;
  readonly view: FundView;
  /** receiverAuthorizer of each log, from the log's descriptor. */
  readonly logAuthorizers: Map<string, string>;
  private readonly refs = new Map<string, { log: string; used: bigint }>();
  private readonly done = new Map<string, { hash: string; envelope: JwsEnvelope }>();

  constructor(opts: { fund: string; key: SigningKey; view: FundView; logAuthorizers?: Record<string, string> }) {
    this.fund = canonicalAccount(opts.fund);
    this.key = opts.key;
    this.view = opts.view;
    this.logAuthorizers = new Map(Object.entries(opts.logAuthorizers ?? {}));
  }

  cosign(pub: PublishedStatement, settlementsBody: string, opts: { resolveKey: KeyResolver; descriptor?: Pick<LogDescriptor, "keys" | "log"> }): JwsEnvelope {
    const st = verifyStatement({ statement: pub.statement, cosignatures: [] }, opts);
    if (!st.ok || !st.payload) throw new Error(`fund refuses: ${st.problems.join("; ")}`);
    const p = st.payload;
    const slot = `${p.log} ${p.period}`;
    const prev = this.done.get(slot);
    if (prev) {
      if (prev.hash === st.hash) return prev.envelope;
      throw new Error(`fund refuses: already cosigned another payload for ${p.period}`);
    }
    if (sha256Hex(settlementsBody) !== p.settlements) throw new Error("fund refuses: settlements file hash differs");
    const entries = parseFileBody(settlementsBody).map(parseSettlement);
    // On-chain references need a CAIP-10 fund; a processor-mode fund may be a URI with payouts only.
    let fundAddr: string | undefined;
    try {
      fundAddr = parseCaip10(this.fund).address.toLowerCase();
    } catch {
      fundAddr = undefined;
    }
    const pending = new Map<string, bigint>();
    for (const row of p.totals.filter((t) => t.fund === this.fund)) {
      let sum = 0n;
      for (const e of entries.filter((x) => x.fund === row.fund && x.asset === row.asset)) {
        const amt = BigInt(e.amount);
        sum += amt;
        const prior = this.refs.get(e.ref);
        if (prior && prior.log !== p.log) throw new Error(`fund refuses: ${e.ref} is already listed by another log`);
        const [kind, ...rest] = e.ref.split(":");
        if (kind === "exact") {
          const t = this.view.exactTransfer(rest.join(":"));
          if (!t || !fundAddr || t.to.toLowerCase() !== fundAddr || canonicalAccount(t.token) !== row.asset || t.value !== amt) {
            throw new Error(`fund refuses: ${e.ref} is not a transfer of ${e.amount} to the fund`);
          }
          if (prior) throw new Error(`fund refuses: ${e.ref} listed twice`);
        } else if (kind === "claim") {
          const [tx, channelId] = rest;
          const c = this.view.claimIncrease(tx, channelId);
          const auth = this.logAuthorizers.get(p.log);
          if (!c || !fundAddr || c.receiver.toLowerCase() !== fundAddr || canonicalAccount(c.token) !== row.asset || !auth || c.receiverAuthorizer.toLowerCase() !== auth.toLowerCase()) {
            throw new Error(`fund refuses: ${e.ref} is not a claim on a channel paying the fund under this log`);
          }
          const used = (prior?.used ?? 0n) + (pending.get(e.ref) ?? 0n) + amt;
          if (used > c.increase) throw new Error(`fund refuses: ${e.ref} attributes more than the claim's increase`);
          pending.set(e.ref, (pending.get(e.ref) ?? 0n) + amt);
        } else if (kind === "payout") {
          const r = this.view.payout?.(rest.join(":"));
          if (!r || canonicalAccount(r.asset) !== row.asset || r.amount !== amt) throw new Error(`fund refuses: payout ${e.ref} not found`);
          if (prior) throw new Error(`fund refuses: ${e.ref} listed twice`);
        }
        if (kind !== "claim") pending.set(e.ref, amt);
      }
      if (sum !== BigInt(row.amount)) throw new Error(`fund refuses: settlements for ${row.asset} do not add up to the totals row`);
    }
    for (const [ref, amt] of pending) this.refs.set(ref, { log: p.log, used: (this.refs.get(ref)?.used ?? 0n) + amt });
    const envelope: JwsEnvelope = { format: "jws", signature: jwsSign(statementBytesFrom(pub), this.key) };
    this.done.set(slot, { hash: st.hash as string, envelope });
    return envelope;
  }
}
