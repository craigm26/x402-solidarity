/**
 * Receipt attestation (https://craigmerry.com/solidarity-levy/spec/attestation.md): lines, batches,
 * settlement references, statements, JWS signatures, witnesses and receipts.
 * The same in both modes.
 *
 * Signatures use node:crypto: Ed25519 ("EdDSA") and P-256 ("ES256", with the
 * raw r||s encoding JWS requires).
 */

import type { JsonWebKey, KeyObject } from "node:crypto";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { canonicalizeStrict, isCanonical } from "./jcs.ts";
import { buildTree, EMPTY_ROOT_HEX, verifyInclusion } from "./merkle.ts";
import type { DescriptorKey, JwsEnvelope, LogDescriptor, PublicJwk, PublishedStatement, Receipt, StatementPayload, TotalsRow } from "./types.ts";
import { AMOUNT_PATTERN, LINE_PREFIX, PERIOD_PATTERN, SHARE_ID_PATTERN } from "./types.ts";
import { b64url, bytewise, canonicalAccount, nextPeriod, parseCaip10, sameAccount, unb64url } from "./utils.ts";

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

/** A /lines or /settlements file: entries sorted bytewise, each followed by one LF. Throws on a repeated entry. */
export function fileBody(entries: string[]): string {
  const sorted = [...entries].sort(bytewise);
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new Error("an entry is repeated");
  return sorted.map((e) => `${e}\n`).join("");
}

