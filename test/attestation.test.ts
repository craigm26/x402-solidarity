/**
 * Failure paths on the attestation side: what a fund, a witness and an owner
 * must refuse. Each test feeds the statement, file or receipt a dishonest or
 * careless log could publish, and checks that it is refused.
 */
import assert from "node:assert/strict";
import { sign as nodeSign } from "node:crypto";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SimulatedChain } from "../src/sim/chain.ts";
import * as S from "../src/solidarity/index.ts";
import type { PublishedStatement, StatementPayload } from "../src/solidarity/index.ts";
import { b64url } from "../src/solidarity/utils.ts";

const USDC = S.USDC_BASE_SEPOLIA.address;
const NET = "eip155:84532";
const LOG = "https://log.example/solidarity";
const FUND = "eip155:84532:0x000000000000000000000000000000000000f00d";
const FUND_ADDR = "0x000000000000000000000000000000000000f00d" as const;
const AUTH = "0x3333333333333333333333333333333333333333" as const;
const logKey = S.generateSigningKey("EdDSA", "did:web:log.example#1");
const fundKey = S.generateSigningKey("EdDSA", "did:web:fund.example#1");
const witnessKey = S.generateSigningKey("EdDSA", "did:web:witness.example#1");
const attackerKey = S.generateSigningKey("EdDSA", "did:web:attacker.example#1");
const resolveKey = S.staticResolver({ [logKey.kid]: logKey.publicKey, [fundKey.kid]: fundKey.publicKey, [witnessKey.kid]: witnessKey.publicKey, [attackerKey.kid]: attackerKey.publicKey });
const descriptor = { log: LOG, keys: [{ kid: logKey.kid, from: "2026-01", until: null }] };
const shareId = (n: number) => `attestation-share-${String(n).padStart(4, "0")}`;
const line = (n: number, amount: string, period = "2026-10") => S.formatLine({ period, fund: FUND, asset: USDC, id: shareId(n), amount });
const entry = (ref: string, amount: string | bigint) => S.formatSettlement({ fund: FUND, asset: USDC, ref, amount });
const body = (entries: string[]) => entries.map((e) => `${e}\n`).join(""); // exactly as given: unsorted or repeated if so

/** A statement over `lines` with a settlements body exactly as given, signed by `key`. */
function statement(lines: string[], settlementsBody: string, o: { period?: string; previous?: string | null; key?: S.SigningKey; log?: string } = {}): { pub: PublishedStatement; payload: StatementPayload } {
  const payload = S.statementPayload({ log: o.log ?? LOG, period: o.period ?? "2026-10", batch: S.buildBatch(lines), settlementsBody, previous: o.previous ?? null, issuedAt: 1793836800 });
  return { pub: S.signStatement(payload, o.key ?? logKey), payload };
}

/** A simulated chain with the transfers and one claim a fund can look up. */
function setup() {
  const chain = new SimulatedChain({ now: 1793000000 });
  const payer = privateKeyToAccount(generatePrivateKey());
  chain.mint(USDC, payer.address, 100_000_000n);
  const toFund = chain.transfer(USDC, payer.address, FUND_ADDR, 48000n);
  const toFund2 = chain.transfer(USDC, payer.address, FUND_ADDR, 48000n);
  const elsewhere = chain.transfer(USDC, payer.address, "0x5555555555555555555555555555555555555555", 48000n);
  const config: S.ChannelConfig = { payer: payer.address, payerAuthorizer: payer.address, receiver: FUND_ADDR, receiverAuthorizer: AUTH, token: USDC as `0x${string}`, withdrawDelay: 86400, salt: `0x${"0".repeat(63)}1` };
  return { chain, payer, toFund, toFund2, elsewhere, config };
}
async function claim(w: ReturnType<typeof setup>, amount: bigint) {
  const id = w.chain.deposit(w.config, 1_000_000n);
  const v = await S.signVoucher(w.payer, id as `0x${string}`, amount.toString(), NET);
  const r = await w.chain.claim(id, v, amount);
  assert.ok(r.ok);
  return { tx: (r as { transaction: string }).transaction, channelId: id };
}
const fundOf = (w: ReturnType<typeof setup>) => new S.FundCosigner({ fund: FUND, key: fundKey, view: w.chain.fundView(), logAuthorizers: { [LOG]: AUTH } });

// ---- the fund's "money arrived" attestation ------------------------------------------------

