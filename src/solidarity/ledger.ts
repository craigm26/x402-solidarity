/**
 * Receipt attestation (https://craigmerry.com/solidarity-levy/spec/attestation.md): lines, batches,
 * settlement references, statements, JWS signatures, witnesses and receipts.
 * The same in both modes.
 *
 * Signatures use node:crypto: Ed25519 ("EdDSA") and P-256 ("ES256", with the
 * raw r||s encoding JWS requires). Keys are always passed to sign/verify as bare
 * KeyObjects, never as `{ key, dsaEncoding }`: Cloudflare Workers' node:crypto
 * rejects a KeyObject inside that options form, so ES256 converts between DER and
 * r||s here instead.
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

const P256_SCALAR = 32;

/** One DER INTEGER as a fixed-width unsigned big-endian scalar; throws unless minimally encoded and positive. */
function derIntegerToScalar(der: Uint8Array, at: number): { value: Uint8Array; next: number } {
  if (der[at] !== 0x02) throw new Error("ECDSA DER: expected INTEGER");
  const len = der[at + 1];
  const start = at + 2;
  if (len === undefined || len < 1 || len > P256_SCALAR + 1 || start + len > der.length) throw new Error("ECDSA DER: bad INTEGER length");
  let v = der.subarray(start, start + len);
  if (v[0] & 0x80) throw new Error("ECDSA DER: negative INTEGER");
  if (v[0] === 0x00) {
    if (len === 1 || !(v[1] & 0x80)) throw new Error("ECDSA DER: INTEGER not minimal");
    v = v.subarray(1);
  }
  if (v.length > P256_SCALAR) throw new Error("ECDSA DER: INTEGER too long");
  const value = new Uint8Array(P256_SCALAR);
  value.set(v, P256_SCALAR - v.length);
  return { value, next: start + len };
}

/** DER `SEQUENCE { r INTEGER, s INTEGER }` (what node:crypto signs by default) to JWS r||s (RFC 7518 section 3.4). */
export function ecdsaDerToP1363(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30 || der[1] === undefined || der[1] > 0x7f || der[1] + 2 !== der.length) throw new Error("ECDSA DER: bad SEQUENCE");
  const r = derIntegerToScalar(der, 2);
  const s = derIntegerToScalar(der, r.next);
  if (s.next !== der.length) throw new Error("ECDSA DER: trailing bytes");
  const out = new Uint8Array(2 * P256_SCALAR);
  out.set(r.value, 0);
  out.set(s.value, P256_SCALAR);
  return out;
}

function scalarToDerInteger(scalar: Uint8Array): Uint8Array {
  let i = 0;
  while (i < scalar.length - 1 && scalar[i] === 0) i++;
  const v = scalar.subarray(i);
  const pad = v[0] & 0x80 ? 1 : 0;
  const out = new Uint8Array(2 + pad + v.length);
  out[0] = 0x02;
  out[1] = pad + v.length;
  out.set(v, 2 + pad);
  return out;
}