/** Entries of a /lines or /settlements file: sorted bytewise, none repeated, each ending in LF. */
export function parseFileBody(body: string): string[] {
  if (body === "") return [];
  if (!body.endsWith("\n")) throw new Error("every entry must end with LF");
  const entries = body.slice(0, -1).split("\n");
  if (entries.some((e) => e === "")) throw new Error("empty entry");
  for (let i = 1; i < entries.length; i++) {
    const c = bytewise(entries[i - 1], entries[i]);
    if (c > 0) throw new Error("entries are not sorted bytewise");
    if (c === 0) throw new Error("an entry is repeated");
  }
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

/**
 * A settlement reference in canonical form: EVM hex (transaction hashes and
 * channel ids) lowercase, so one transfer or claim has exactly one spelling.
 * Payout references are the processor's own and are left as they are.
 */
export function canonicalRef(ref: string): string {
  const m = /^(exact|claim):(.*)$/.exec(ref);
  if (!m) return ref;
  return `${m[1]}:${m[2]
    .split(":")
    .map((x) => (/^0x[0-9a-fA-F]+$/.test(x) ? x.toLowerCase() : x))
    .join(":")}`;
}

const TX = "(?:0x[0-9a-f]{64}|(?!0x)[^:]+)"; // EVM hex is a 32-byte lowercase hash; other chains spell their own
const REF_PATTERN = new RegExp(`^(?:exact:${TX}|claim:${TX}:${TX}|payout:.+)$`);

/** `<fund>|<asset>|<ref>|<amount>`, ref one of exact:<tx>, claim:<tx>:<channelId>, payout:<reference>. */
export function formatSettlement(f: SettlementFields): string {
  const v = { fund: canonicalAccount(f.fund), asset: canonicalAccount(f.asset), ref: canonicalRef(f.ref), amount: String(f.amount) };
  for (const [k, x] of Object.entries(v)) if (!FIELD.test(x)) throw new Error(`settlement field ${k} must be printable ASCII with no '|' or space`);
  if (!REF_PATTERN.test(v.ref)) throw new Error("ref must be exact:<tx>, claim:<tx>:<channelId> or payout:<reference>");
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

/** The JWS `alg` is tied to the key type: EdDSA needs an Ed25519 key, ES256 a P-256 key (RFC 7515, RFC 8725 section 3.1). */
function rawVerify(alg: JwsAlg, data: Uint8Array, key: KeyObject, sig: Uint8Array): boolean {
  try {
    if (alg === "EdDSA") return key.asymmetricKeyType === "ed25519" && nodeVerify(null, data, key, sig);
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (key.asymmetricKeyType !== "ec" || (curve !== "prime256v1" && curve !== "P-256")) return false;
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

const HEX64 = /^[0-9a-f]{64}$/;
const STATEMENT_FIELDS = ["issuedAt", "log", "period", "previous", "root", "settlements", "size", "totals", "version"];
const TOTALS_FIELDS = ["amount", "asset", "fund", "lines"];
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Problems with a statement payload's fields (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Statements"): exactly the
 * listed fields, each of its type and form, and totals rows in the form
 * lines use, strictly sorted, adding up to `size`. [] when it is fine.
 */
export function statementProblems(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return ["payload is not an object"];
  const p = payload as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(p)) if (!STATEMENT_FIELDS.includes(k)) out.push(`unknown field ${k}`);
  for (const k of STATEMENT_FIELDS) if (!(k in p)) out.push(`missing ${k}`);
  if (p.version !== 2) out.push("version must be 2");
  if (typeof p.log !== "string" || !/^https:\/\/[\x21-\x7e]+$/.test(p.log)) out.push("log must be an https URL");
  if (typeof p.period !== "string" || !PERIOD_PATTERN.test(p.period)) out.push("period must be YYYY-MM");
  if (!isCount(p.size)) out.push("size must be a non-negative integer");
  if (typeof p.root !== "string" || !HEX64.test(p.root)) out.push("root must be 64 lowercase hex characters");
  if (typeof p.settlements !== "string" || !HEX64.test(p.settlements)) out.push("settlements must be 64 lowercase hex characters");
  if (p.previous !== null && (typeof p.previous !== "string" || !HEX64.test(p.previous))) out.push("previous must be null or 64 lowercase hex characters");
  if (!isCount(p.issuedAt)) out.push("issuedAt must be a non-negative integer");
  if (!Array.isArray(p.totals)) return [...out, "totals must be an array"];
  let lines = 0;
  let prev: { fund: string; asset: string } | undefined;
  p.totals.forEach((row: unknown, i: number) => {
    const r = row as Record<string, unknown>;
    if (typeof r !== "object" || r === null || Array.isArray(r) || Object.keys(r).sort().join() !== TOTALS_FIELDS.join()) {
      out.push(`totals[${i}] must have exactly fund, asset, lines and amount`);
      return;
    }
    for (const k of ["fund", "asset"] as const) {
      const v = r[k];
      if (typeof v !== "string" || !FIELD.test(v) || canonicalAccount(v) !== v) out.push(`totals[${i}].${k} is not in the form lines use`);
    }
    if (!Number.isSafeInteger(r.lines) || (r.lines as number) < 1) out.push(`totals[${i}].lines must be a positive integer`);
    else lines += r.lines as number;
    if (typeof r.amount !== "string" || !AMOUNT_PATTERN.test(r.amount)) out.push(`totals[${i}].amount must be a positive integer string`);
    const cur = { fund: String(r.fund), asset: String(r.asset) };
    if (prev && (bytewise(prev.fund, cur.fund) || bytewise(prev.asset, cur.asset)) >= 0) out.push(`totals[${i}] is out of order or repeated`);
    prev = cur;
  });
  if (isCount(p.size) && lines !== p.size) out.push("totals lines do not add up to size");
  if (p.size === 0 && p.root !== EMPTY_ROOT_HEX) out.push("an empty batch has the root SHA-256(\"\")");
  return out;
}

/** Decode a statement envelope; rejects a payload that is not in JCS form or whose fields are not as specified. */
export function decodeStatement(env: JwsEnvelope): { payload: StatementPayload; bytes: Uint8Array; hash: string; kid: string; alg: string } {
  if (env?.format !== "jws") throw new Error("statement format must be jws");
  const d = jwsDecode(env.signature);
  if (!isCanonical(d.payloadText, { strictIntegers: true })) throw new Error("statement payload is not in JCS form");
  const payload = JSON.parse(d.payloadText) as StatementPayload;
  if (payload?.version !== 2) throw new Error("not a version 2 statement");
  const problems = statementProblems(payload);
  if (problems.length) throw new Error(`statement payload: ${problems.join("; ")}`);
  return { payload, bytes: d.payloadBytes, hash: sha256Hex(d.payloadBytes), kid: d.header.kid, alg: d.header.alg };
}

/**
 * Resolves a DID URL `kid` to a public key. A real verifier uses did:web or
 * DNS (offer-and-receipt section 4.5.1). `context` says whose key is wanted:
 * the log named in the statement, or a cosigner of it.
 */
export type KeyResolver = (kid: string, context: { log: string; role: "log" | "cosigner" }) => KeyObject | undefined;

/** The host a did:web DID URL names (`did:web:example.com%3A8443:path#key` gives `example.com:8443`), or undefined. */
export function didWebHost(kid: string): string | undefined {
  const m = /^did:web:([^:#?/]+)/.exec(kid);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The default check that a statement key belongs to the log ("Signatures and
 * keys"): a did:web key on the log URL's host. A verifier that also accepts
 * the DNS route (`_controllers.<host>`) passes its own `authorizeLogKey`.
 */
export function kidOnLogHost(kid: string, log: string): boolean {
  let host: string;
  try {
    host = new URL(log).host.toLowerCase();
  } catch {
    return false;
  }
  return didWebHost(kid) === host;
}

/** What verifyStatement, verifyReceipt, Witness and FundCosigner take. */
export interface VerifyOptions {
  resolveKey: KeyResolver;
  /** The log's descriptor: the statement must be for its log, by a key it lists for the period. */
  descriptor?: Pick<LogDescriptor, "keys" | "log">;
  requireCosigners?: string[];
  /** Is `kid` authorized for `log`? Default: a did:web key on the log's host. */
  authorizeLogKey?: (kid: string, log: string) => boolean;
}

export function staticResolver(keys: Record<string, KeyObject>): KeyResolver {
  return (kid) => keys[kid];
}

/** Is `kid` listed in the descriptor for `period` (from <= period <= until, until null = current)? */
export function keyCoversPeriod(descriptor: Pick<LogDescriptor, "keys">, kid: string, period: string): boolean {
  return listedKey(descriptor, kid, period) !== undefined;
}

/** The descriptor's entry for `kid` that covers `period`, if any. */
export function listedKey(descriptor: Pick<LogDescriptor, "keys">, kid: string, period: string): DescriptorKey | undefined {
  return descriptor.keys.find((k) => k.kid === kid && k.from <= period && (k.until === null || period <= k.until));
}

/** A log's first period: the `from` of the earliest key in its descriptor (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Witnesses and the fund", "Publication"). */
export function firstPeriod(descriptor: Pick<LogDescriptor, "keys">): string | undefined {
  return descriptor.keys.map((k) => k.from).sort()[0];
}

/** A public key from a descriptor's JWK, or undefined if it is not a usable Ed25519 or P-256 key. */
export function publicKeyFromJwk(jwk: PublicJwk | undefined): KeyObject | undefined {
  if (!jwk || typeof jwk !== "object") return undefined;
  try {
    return createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
  } catch {
    return undefined;
  }
}

/** A key's public JWK, for a descriptor's `keys` entry. */
export function publicJwk(key: KeyObject): PublicJwk {
  const j = key.export({ format: "jwk" }) as PublicJwk;
  return j.kty === "EC" ? { kty: "EC", crv: j.crv, x: j.x, y: j.y } : { kty: j.kty, crv: j.crv, x: j.x };
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
 *
 * Keys (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Signatures and keys"): did:web and DNS show only current state, so
 * they can authorize only the current key. Without a descriptor, the key must
 * be authorized that way. A key the descriptor lists as current must be too.
 * A key the descriptor lists as retired is taken from the descriptor's `jwk`,
 * and is accepted only with a valid cosignature the verifier requires: the
 * witnesses checked it while it was current.
 */
export function verifyStatement(pub: PublishedStatement, opts: VerifyOptions): StatementCheck {
  const problems: string[] = [];
  let d: ReturnType<typeof decodeStatement>;
  try {
    d = decodeStatement(pub?.statement);
  } catch (e) {
    return { ok: false, problems: [(e as Error).message], cosigners: [] };
  }
  const listed = opts.descriptor ? listedKey(opts.descriptor, d.kid, d.payload.period) : undefined;
  const retired = listed !== undefined && listed.until !== null;
  if (opts.descriptor) {
    if (opts.descriptor.log !== d.payload.log) problems.push("statement is for another log");
    if (!listed) problems.push(`key ${d.kid} is not listed for ${d.payload.period}`);
  }
  if (!retired) {
    // The current key must belong to the log the statement names, whether or not a descriptor is given.
    if (!(opts.authorizeLogKey ?? kidOnLogHost)(d.kid, d.payload.log)) problems.push(`key ${d.kid} is not authorized for ${d.payload.log}`);
  } else if (!opts.requireCosigners?.length) {
    problems.push(`key ${d.kid} is retired: it is accepted only with a cosignature the verifier requires`);
  }
  const logKey = (retired ? publicKeyFromJwk(listed?.jwk) : undefined) ?? opts.resolveKey(d.kid, { log: d.payload.log, role: "log" });
  if (!logKey) problems.push(`no key for ${d.kid}`);
  else if (!jwsVerify(pub.statement.signature, logKey)) problems.push("log signature invalid");

  const cosigners: string[] = [];
  for (const c of pub.cosignatures ?? []) {
    try {
      const cd = jwsDecode(c.signature);
      if (Buffer.compare(Buffer.from(cd.payloadBytes), Buffer.from(d.bytes)) !== 0) continue;
      const k = opts.resolveKey(cd.header.kid, { log: d.payload.log, role: "cosigner" });
      if (k && jwsVerify(c.signature, k)) cosigners.push(cd.header.kid);
    } catch {
      // an unreadable cosignature simply does not count
    }
  }
  for (const r of opts.requireCosigners ?? []) if (!cosigners.includes(r)) problems.push(`missing valid cosignature by ${r}`);
  return { ok: problems.length === 0, payload: d.payload, hash: d.hash, problems, cosigners };
}

/** Statements chain by `previous` and cover consecutive periods (a gap is visible). Never throws. */
export function verifyChain(pubs: PublishedStatement[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  let prev: { hash: string; period: string; log: string } | undefined;
  if (!Array.isArray(pubs)) return { ok: false, problems: ["not a list of statements"] };
  // The first statement given may be mid-chain (its `previous` is not checked here).
  pubs.forEach((p, i) => {
    let d: ReturnType<typeof decodeStatement>;
    try {
      d = decodeStatement(p?.statement);
    } catch (e) {
      problems.push(`statement ${i}: ${(e as Error).message}`);
      prev = undefined;
      return;
    }
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
export function verifyReceipt(receipt: Receipt, opts: VerifyOptions): ReceiptCheck {
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
  out.signature = !st.problems.some((p) => p.startsWith("log signature") || p.startsWith("no key") || p.includes("is not authorized for") || p.includes("is retired"));
  try {
    out.period = parseLine(receipt.line).period === st.payload.period;
  } catch (e) {
    out.problems.push((e as Error).message);
  }
  if (!out.period) out.problems.push("line period does not match the statement");
  try {
    out.included = verifyInclusion(receipt.line, receipt.index, st.payload.size, receipt.proof, st.payload.root);
  } catch {
    out.included = false;
  }
  if (!out.included) out.problems.push("audit path does not lead to the root");
  out.ok = out.problems.length === 0;
  return out;
}

// ---- witnesses ---------------------------------------------------------------------------

/**
 * A witness (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Witnesses and the fund"). Before cosigning it verifies the log's signature,
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
    opts: Omit<VerifyOptions, "requireCosigners"> & {
      history?: PublishedStatement[];
      files?: { lines: string; settlements: string };
    },
  ): JwsEnvelope {
    const vopts: VerifyOptions = { resolveKey: opts.resolveKey, descriptor: opts.descriptor, authorizeLogKey: opts.authorizeLogKey };
    const st = verifyStatement({ statement: pub.statement, cosignatures: [] }, vopts);
    if (!st.ok || !st.payload || !st.hash) throw new Error(`witness refuses: ${st.problems.join("; ")}`);
    const p = st.payload;
    const slot = `${p.log} ${p.period}`;
    const already = this.signed.get(slot);
    if (already !== undefined && already !== st.hash) throw new Error(`witness refuses: already cosigned another payload for ${p.period}`);

    if (already === undefined) {
      const last = this.last.get(p.log);
      // A log's first statement (previous null) is for the `from` of its earliest key.
      if (!last && p.previous === null && opts.descriptor) {
        const first = firstPeriod(opts.descriptor);
        if (first !== undefined && p.period !== first) throw new Error(`witness refuses: the log's first period is ${first}, not ${p.period}`);
      }
      if (last) {
        let hash = last.hash;
        let period = last.period;
        for (const h of opts.history ?? []) {
          const hs = verifyStatement({ statement: h.statement, cosignatures: [] }, vopts);
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
        if (b.period !== null && b.period !== p.period) throw new Error("witness refuses: the lines are for another period");
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
  /** A processor-mode payout the fund received from `log` under `reference`. */
  payout?(reference: string, log: string): { asset: string; amount: bigint } | undefined;
}

/**
 * A fund that cosigns a statement attests, for every totals row that names it,
 * that each settlement reference listed for it exists and is credited to it,
 * that across every statement it has cosigned (any log, this log's earlier
 * periods included) the amounts listed for one reference never add up to more
 * than that reference credited to it, and that the amounts add up to the row.
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

  cosign(pub: PublishedStatement, settlementsBody: string, opts: Omit<VerifyOptions, "requireCosigners">): JwsEnvelope {
    const st = verifyStatement({ statement: pub.statement, cosignatures: [] }, { resolveKey: opts.resolveKey, descriptor: opts.descriptor, authorizeLogKey: opts.authorizeLogKey });
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
    // Refs are canonical here (parseSettlement rejects any other spelling), and the payload's
    // totals rows are in canonical form (decodeStatement checks), so string keys are exact.
    const mine = (x: { fund: string }) => sameAccount(x.fund, this.fund);
    const rows = p.totals.filter(mine);
    for (const e of entries.filter(mine)) {
      if (!rows.some((r) => r.asset === e.asset)) throw new Error(`fund refuses: ${e.ref} is listed for ${e.asset}, which has no totals row`);
    }
    // Payout references are the processor's own, so they are keyed by log; transfers and claims are global.
    const keyOf = (ref: string) => (ref.startsWith("payout:") ? `${p.log} ${ref}` : ref);
    const pending = new Map<string, bigint>(); // what this statement lists per reference
    for (const row of rows) {
      let sum = 0n;
      for (const e of entries.filter((x) => mine(x) && x.asset === row.asset)) {
        const amt = BigInt(e.amount);
        sum += amt;
        const key = keyOf(e.ref);
        const prior = this.refs.get(key);
        if (prior && prior.log !== p.log) throw new Error(`fund refuses: ${e.ref} is already listed by another log`);
        // Everything listed for this reference before: earlier statements of this log, and this one so far.
        const usedBefore = (prior?.used ?? 0n) + (pending.get(key) ?? 0n);
        const [kind, ...rest] = e.ref.split(":");
        if (kind === "exact") {
          const t = this.view.exactTransfer(rest.join(":"));
          if (!t || !fundAddr || t.to.toLowerCase() !== fundAddr || canonicalAccount(t.token) !== row.asset || t.value !== amt) {
            throw new Error(`fund refuses: ${e.ref} is not a transfer of ${e.amount} to the fund`);
          }
          if (usedBefore > 0n) throw new Error(`fund refuses: ${e.ref} listed twice`);
        } else if (kind === "claim") {
          const [tx, channelId] = rest;
          const c = this.view.claimIncrease(tx, channelId);
          const auth = this.logAuthorizers.get(p.log);
          if (!c || !fundAddr || c.receiver.toLowerCase() !== fundAddr || canonicalAccount(c.token) !== row.asset || !auth || c.receiverAuthorizer.toLowerCase() !== auth.toLowerCase()) {
            throw new Error(`fund refuses: ${e.ref} is not a claim on a channel paying the fund under this log`);
          }
          if (usedBefore + amt > c.increase) throw new Error(`fund refuses: ${e.ref} attributes more than the claim's increase`);
        } else if (kind === "payout") {
          const r = this.view.payout?.(rest.join(":"), p.log);
          if (!r || canonicalAccount(r.asset) !== row.asset || r.amount !== amt) throw new Error(`fund refuses: payout ${e.ref} not found`);
          if (usedBefore > 0n) throw new Error(`fund refuses: ${e.ref} listed twice`);
        } else {
          throw new Error(`fund refuses: ${e.ref} is not a known kind of reference`);
        }
        pending.set(key, (pending.get(key) ?? 0n) + amt);
      }
      if (sum !== BigInt(row.amount)) throw new Error(`fund refuses: settlements for ${row.asset} do not add up to the totals row`);
    }
    for (const [key, amt] of pending) this.refs.set(key, { log: p.log, used: (this.refs.get(key)?.used ?? 0n) + amt });
    const envelope: JwsEnvelope = { format: "jws", signature: jwsSign(statementBytesFrom(pub), this.key) };
    this.done.set(slot, { hash: st.hash as string, envelope });
    return envelope;
  }
}