test("the same transfer listed twice in one file is refused everywhere: file parser, book, witness and fund", () => {
  const w = setup();
  const e = entry(`exact:${w.toFund}`, 48000n);
  const twice = body([e, e]);
  const { pub } = statement([line(1, "48000"), line(2, "48000")], twice);
  assert.throws(() => S.parseFileBody(twice), /repeated/);
  assert.throws(() => fundOf(w).cosign(pub, twice, { resolveKey }), /repeated/);
  const lines = S.fileBody([line(1, "48000"), line(2, "48000")]);
  assert.throws(() => new S.Witness(witnessKey).cosign(pub, { resolveKey, files: { lines, settlements: twice } }), /repeated/);
  const book = new S.LogBook({ version: 2, log: LOG, funds: [FUND], keys: descriptor.keys }, logKey);
  book.addSettlement("2026-10", e);
  book.addSettlement("2026-10", e);
  assert.throws(() => book.close("2026-10", [line(1, "48000"), line(2, "48000")]), /repeated|add up/);
});

test("a transfer listed again in a later period of the same log is refused", () => {
  const w = setup();
  const fund = fundOf(w);
  const oct = statement([line(1, "48000")], body([entry(`exact:${w.toFund}`, 48000n)]));
  fund.cosign(oct.pub, body([entry(`exact:${w.toFund}`, 48000n)]), { resolveKey, descriptor });
  const nov = statement([line(2, "48000", "2026-11")], body([entry(`exact:${w.toFund}`, 48000n)]), { period: "2026-11", previous: S.statementHash(oct.payload) });
  assert.throws(() => fund.cosign(nov.pub, body([entry(`exact:${w.toFund}`, 48000n)]), { resolveKey, descriptor }), /listed twice/);
});

test("references have one spelling: mixed-case hex is not canonical, so one claim cannot be counted as two", async () => {
  const w = setup();
  const c = await claim(w, 5000n);
  const lower = `claim:${c.tx}:${c.channelId}`;
  const upper = `claim:${c.tx}:${c.channelId.toUpperCase().replace("0X", "0x")}`;
  assert.equal(S.canonicalRef(upper), lower);
  assert.equal(entry(upper, 5000n), entry(lower, 5000n), "formatSettlement writes the canonical form");
  const raw = `${FUND}|${USDC.toLowerCase()}|${upper}|5000`;
  assert.throws(() => S.parseSettlement(raw), /canonical/);
  const settlements = body([`${FUND}|${USDC.toLowerCase()}|${lower}|5000`, raw].sort());
  const { pub } = statement([line(1, "5000"), line(2, "5000")], settlements);
  assert.throws(() => fundOf(w).cosign(pub, settlements, { resolveKey }), /canonical/);
});

test("claim parts never add up to more than the claim's increase, within a file or across periods", async () => {
  const w = setup();
  const c = await claim(w, 5000n);
  const ref = `claim:${c.tx}:${c.channelId}`;
  const over = statement([line(1, "6000")], body([entry(ref, 6000n)]));
  assert.throws(() => fundOf(w).cosign(over.pub, body([entry(ref, 6000n)]), { resolveKey }), /more than the claim/);
  const fund = fundOf(w);
  const oct = statement([line(1, "2000")], body([entry(ref, 2000n)]));
  fund.cosign(oct.pub, body([entry(ref, 2000n)]), { resolveKey });
  const nov = statement([line(2, "3000", "2026-11")], body([entry(ref, 3000n)]), { period: "2026-11", previous: S.statementHash(oct.payload) });
  fund.cosign(nov.pub, body([entry(ref, 3000n)]), { resolveKey });
  const dec = statement([line(3, "1", "2026-12")], body([entry(ref, 1n)]), { period: "2026-12", previous: S.statementHash(nov.payload) });
  assert.throws(() => fund.cosign(dec.pub, body([entry(ref, 1n)]), { resolveKey }), /more than the claim/, "5000 already attributed");
});