/** JWS r||s (64 bytes for P-256) to DER, for node:crypto's default verify encoding. */
export function ecdsaP1363ToDer(sig: Uint8Array): Uint8Array {
  if (sig.length !== 2 * P256_SCALAR) throw new Error("ES256 signature must be 64 bytes");
  const r = scalarToDerInteger(sig.subarray(0, P256_SCALAR));
  const s = scalarToDerInteger(sig.subarray(P256_SCALAR));
  const out = new Uint8Array(2 + r.length + s.length);
  out[0] = 0x30;
  out[1] = r.length + s.length;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

function rawSign(alg: JwsAlg, data: Uint8Array, key: KeyObject): Uint8Array {
  if (alg === "EdDSA") {
    if (key.asymmetricKeyType !== "ed25519") throw new Error("EdDSA needs an Ed25519 key");
    return new Uint8Array(nodeSign(null, data, key));
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (key.asymmetricKeyType !== "ec" || (curve !== "prime256v1" && curve !== "P-256")) throw new Error("ES256 needs a P-256 key");
  return ecdsaDerToP1363(new Uint8Array(nodeSign("sha256", data, key)));
}

/** The JWS `alg` is tied to the key type: EdDSA needs an Ed25519 key, ES256 a P-256 key (RFC 7515, RFC 8725 section 3.1). */
function rawVerify(alg: JwsAlg, data: Uint8Array, key: KeyObject, sig: Uint8Array): boolean {
  try {
    if (alg === "EdDSA") return key.asymmetricKeyType === "ed25519" && nodeVerify(null, data, key, sig);
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (key.asymmetricKeyType !== "ec" || (curve !== "prime256v1" && curve !== "P-256")) return false;
    if (sig.length !== 64) return false;
    return nodeVerify("sha256", data, key, ecdsaP1363ToDer(sig));
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

/**
 * The host a did:web DID URL names, with or without a path
 * (`did:web:example.com%3A8443:path#key` gives `example.com:8443`), or
 * undefined. Descriptive only: a log key needs the root DID of the log's host
 * (didWebAuthorizesLogKey), not just its host.
 */
export function didWebHost(kid: string): string | undefined {
  const m = /^did:web:([^:#?/]+)/.exec(kid);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return undefined;
  }
}

/** The DID in a DID URL: everything before its path, query or fragment (`did:web:example.com#key-1` gives `did:web:example.com`), or undefined. */
export function kidDid(kid: string): string | undefined {
  const m = /^did:[a-z0-9]+:[^/?#]+/.exec(kid);
  return m ? m[0] : undefined;
}

/** The root did:web DID of a host: `did:web:<host>`, a port's colon written `%3A` as did:web requires. */
export function didWebOfHost(host: string): string {
  return `did:web:${host.toLowerCase().replace(/:([0-9]+)$/, "%3A$1")}`;
}

/**
 * The did:web route for a log's statement key, and the default `authorizeLogKey`
 * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Signatures and keys"): the DID in the `kid` is
 * exactly `did:web:<host>` for the host of the log URL, whose document is
 * `https://<host>/.well-known/did.json`. A DID with a path, `did:web:<host>:<path>`,
 * never authorizes a log key, even on the log's host: a witness's or fund's key
 * served next to the log, or anyone who can publish a file on the host, would
 * otherwise pass as the log. Here the `kid` is that DID and a fragment, nothing
 * else. That the root document lists the key is the key resolver's part, since
 * it stands for the did:web lookup. A verifier that also accepts the DNS route
 * (a `controller` in the TXT record at `_controllers.<host>`) passes its own
 * `authorizeLogKey`, and can compare `kidDid(kid)` with those controllers.
 */
export function didWebAuthorizesLogKey(kid: string, log: string): boolean {
  let host: string;
  try {
    host = new URL(log).host;
  } catch {
    return false;
  }
  const m = /^(did:web:[^/?#]+)(?:#[^#]*)?$/.exec(kid);
  if (!m) return false;
  // Compared case-insensitively: hosts and percent-encoding are. Any other spelling (a path,
  // another percent-encoding) is not the root DID.
  return m[1].toLowerCase() === didWebOfHost(host).toLowerCase();
}

/**
 * An `authorizeLogKey` for both routes of
 * https://craigmerry.com/solidarity-levy/spec/attestation.md, "Signatures and keys": the did:web route
 * (didWebAuthorizesLogKey), or the DNS route, where the DID in the `kid` is
 * exactly one of the `controller` values of the TXT record at
 * `_controllers.<host>`. This library makes no DNS lookups: `dnsControllers`
 * gets the log URL's host name (no port) and returns the controller values
 * the verifier read from that record, or nothing. A path DID passes the DNS
 * route only if the record names it.
 */
export function logKeyAuthorizer(opts: { dnsControllers?: (host: string) => readonly string[] | undefined } = {}): (kid: string, log: string) => boolean {
  return (kid, log) => {
    if (didWebAuthorizesLogKey(kid, log)) return true;
    if (!opts.dnsControllers) return false;
    let host: string;
    try {
      host = new URL(log).hostname.toLowerCase();
    } catch {
      return false;
    }
    const did = kidDid(kid);
    return did !== undefined && (opts.dnsControllers(host) ?? []).includes(did);
  };
}

/** What verifyStatement, verifyReceipt, Witness and FundCosigner take. */
export interface VerifyOptions {
  resolveKey: KeyResolver;
  /** The log's descriptor: the statement must be for its log, by a key it lists for the period. */
  descriptor?: Pick<LogDescriptor, "keys" | "log">;
  requireCosigners?: string[];
  /** Is `kid` authorized for `log`? Default: didWebAuthorizesLogKey, the root did:web DID of the log's host. */
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

/**
 * Has the log retired? A descriptor with keys but no current one (no `until`
 * that is null) belongs to a retired log
 * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Retiring a log").
 */
export function isRetired(descriptor: Pick<LogDescriptor, "keys">): boolean {
  return descriptor.keys.length > 0 && descriptor.keys.every((k) => k.until !== null);
}

/** A retired log's final period: the latest `until` in its descriptor. Undefined while the log has a current key. */
export function finalPeriod(descriptor: Pick<LogDescriptor, "keys">): string | undefined {
  if (!isRetired(descriptor)) return undefined;
  return descriptor.keys.map((k) => k.until as string).sort().at(-1);
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
  return checkStatement(pub, opts, true);
}

/**
 * verifyStatement, except that with `retiredNeedsCosigner` false a key the
 * descriptor lists as retired is taken from its `jwk` without a required
 * cosignature. Only a witness walking a log's history back from a statement
 * signed by the current key uses that: the chain of `previous` hashes is what
 * it checks there, and the current statement commits to it.
 */
function checkStatement(pub: PublishedStatement, opts: VerifyOptions, retiredNeedsCosigner: boolean): StatementCheck {
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
    if (!(opts.authorizeLogKey ?? didWebAuthorizesLogKey)(d.kid, d.payload.log)) problems.push(`key ${d.kid} is not authorized for ${d.payload.log}`);
  } else if (retiredNeedsCosigner && !opts.requireCosigners?.length) {
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

/**
 * Statements chain by `previous` and cover consecutive periods (a gap is
 * visible). Never throws. The first statement given may be mid-chain, unless
 * `complete` is the log's descriptor: then the list must be the whole log
 * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Consistency between months"), from its first statement
 * (`previous` null, for the `from` of its earliest key) and, if the log has
 * retired, to its final one, with nothing after it.
 */
export function verifyChain(pubs: PublishedStatement[], opts: { complete?: Pick<LogDescriptor, "keys"> } = {}): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  let prev: { hash: string; period: string; log: string } | undefined;
  if (!Array.isArray(pubs)) return { ok: false, problems: ["not a list of statements"] };
  if (opts.complete) {
    const payloadAt = (i: number): Partial<StatementPayload> => {
      try {
        return decodeStatement(pubs[i]?.statement).payload;
      } catch {
        return {};
      }
    };
    const first = firstPeriod(opts.complete);
    const head = payloadAt(0);
    if (pubs.length === 0) problems.push("no statements");
    else if (head.period !== first || head.previous !== null) problems.push(`the log's first statement is for ${first}, with previous null`);
    const end = finalPeriod(opts.complete);
    if (end !== undefined && pubs.length > 0 && payloadAt(pubs.length - 1).period !== end) problems.push(`the log retired with ${end} as its final statement`);
  }
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

/** One entry of a witness's record: the hash of the payload it cosigned for one (log, period). */
export interface WitnessRecordEntry {
  log: string;
  period: string;
  hash: string;
}

export interface WitnessOptions {
  /** Its record so far, read back from its own storage. Empty or absent for a witness that has never cosigned. */
  record?: WitnessRecordEntry[];
  /**
   * Stores one new entry durably. Called before the cosignature is returned
   * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Witnesses and the fund": a witness stores each entry
   * before it releases the cosignature): if it throws or rejects, nothing is
   * cosigned and the record in memory is unchanged. A store that writes
   * asynchronously returns its promise and is used through `cosignAsync`,
   * which awaits it; `cosign` refuses a promise (see Witness).
   */
  persist?: (entry: WitnessRecordEntry) => void | Promise<void>;
}

/**
 * A witness (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Witnesses and the fund"). Before cosigning it verifies the log's
 * signature, checks that `previous` is the hash of the payload for the period
 * just before (the last one it cosigned for this log, or one it reaches by
 * walking `history` forward from it), and never cosigns two different payloads
 * for one (log, period). It may also recompute root, size, totals and
 * settlements from the published files.
 *
 * Both checks need its record, the hash of every payload it cosigned per (log,
 * period), and it never skips them for want of it (draft 3):
 * - The record must survive restarts. Pass it back as `record`, and store each
 *   new entry from `persist`, which runs before the cosignature is returned.
 * - With no record for a log, it walks the chain back to the log's first
 *   statement: `history` must start there (`previous` null, for the `from` of
 *   the earliest key in the descriptor, which it then needs), unless the
 *   statement is itself the first. With a record, `history` covers the periods
 *   after the last one it cosigned; earlier statements in it are passed over,
 *   and refused if they differ from a payload it cosigned.
 * - A statement in front of it that carries its own valid cosignature, for a
 *   (log, period) its record does not hold, shows that it lost its record. It
 *   refuses: a witness that lost its record never cosigns for that log again
 *   under the same kid. That check only catches what the log chose to publish,
 *   which is why the record itself is kept.
 *
 * Its record holds what it cosigned, not what it refused. A refusal stands
 * ("Refusals"): the caller keeps it and does not ask again for that period.
 * It may cosign later statements that chain through a refused one.
 *
 * `cosign` is synchronous. With a `persist` that returns a promise it throws
 * and returns no cosignature, and this witness cosigns nothing more, since
 * whether that write landed is unknown (rebuild it from its stored record).
 * `cosignAsync` awaits such a store, one cosignature at a time.
 */
export class Witness {
  readonly key: SigningKey;
  private readonly last = new Map<string, { hash: string; period: string }>();
  private readonly signed = new Map<string, string>(); // `${log} ${period}` -> payload hash
  private readonly persist?: (entry: WitnessRecordEntry) => void | Promise<void>;
  private readonly writes = new StoreGate("witness");

  constructor(key: SigningKey, opts: WitnessOptions = {}) {
    this.key = key;
    this.persist = opts.persist;
    for (const e of opts.record ?? []) this.remember(e);
  }

  /** Its record, one entry per (log, period) it cosigned, for storage. */
  record(): WitnessRecordEntry[] {
    return [...this.signed].map(([slot, hash]) => {
      const i = slot.lastIndexOf(" ");
      return { log: slot.slice(0, i), period: slot.slice(i + 1), hash };
    });
  }

  private remember(e: WitnessRecordEntry): void {
    if (typeof e?.log !== "string" || !/^https:\/\/[\x21-\x7e]+$/.test(e.log) || typeof e.period !== "string" || !PERIOD_PATTERN.test(e.period) || typeof e.hash !== "string" || !HEX64.test(e.hash)) {
      throw new Error("a witness record entry needs an https log URL, a YYYY-MM period and a payload hash");
    }
    const slot = `${e.log} ${e.period}`;
    const had = this.signed.get(slot);
    if (had !== undefined && had !== e.hash) throw new Error(`the witness record holds two payloads for ${e.log} ${e.period}`);
    this.signed.set(slot, e.hash);
    const prev = this.last.get(e.log);
    if (!prev || e.period > prev.period) this.last.set(e.log, { hash: e.hash, period: e.period });
  }

  cosign(pub: PublishedStatement, opts: WitnessCosignOptions): JwsEnvelope {
    this.writes.syncAllowed();
    const entry = this.check(pub, opts);
    if (entry) {
      this.writes.syncWrite(this.persist?.(entry));
      this.remember(entry);
    }
    return { format: "jws", signature: jwsSign(statementBytesFrom(pub), this.key) };
  }

  /**
   * `cosign` for a `persist` that writes asynchronously: the new entry is
   * stored, and the write awaited, before the cosignature is returned. Calls
   * run one at a time, so two payloads for one period can never both pass
   * the check while a write is pending.
   */
  cosignAsync(pub: PublishedStatement, opts: WitnessCosignOptions): Promise<JwsEnvelope> {
    return this.writes.serial(async () => {
      const entry = this.check(pub, opts);
      if (entry) {
        await this.persist?.(entry);
        this.remember(entry);
      }
      return { format: "jws", signature: jwsSign(statementBytesFrom(pub), this.key) };
    });
  }

  /**
   * Every check before a cosignature. Returns the record entry to store, or
   * undefined when the record already holds this payload (the same
   * cosignature again). Throws a refusal.
   */
  private check(pub: PublishedStatement, opts: WitnessCosignOptions): WitnessRecordEntry | undefined {
    const refuse = (why: string): never => {
      throw new Error(`witness refuses: ${why}`);
    };
    const vopts: VerifyOptions = { resolveKey: opts.resolveKey, descriptor: opts.descriptor, authorizeLogKey: opts.authorizeLogKey };
    const st = verifyStatement({ statement: pub.statement, cosignatures: [] }, vopts);
    if (!st.ok || !st.payload || !st.hash) return refuse(st.problems.join("; "));
    const p = st.payload;
    const slot = `${p.log} ${p.period}`;
    const already = this.signed.get(slot);
    if (already !== undefined) {
      if (already !== st.hash) refuse(`already cosigned another payload for ${p.period}`);
      // The same payload again: the same cosignature (its record already holds it).
      return undefined;
    }
    const history = opts.history ?? [];
    for (const s of [pub, ...history]) {
      const lost = this.ownCosignatureWithoutRecord(s);
      if (lost) refuse(`it cosigned ${lost} for this log before but its record does not hold that; a witness that lost its record does not cosign for that log again under ${this.key.kid}`);
    }

    // Walk forward from the last payload it cosigned for this log, or, with no record for the log,
    // from the log's first statement.
    const last = this.last.get(p.log);
    let at: { hash: string; period: string } | undefined = last;
    let first: string | undefined;
    if (!last) {
      if (!opts.descriptor) refuse("it has no record for this log, and checking the log's first statement needs the log's descriptor");
      first = firstPeriod(opts.descriptor as Pick<LogDescriptor, "keys">);
      if (first === undefined) refuse("the log's descriptor lists no keys");
    }
    for (const h of history) {
      const hs = checkStatement({ statement: h.statement, cosignatures: [] }, vopts, false);
      if (!hs.ok || !hs.payload || !hs.hash) refuse("a history statement does not verify");
      const hp = hs.payload as StatementPayload;
      if (hp.log !== p.log) refuse("a history statement is for another log");
      if (last && hp.period <= last.period) {
        // Up to the last payload it cosigned, its record is what counts: history there may only
        // repeat a payload it holds (a period it refused or never saw is passed over).
        const held = this.signed.get(`${hp.log} ${hp.period}`);
        if (held !== undefined && held !== hs.hash) refuse(`history holds another payload for ${hp.period} than the one it cosigned`);
        continue;
      }
      if (at === undefined) {
        if (hp.previous !== null || hp.period !== first) refuse(`with no record for this log, history must start at the log's first statement (${first}, previous null)`);
      } else if (hp.previous !== at.hash || hp.period !== nextPeriod(at.period)) {
        refuse(last ? "history does not chain to the last cosigned payload" : "history does not chain");
      }
      at = { hash: hs.hash as string, period: hp.period };
    }
    if (at === undefined) {
      // No record and no history: this must be the log's first statement.
      if (p.previous !== null) refuse(`previous is not null, and with no record for this log it needs history back to the log's first statement (${first})`);
      if (p.period !== first) refuse(`the log's first period is ${first}, not ${p.period}`);
    } else if (p.previous !== at.hash || p.period !== nextPeriod(at.period)) {
      refuse(history.length && !last ? "previous does not chain to the history" : "previous does not chain to the last payload it cosigned");
    }

    if (opts.files) {
      const lines = parseFileBody(opts.files.lines);
      const b = buildBatch(lines);
      if (b.period !== null && b.period !== p.period) refuse("the lines are for another period");
      if (b.root !== p.root || b.size !== p.size || canonicalizeStrict(b.totals) !== canonicalizeStrict(p.totals)) {
        refuse("lines do not reproduce root, size and totals");
      }
      if (sha256Hex(opts.files.settlements) !== p.settlements) refuse("settlements file hash differs");
      if (!settlementsMatchTotals(parseFileBody(opts.files.settlements), p.totals)) refuse("settlements do not add up to totals");
    }
    // Stored before the cosignature leaves (cosign, cosignAsync): a crash after that can only repeat it.
    return { log: p.log, period: p.period, hash: st.hash };
  }

  /** The period of `s` if `s` carries this witness's valid cosignature over its payload but its record holds another payload or none for it. */
  private ownCosignatureWithoutRecord(s: PublishedStatement): string | undefined {
    let d: ReturnType<typeof decodeStatement>;
    try {
      d = decodeStatement(s?.statement);
    } catch {
      return undefined;
    }
    for (const c of s.cosignatures ?? []) {
      try {
        const cd = jwsDecode(c.signature);
        if (cd.header.kid !== this.key.kid || Buffer.compare(Buffer.from(cd.payloadBytes), Buffer.from(d.bytes)) !== 0) continue;
        if (!jwsVerify(c.signature, this.key.publicKey)) continue;
        if (this.signed.get(`${d.payload.log} ${d.payload.period}`) !== d.hash) return d.payload.period;
      } catch {
        // an unreadable cosignature is not its own
      }
    }
    return undefined;
  }
}

/** What Witness.cosign takes: how to verify the log, the history back to its first statement or the last one cosigned, and the published files. */
export type WitnessCosignOptions = Omit<VerifyOptions, "requireCosigners"> & {
  history?: PublishedStatement[];
  files?: { lines: string; settlements: string };
};

/**
 * The write rule a witness and a fund share: what they record is stored
 * before the cosignature is released. A synchronous cosign cannot wait for a
 * store that returns a promise, so it refuses one, and then refuses every
 * later write, since whether that write landed is unknown. Asynchronous
 * cosigns run one at a time, and a synchronous one is refused while one runs.
 */
class StoreGate {
  private readonly who: string;
  private queue: Promise<unknown> = Promise.resolve();
  private running = 0;
  private unsure = false;

  constructor(who: string) {
    this.who = who;
  }

  private usable(): void {
    if (this.unsure) throw new Error(`${this.who} refuses: a write it could not wait for may or may not have landed; rebuild it from its stored record`);
  }

  syncAllowed(): void {
    this.usable();
    if (this.running > 0) throw new Error(`${this.who} refuses: an asynchronous write is still running; use cosignAsync throughout`);
  }

  /** After a synchronous persist call: refuses (and stops further writes) if it returned a promise. */
  syncWrite(result: unknown): void {
    if (typeof result === "object" && result !== null && typeof (result as { then?: unknown }).then === "function") {
      this.unsure = true;
      Promise.resolve(result).catch(() => undefined);
      throw new Error(`${this.who} refuses: persist returned a promise, and cosign is synchronous, so no cosignature was released; rebuild it from its stored record and use cosignAsync`);
    }
  }

  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.usable();
      this.running += 1;
      try {
        return await fn();
      } finally {
        this.running -= 1;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
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
 * A fund's record (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Witnesses and the fund"): every
 * settlement reference it has attested, with the log that listed it and the
 * amount listed for it so far, and every statement it has cosigned. It covers
 * every log that pays the fund and has to survive restarts. Draft 3 does not
 * bound it (an open question there).
 */
export interface FundRecord {
  refs: Array<{ ref: string; log: string; used: string }>;
  cosigned: Array<{ log: string; period: string; hash: string }>;
}

/**
 * A fund that cosigns a statement attests, for every totals row that names it,
 * that each settlement reference listed for it exists and is credited to it,
 * that across every statement it has cosigned (any log, this log's earlier
 * periods included) the amounts listed for one reference never add up to more
 * than that reference credited to it, and that the amounts add up to the row.
 *
 * Its record comes back from storage as `record`, and `persist` receives what
 * each cosignature adds to it (the references it changes, with their new
 * totals, and the statement) before the cosignature is returned; if it
 * throws or rejects, nothing is cosigned. As with a witness, `cosign` refuses
 * a `persist` that returns a promise (and then cosigns nothing more), and
 * `cosignAsync` awaits it, one cosignature at a time.
 */
export class FundCosigner {
  readonly fund: string;
  readonly key: SigningKey;
  readonly view: FundView;
  /** receiverAuthorizer of each log, from the log's descriptor. */
  readonly logAuthorizers: Map<string, string>;
  private readonly refs = new Map<string, { ref: string; log: string; used: bigint }>();
  private readonly done = new Map<string, { hash: string; envelope?: JwsEnvelope }>();
  private readonly persist?: (added: FundRecord) => void | Promise<void>;
  private readonly writes = new StoreGate("fund");

  constructor(opts: { fund: string; key: SigningKey; view: FundView; logAuthorizers?: Record<string, string>; record?: FundRecord; persist?: (added: FundRecord) => void | Promise<void> }) {
    this.fund = canonicalAccount(opts.fund);
    this.key = opts.key;
    this.view = opts.view;
    this.logAuthorizers = new Map(Object.entries(opts.logAuthorizers ?? {}));
    this.persist = opts.persist;
    for (const r of opts.record?.refs ?? []) {
      if (typeof r?.ref !== "string" || typeof r.log !== "string" || typeof r.used !== "string" || !/^[0-9]+$/.test(r.used)) throw new Error("a fund record reference needs ref, log and used");
      this.refs.set(fundRefKey(r.log, r.ref), { ref: r.ref, log: r.log, used: BigInt(r.used) });
    }
    for (const c of opts.record?.cosigned ?? []) this.done.set(`${c.log} ${c.period}`, { hash: c.hash });
  }

  /** Its whole record, for storage. */
  record(): FundRecord {
    return {
      refs: [...this.refs.values()].map((r) => ({ ref: r.ref, log: r.log, used: r.used.toString() })),
      cosigned: [...this.done].map(([slot, d]) => {
        const i = slot.lastIndexOf(" ");
        return { log: slot.slice(0, i), period: slot.slice(i + 1), hash: d.hash };
      }),
    };
  }

  cosign(pub: PublishedStatement, settlementsBody: string, opts: Omit<VerifyOptions, "requireCosigners">): JwsEnvelope {
    this.writes.syncAllowed();
    const r = this.check(pub, settlementsBody, opts);
    if ("envelope" in r) return r.envelope;
    this.writes.syncWrite(this.persist?.(r.added));
    return this.commit(pub, r.added);
  }

  /** `cosign` for a `persist` that writes asynchronously: the addition is stored, and the write awaited, before the cosignature is returned. */
  cosignAsync(pub: PublishedStatement, settlementsBody: string, opts: Omit<VerifyOptions, "requireCosigners">): Promise<JwsEnvelope> {
    return this.writes.serial(async () => {
      const r = this.check(pub, settlementsBody, opts);
      if ("envelope" in r) return r.envelope;
      await this.persist?.(r.added);
      return this.commit(pub, r.added);
    });
  }

  /** Remembers what a cosignature adds, once stored, and signs. */
  private commit(pub: PublishedStatement, added: FundRecord): JwsEnvelope {
    for (const r of added.refs) this.refs.set(fundRefKey(r.log, r.ref), { ref: r.ref, log: r.log, used: BigInt(r.used) });
    const c = added.cosigned[0];
    const envelope: JwsEnvelope = { format: "jws", signature: jwsSign(statementBytesFrom(pub), this.key) };
    this.done.set(`${c.log} ${c.period}`, { hash: c.hash, envelope });
    return envelope;
  }

  /** Every check of the "money arrived" attestation. Returns what a cosignature would add to the record, or the cosignature already given for this payload. Throws a refusal. */
  private check(pub: PublishedStatement, settlementsBody: string, opts: Omit<VerifyOptions, "requireCosigners">): { added: FundRecord } | { envelope: JwsEnvelope } {
    const st = verifyStatement({ statement: pub.statement, cosignatures: [] }, { resolveKey: opts.resolveKey, descriptor: opts.descriptor, authorizeLogKey: opts.authorizeLogKey });
    if (!st.ok || !st.payload) throw new Error(`fund refuses: ${st.problems.join("; ")}`);
    const p = st.payload;
    const slot = `${p.log} ${p.period}`;
    const prev = this.done.get(slot);
    if (prev) {
      if (prev.hash !== st.hash) throw new Error(`fund refuses: already cosigned another payload for ${p.period}`);
      // The same payload again. After a restart the record has its hash, not the envelope: sign again.
      prev.envelope ??= { format: "jws", signature: jwsSign(statementBytesFrom(pub), this.key) };
      return { envelope: prev.envelope };
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
    const keyOf = (ref: string) => fundRefKey(p.log, ref);
    const pending = new Map<string, bigint>(); // what this statement lists per reference
    const refOf = new Map<string, string>();
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
        refOf.set(key, e.ref);
      }
      if (sum !== BigInt(row.amount)) throw new Error(`fund refuses: settlements for ${row.asset} do not add up to the totals row`);
    }
    const added: FundRecord = {
      refs: [...pending].map(([key, amt]) => ({ ref: refOf.get(key) as string, log: p.log, used: ((this.refs.get(key)?.used ?? 0n) + amt).toString() })),
      cosigned: [{ log: p.log, period: p.period, hash: st.hash as string }],
    };
    // Stored before the cosignature leaves (cosign, cosignAsync), as a witness's record is.
    return { added };
  }
}

/** Payout references are the processor's own, so a fund keys them by log; transfers and claims are global. */
const fundRefKey = (log: string, ref: string): string => (ref.startsWith("payout:") ? `${log} ${ref}` : ref);