test("the fund refuses a transfer to someone else, references that do not add up, and entries with no totals row", () => {
  const w = setup();
  const wrong = statement([line(1, "48000")], body([entry(`exact:${w.elsewhere}`, 48000n)]));
  assert.throws(() => fundOf(w).cosign(wrong.pub, body([entry(`exact:${w.elsewhere}`, 48000n)]), { resolveKey }), /not a transfer/);
  const short = body([entry(`exact:${w.toFund}`, 48000n)]);
  const two = statement([line(1, "48000"), line(2, "48000")], short);
  assert.throws(() => fundOf(w).cosign(two.pub, short, { resolveKey }), /do not add up/);
  const otherAsset = body([S.formatSettlement({ fund: FUND, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", ref: `exact:${w.toFund2}`, amount: 48000n }), entry(`exact:${w.toFund}`, 48000n)].sort());
  const extra = statement([line(1, "48000")], otherAsset);
  assert.throws(() => fundOf(w).cosign(extra.pub, otherAsset, { resolveKey }), /no totals row/);
});

test("a totals row that is not in canonical form is refused before anyone checks it", () => {
  const w = setup();
  const { payload } = statement([], "");
  const mixed = { ...payload, size: 0, totals: [{ fund: FUND.toUpperCase().replace("EIP155", "eip155").replace("0X", "0x"), asset: USDC.toLowerCase(), lines: 1, amount: "999999999" }] };
  const pub = S.signStatement({ ...mixed, size: 1 } as StatementPayload, logKey);
  const check = S.verifyStatement(pub, { resolveKey, requireCosigners: [] });
  assert.equal(check.ok, false);
  assert.match(check.problems.join(" "), /form lines use/);
  assert.throws(() => fundOf(w).cosign(pub, "", { resolveKey }), /fund refuses/);
});

test("statement payloads are checked field by field", () => {
  const { payload } = statement([line(1, "48000")], body([]));
  const sign = (p: unknown) => ({ statement: { format: "jws" as const, signature: S.jwsSign(new TextEncoder().encode(S.canonicalize(p)), logKey) }, cosignatures: [] });
  const bad: Array<[string, unknown]> = [
    ["period", { ...payload, period: "2026-1x" }],
    ["size", { ...payload, size: -5 }],
    ["root", { ...payload, root: "not-hex" }],
    ["numeric amount", { ...payload, totals: [{ ...payload.totals[0], amount: 48000 }] }],
    ["extra field", { ...payload, note: "x" }],
    ["previous", { ...payload, previous: "x" }],
    ["settlements", { ...payload, settlements: "" }],
    ["issuedAt", { ...payload, issuedAt: -1 }],
    ["boolean", { ...payload, previous: false }],
    ["size and totals disagree", { ...payload, size: 2 }],
  ];
  for (const [name, p] of bad) assert.equal(S.verifyStatement(sign(p), { resolveKey }).ok, false, name);
  assert.equal(S.verifyStatement(sign(payload), { resolveKey }).ok, true, "the untouched payload verifies");
  assert.deepEqual(S.statementProblems(payload), []);
});

// ---- witnesses -------------------------------------------------------------------------------

test("a witness that checks the files refuses a wrong settlements file, sums that do not add up, and lines from another period", () => {
  const w = setup();
  const settlements = body([entry(`exact:${w.toFund}`, 48000n)]);
  const good = statement([line(1, "48000")], settlements);
  const lines = S.fileBody([line(1, "48000")]);
  const other = body([entry(`exact:${w.toFund2}`, 48000n)]);
  assert.throws(() => new S.Witness(witnessKey).cosign(good.pub, { resolveKey, files: { lines, settlements: other } }), /hash differs/);
  const short = statement([line(1, "48000"), line(2, "48000")], settlements);
  assert.throws(() => new S.Witness(witnessKey).cosign(short.pub, { resolveKey, files: { lines: S.fileBody([line(1, "48000"), line(2, "48000")]), settlements } }), /add up/);
  const sept = statement([line(3, "48000", "2026-09")], settlements, { period: "2026-10" });
  assert.throws(() => new S.Witness(witnessKey).cosign(sept.pub, { resolveKey, files: { lines: S.fileBody([line(3, "48000", "2026-09")]), settlements } }), /another period/);
  new S.Witness(witnessKey).cosign(good.pub, { resolveKey, files: { lines, settlements } });
});

// ---- owners' receipts and the chain -----------------------------------------------------------

test("a receipt whose line is from another period does not verify, even when its audit path does", () => {
  const sept = statement([line(3, "48000", "2026-09")], body([]), { period: "2026-10" });
  const batch = S.buildBatch([line(3, "48000", "2026-09")]);
  const r = S.buildReceipt(sept.pub, batch, shareId(3));
  const check = S.verifyReceipt(r, { resolveKey });
  assert.equal(check.included, true);
  assert.equal(check.period, false);
  assert.equal(check.ok, false);
});

test("a statement is checked against the descriptor's log, and the chain against each previous hash", () => {
  const oct = statement([], "");
  const check = S.verifyStatement(oct.pub, { resolveKey, descriptor: { ...descriptor, log: "https://other.example/solidarity" } });
  assert.ok(check.problems.includes("statement is for another log"));
  const nov = statement([], "", { period: "2026-11", previous: "00".repeat(32) });
  const res = S.verifyChain([oct.pub, nov.pub]);
  assert.equal(res.ok, false);
  assert.match(res.problems.join(" "), /previous does not match/);
  const good = statement([], "", { period: "2026-11", previous: S.statementHash(oct.payload) });
  assert.deepEqual(S.verifyChain([oct.pub, good.pub]), { ok: true, problems: [] });
});

test("a statement key must belong to the log's host, with or without a descriptor", async () => {
  const w = setup();
  const settlements = body([entry(`exact:${w.toFund}`, 48000n)]);
  const forged = statement([line(1, "48000")], settlements, { key: attackerKey });
  const r = S.verifyStatement(forged.pub, { resolveKey });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /not authorized/);
  const receipt = S.buildReceipt(forged.pub, S.buildBatch([line(1, "48000")]), shareId(1));
  const rc = S.verifyReceipt(receipt, { resolveKey });
  assert.equal(rc.ok, false);
  assert.equal(rc.signature, false);
  assert.throws(() => new S.Witness(witnessKey).cosign(forged.pub, { resolveKey }), /not authorized/);
  assert.throws(() => fundOf(w).cosign(forged.pub, settlements, { resolveKey }), /not authorized/);
  // A verifier that has checked the DNS route itself can say so.
  assert.equal(S.verifyStatement(forged.pub, { resolveKey, authorizeLogKey: () => true }).ok, true);
  assert.equal(S.didWebHost("did:web:log.example%3A8443:solidarity#k"), "log.example:8443");
  assert.ok(S.kidOnLogHost("did:web:log.example#1", LOG));
  assert.ok(!S.kidOnLogHost("did:web:log.example.attacker.example#1", LOG));
});

test("JWS alg is tied to the key type", () => {
  const p256 = S.generateSigningKey("ES256", "did:web:log.example#p256");
  const payload = new TextEncoder().encode("{}");
  const asEd = `${b64url(new TextEncoder().encode(S.canonicalizeStrict({ alg: "EdDSA", kid: p256.kid })))}.${b64url(payload)}`;
  const der = nodeSign("sha256", new TextEncoder().encode(asEd), p256.privateKey); // a DER ECDSA signature
  assert.equal(S.jwsVerify(`${asEd}.${b64url(der)}`, p256.publicKey), false, "EdDSA header, P-256 key");
  const ed = S.jwsSign(payload, logKey);
  assert.equal(S.jwsVerify(ed, logKey.publicKey), true);
  const asEs = ed.replace(ed.split(".")[0], b64url(new TextEncoder().encode(S.canonicalizeStrict({ alg: "ES256", kid: logKey.kid }))));
  assert.equal(S.jwsVerify(asEs, logKey.publicKey), false, "ES256 header, Ed25519 key");
  assert.equal(S.jwsVerify(S.jwsSign(payload, p256), p256.publicKey), true);
});

// ---- books ------------------------------------------------------------------------------------

test("a book refuses lines from another period, and a first statement after a month with shares", () => {
  const book = new S.LogBook({ version: 2, log: LOG, funds: [FUND], keys: descriptor.keys }, logKey);
  assert.throws(() => book.close("2026-10", [line(1, "48000", "2026-09")]), /another period/);
  book.markActive("2026-10");
  assert.throws(() => book.close("2026-11", []), /first statement must be for 2026-10/);
  book.close("2026-09", []);
  assert.throws(() => book.close("2026-11", []), /must be for 2026-10/);
});

// ---- processor mode --------------------------------------------------------------------------

test("two processors paying one fund in one period: payout references differ, and the fund cosigns both", () => {
  const fundUri = "https://fund.example/solidarity";
  const policy: S.OwnerPolicy = { version: 2, rate: "0.01", cap: { amount: "100000", asset: "USD" }, fund: fundUri, refunds: "keep", since: "2026-10-01T00:00:00Z" };
  const clock = { now: Date.UTC(2026, 9, 10) / 1000 };
  const processors = ["a", "b"].map((x) => {
    const kid = `did:web:processor-${x}.example#1`;
    const key = S.generateSigningKey("EdDSA", kid);
    const p = new S.ProcessorHolder({ descriptor: { version: 2, log: `https://processor-${x}.example/solidarity`, funds: [fundUri], keys: [{ kid, from: "2026-10", until: null }] }, key, clock: () => clock.now });
    p.addOwner("owner", policy);
    p.recordPurchase({ owner: "owner", purchaseId: `${x}-1`, amount: "20000", asset: "USD" });
    p.collect();
    return { p, key };
  });
  clock.now = Date.UTC(2026, 10, 2) / 1000;
  const view: S.FundView = {
    exactTransfer: () => undefined,
    claimIncrease: () => undefined,
    payout: (ref, log) => processors.find((x) => x.p.book.descriptor.log === log)?.p.payoutRecord(ref),
  };
  const resolve = S.staticResolver({ [fundKey.kid]: fundKey.publicKey, ...Object.fromEntries(processors.map((x) => [x.key.kid, x.key.publicKey])) });
  const fund = new S.FundCosigner({ fund: fundUri, key: fundKey, view });
  const refs = processors.map(({ p }) => {
    const st = p.closePeriod("2026-10");
    const settlements = p.handle("/settlements/2026-10").body;
    fund.cosign(st, settlements, { resolveKey: resolve });
    return S.parseSettlement(settlements.trim()).ref;
  });
  assert.notEqual(refs[0], refs[1]);
  assert.match(refs[0], /^payout:processor-a\.example\//);
});

test("payout references are the processor's own: the fund keys them by log, so two logs may use the same one", () => {
  const fundUri = "https://fund.example/solidarity";
  const keys = ["a", "b"].map((x) => S.generateSigningKey("EdDSA", `did:web:processor-${x}.example#1`));
  const logs = ["a", "b"].map((x) => `https://processor-${x}.example/solidarity`);
  const settlements = `${S.formatSettlement({ fund: fundUri, asset: "USD", ref: "payout:2026-10-1", amount: "200" })}\n`;
  const lineFor = (n: number) => S.formatLine({ period: "2026-10", fund: fundUri, asset: "USD", id: shareId(n), amount: "200" });
  const view: S.FundView = { exactTransfer: () => undefined, claimIncrease: () => undefined, payout: (ref, log) => (ref === "2026-10-1" && logs.includes(log) ? { asset: "USD", amount: 200n } : undefined) };
  const fund = new S.FundCosigner({ fund: fundUri, key: fundKey, view });
  const resolve = S.staticResolver({ [keys[0].kid]: keys[0].publicKey, [keys[1].kid]: keys[1].publicKey });
  for (const i of [0, 1]) {
    const { pub } = statement([lineFor(i + 1)], settlements, { key: keys[i], log: logs[i] });
    fund.cosign(pub, settlements, { resolveKey: resolve });
  }
});

test("net credits are counted per purchase: two partial refunds of a share the cap cut never credit more than it", () => {
  const descriptorP = { version: 2 as const, log: "https://processor.example/solidarity", funds: ["https://fund.example/solidarity"], keys: [{ kid: "did:web:processor.example#1", from: "2026-10", until: null }] };
  const p = new S.ProcessorHolder({ descriptor: descriptorP, key: S.generateSigningKey("EdDSA", "did:web:processor.example#1"), clock: () => Date.UTC(2026, 9, 10) / 1000 });
  p.addOwner("o", { version: 2, rate: "0.001", cap: { amount: "100", asset: "USD" }, fund: "https://fund.example/solidarity", refunds: "net", since: "2026-10-01T00:00:00Z" });
  const id = p.recordPurchase({ owner: "o", purchaseId: "big", amount: "1000000", asset: "USD" }) as string; // floor would be 1000; the cap leaves 100
  assert.equal(p.shareAmount(id), 100n);
  const c1 = p.refund({ purchaseId: "big", refunded: "500000" }).credit;
  const c2 = p.refund({ purchaseId: "big", refunded: "500000" }).credit;
  assert.equal(c1 + c2, 100n);
  assert.equal(S.netCredit("1000000", "0.001", "100", c1), c2);
});
