import assert from "node:assert/strict";
import { test } from "node:test";
import * as S from "../src/solidarity/index.ts";
import type { PublishedStatement, Receipt, StatementPayload } from "../src/solidarity/index.ts";
import { b64url } from "../src/solidarity/utils.ts";
import { conformance, conformanceText } from "./helpers.ts";

const V = conformance("spec-draft2-vectors.json");
const ST = conformance("statements.json");
const logKey = S.ed25519FromSeed(V.keys.log.privateKeyHex, V.keys.log.kid);
const witnessKey = S.ed25519FromSeed(V.keys.witness.privateKeyHex, V.keys.witness.kid);
const fundKey = S.ed25519FromSeed("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7", ST.keys.fund.kid);
const resolveKey = S.staticResolver({ [logKey.kid]: logKey.publicKey, [witnessKey.kid]: witnessKey.publicKey, [fundKey.kid]: fundKey.publicKey });
const pubs: PublishedStatement[] = ["2026-10", "2026-11", "2026-12"].map((p) => JSON.parse(conformanceText(`files/${p}.statement.json`)));

test("RFC 8032 section 7.1 test keys: public keys derive from the seeds", () => {
  assert.equal(S.ed25519PublicKeyHex(logKey.publicKey), V.keys.log.publicKeyHex);
  assert.equal(S.ed25519PublicKeyHex(witnessKey.publicKey), V.keys.witness.publicKeyHex);
  assert.equal(S.ed25519PublicKeyHex(fundKey.publicKey), "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025");
});

test("spec draft 2 vectors: lines, root, totals, settlements, JCS, hashes and JWS strings, byte for byte", () => {
  const formatted = V.lines.input.map((l: string) => S.formatLine(S.parseLine(l)));
  assert.deepEqual(formatted, V.lines.input);
  const mixed = S.formatLine({ ...S.parseLine(V.lines.input[0]), fund: "eip155:84532:0x000000000000000000000000000000000000F00D", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" });
  assert.equal(mixed, V.lines.input[0], "formatLine lowercases EVM addresses");
  const b = S.buildBatch(V.lines.input);
  assert.deepEqual(b.lines, V.lines.sorted);
  assert.equal(b.root, V.lines.root);
  assert.equal(b.size, V.lines.size);
  assert.deepEqual(b.totals, V.lines.totals);
  assert.equal(S.buildBatch([]).root, V.emptyBatch.root);
  assert.equal(S.sha256Hex(V.settlements.body), V.settlements.sha256);
  assert.equal(S.fileBody(S.parseFileBody(V.settlements.body)), V.settlements.body);
  assert.ok(S.settlementsMatchTotals(S.parseFileBody(V.settlements.body), b.totals));
  for (const s of V.statements) {
    assert.equal(S.canonicalizeStrict(s.payload), s.jcs);
    assert.equal(S.statementHash(s.payload), s.sha256);
    assert.equal(S.signStatement(s.payload, logKey).statement.signature, s.published.statement.signature);
    assert.equal(S.jwsSign(S.statementBytes(s.payload), witnessKey), s.published.cosignatures[0].signature);
  }
  assert.equal(V.statements[1].payload.previous, V.statements[0].sha256);
  const r = S.buildReceipt(V.statements[0].published, b, S.parseLine(V.lines.input[0]).id);
  assert.deepEqual(r, V.receipt);
});

test("receipts verify: inclusion, period, JCS form, log signature and required cosignatures", () => {
  const ok = S.verifyReceipt(V.receipt, { resolveKey, requireCosigners: [witnessKey.kid] });
  assert.equal(ok.ok, true, ok.problems.join("; "));
  const missing = S.verifyReceipt(V.receipt, { resolveKey, requireCosigners: [fundKey.kid] });
  assert.equal(missing.ok, false);
  const wrongIndex: Receipt = { ...V.receipt, index: 0 };
  assert.equal(S.verifyReceipt(wrongIndex, { resolveKey }).included, false);
  const otherLine: Receipt = { ...V.receipt, line: V.receipt.line.replace("|48000", "|48001") };
  assert.equal(S.verifyReceipt(otherLine, { resolveKey }).ok, false);
  const noKey = S.verifyReceipt(V.receipt, { resolveKey: () => undefined });
  assert.equal(noKey.signature, false);
  for (const id of ["conformance-share-0001", "conformance-share-0011", "conformance-share-0012", "conformance-share-0014", "conformance-share-0017"]) {
    const rc = conformance(`receipts/${id}.json`);
    const res = S.verifyReceipt(rc, { resolveKey, descriptor: ST.descriptor, requireCosigners: [witnessKey.kid, fundKey.kid] });
    assert.equal(res.ok, true, `${id}: ${res.problems.join("; ")}`);
  }
});

test("a payload that is not in JCS form is rejected, even with a valid signature", () => {
  const payload = V.statements[0].payload as StatementPayload;
  const pretty = new TextEncoder().encode(JSON.stringify(payload, null, 1));
  const jws = S.jwsSign(pretty, logKey);
  assert.equal(S.jwsVerify(jws, logKey.publicKey), true);
  assert.throws(() => S.decodeStatement({ format: "jws", signature: jws }), /JCS/);
  const res = S.verifyStatement({ statement: { format: "jws", signature: jws }, cosignatures: [] }, { resolveKey });
  assert.equal(res.ok, false);
});

test("the three-month chain: signatures, cosignatures, previous hashes, consecutive periods", () => {
  for (const [i, p] of pubs.entries()) {
    const req = i === 2 ? [witnessKey.kid, fundKey.kid] : [witnessKey.kid];
    const r = S.verifyStatement(p, { resolveKey, descriptor: ST.descriptor, requireCosigners: req });
    assert.equal(r.ok, true, r.problems.join("; "));
    assert.equal(r.hash, ST.periods[i].sha256);
    assert.equal(S.canonicalizeStrict(r.payload), ST.periods[i].jcs);
  }
  assert.equal(pubs[0].statement.signature, V.statements[0].published.statement.signature, "2026-10 is the spec vector");
  assert.equal(pubs[1].statement.signature, V.statements[1].published.statement.signature, "2026-11 is the spec vector");
  assert.deepEqual(S.verifyChain(pubs), { ok: true, problems: [] });
  assert.equal(S.verifyChain([pubs[0], pubs[2]]).ok, false, "a gap is visible");
  assert.equal(S.verifyChain([pubs[1], pubs[0]]).ok, false);
});

test("a statement key must be listed in the descriptor for the period", () => {
  const d = { log: ST.descriptor.log, keys: [{ kid: logKey.kid, from: "2026-11", until: "2026-11" }] };
  assert.ok(S.keyCoversPeriod(d, logKey.kid, "2026-11"));
  assert.ok(!S.keyCoversPeriod(d, logKey.kid, "2026-10"));
  assert.ok(!S.keyCoversPeriod(d, logKey.kid, "2026-12"));
  assert.ok(S.verifyStatement(pubs[0], { resolveKey, descriptor: d }).problems.some((p) => p.includes("not listed")));
  assert.ok(S.keyCoversPeriod({ keys: [{ kid: "k", from: "2026-01", until: null }] }, "k", "2099-12"));
});

test("witness: verifies, chains, walks history, and never cosigns two payloads for one period", () => {
  const w = new S.Witness(witnessKey);
  const files = (p: string) => ({ lines: conformanceText(`files/${p}.lines`), settlements: conformanceText(`files/${p}.settlements`) });
  const c10 = w.cosign(pubs[0], { resolveKey, descriptor: ST.descriptor, files: files("2026-10") });
  assert.equal(c10.signature, V.statements[0].published.cosignatures[0].signature);
  assert.deepEqual(w.cosign(pubs[0], { resolveKey }), c10, "same payload again: same cosignature");
  // Skipping 2026-11 without the history fails; with it, it passes.
  assert.throws(() => w.cosign(pubs[2], { resolveKey }), /chain/);
  w.cosign(pubs[2], { resolveKey, history: [pubs[1]], files: files("2026-12") });
  // A second, different payload for 2026-12 is refused.
  const forked: StatementPayload = { ...S.decodeStatement(pubs[2].statement).payload, issuedAt: 1799107201 };
  assert.throws(() => w.cosign(S.signStatement(forked, logKey), { resolveKey }), /another payload/);
  // A statement whose files do not reproduce it is refused by a fresh witness that checks files.
  const w2 = new S.Witness(witnessKey);
  assert.throws(() => w2.cosign(pubs[2], { resolveKey, files: { lines: "", settlements: files("2026-12").settlements } }), /reproduce/);
  // A bad log signature is refused.
  const w3 = new S.Witness(witnessKey);
  const other = S.generateSigningKey("EdDSA", logKey.kid);
  assert.throws(() => w3.cosign(S.signStatement(S.decodeStatement(pubs[0].statement).payload, other), { resolveKey }), /signature/);
});

test("fund cosignature: refuses references it cannot find, wrong amounts and references another log listed", () => {
  const p = pubs[2];
  const settlements = conformanceText("files/2026-12.settlements");
  const entries = S.parseFileBody(settlements).map(S.parseSettlement);
  const transfers = new Map<string, { token: string; to: string; value: bigint }>();
  const claims = new Map<string, bigint>();
  for (const e of entries) {
    const [kind, tx, ch] = e.ref.split(":");
    if (kind === "exact") transfers.set(tx, { token: e.asset, to: "0x000000000000000000000000000000000000f00d", value: BigInt(e.amount) });
    else claims.set(`${tx}|${ch}`, BigInt(e.amount));
  }
  const view = (scale = 1n): S.FundView => ({
    exactTransfer: (tx) => {
      const t = transfers.get(tx);
      return t && { ...t, value: t.value * scale };
    },
    claimIncrease: (tx, ch) => {
      const inc = claims.get(`${tx}|${ch}`);
      return inc === undefined ? undefined : { receiver: "0x000000000000000000000000000000000000F00D", receiverAuthorizer: "0x3333333333333333333333333333333333333333", token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", increase: inc };
    },
  });
  const auth = { [ST.descriptor.log]: "0x3333333333333333333333333333333333333333" };
  const good = new S.FundCosigner({ fund: ST.keys.fund.fund, key: fundKey, view: view(), logAuthorizers: auth });
  const env = good.cosign(p, settlements, { resolveKey, descriptor: ST.descriptor });
  assert.equal(env.signature, p.cosignatures.find((c) => S.jwsDecode(c.signature).header.kid === fundKey.kid)?.signature);
  assert.throws(() => new S.FundCosigner({ fund: ST.keys.fund.fund, key: fundKey, view: view(2n), logAuthorizers: auth }).cosign(p, settlements, { resolveKey }), /not a transfer/);
  assert.throws(() => new S.FundCosigner({ fund: ST.keys.fund.fund, key: fundKey, view: view(), logAuthorizers: {} }).cosign(p, settlements, { resolveKey }), /not a claim/);
  assert.deepEqual(good.cosign(p, settlements, { resolveKey }), env, "the same statement again: the same cosignature");
  assert.throws(() => new S.FundCosigner({ fund: ST.keys.fund.fund, key: fundKey, view: view(), logAuthorizers: auth }).cosign(p, `${settlements}x\n`, { resolveKey }), /hash/);
  // The same references listed by another log are refused.
  const otherLogKey = S.generateSigningKey("EdDSA", "did:web:other.example#1");
  const otherPayload: StatementPayload = { ...S.decodeStatement(p.statement).payload, log: "https://other.example/solidarity", previous: null };
  const otherPub = S.signStatement(otherPayload, otherLogKey);
  const resolve2 = S.staticResolver({ [otherLogKey.kid]: otherLogKey.publicKey });
  assert.throws(() => good.cosign(otherPub, settlements, { resolveKey: resolve2 }), /another log/);
});

test("ES256 statements sign and verify with raw r||s", () => {
  const k = S.generateSigningKey("ES256", "did:web:log.example#p256");
  const pub = S.signStatement(V.statements[1].payload, k);
  const d = S.jwsDecode(pub.statement.signature);
  assert.equal(d.header.alg, "ES256");
  assert.equal(d.signature.length, 64);
  assert.ok(S.jwsVerify(pub.statement.signature, k.publicKey));
  assert.ok(!S.jwsVerify(pub.statement.signature, S.generateSigningKey("ES256", "x").publicKey));
  const parts = pub.statement.signature.split(".");
  const flipped = `${parts[0]}.${b64url(new TextEncoder().encode(S.canonicalizeStrict({ ...V.statements[1].payload, size: 1 })))}.${parts[2]}`;
  assert.ok(!S.jwsVerify(flipped, k.publicKey));
});

test("lines and batches reject what the spec rules out", () => {
  const ok = { period: "2026-12", fund: "eip155:84532:0x000000000000000000000000000000000000f00d", asset: "USD", id: "abcdefghijklmnopqrstuv", amount: "1" };
  assert.equal(S.formatLine(ok), "solidarity/2|2026-12|eip155:84532:0x000000000000000000000000000000000000f00d|USD|abcdefghijklmnopqrstuv|1");
  for (const bad of [{ amount: "0" }, { amount: "01" }, { period: "2026-13" }, { id: "short" }, { fund: "a|b" }, { asset: "has space" }]) {
    assert.throws(() => S.formatLine({ ...ok, ...bad }), JSON.stringify(bad));
  }
  assert.throws(() => S.parseLine("solidarity/2|2026-12|eip155:84532:0x000000000000000000000000000000000000F00D|USD|abcdefghijklmnopqrstuv|1"), /canonical/);
  const l1 = S.formatLine(ok);
  assert.throws(() => S.buildBatch([l1, S.formatLine({ ...ok, amount: "2" })]), /twice/, "a repeated id is invalid even with different lines");
  assert.throws(() => S.buildBatch([l1, S.formatLine({ ...ok, id: "zzzzzzzzzzzzzzzzzzzzzz", period: "2027-01" })]), /one period/);
  assert.throws(() => S.parseFileBody("b\na\n"), /sorted/);
  assert.throws(() => S.parseFileBody("a"), /LF/);
  assert.throws(() => S.formatSettlement({ fund: "f", asset: "a", ref: "gift:1", amount: "1" }));
});

// ---- review of draft 2 -------------------------------------------------------------------

test("witness: a right-period statement whose previous forks the chain is refused, and so is history that does not chain", () => {
  const w = new S.Witness(witnessKey);
  w.cosign(pubs[0], { resolveKey, descriptor: ST.descriptor });
  const nov = S.decodeStatement(pubs[1].statement).payload;
  const fork = S.signStatement({ ...nov, previous: "00".repeat(32) }, logKey);
  assert.throws(() => w.cosign(fork, { resolveKey }), /previous does not chain/);
  // History whose first statement does not chain from the last cosigned payload, and a statement chained to it.
  const badNov = S.signStatement({ ...nov, previous: "11".repeat(32) }, logKey);
  const dec = S.decodeStatement(pubs[2].statement).payload;
  const onBad = S.signStatement({ ...dec, previous: S.statementHash(S.decodeStatement(badNov.statement).payload) }, logKey);
  assert.throws(() => w.cosign(onBad, { resolveKey, history: [badNov] }), /history does not chain/);
  w.cosign(pubs[2], { resolveKey, history: [pubs[1]] });
});

test("witness: a log's first statement is for the from period of its earliest key", () => {
  const late = { ...ST.descriptor, keys: [{ ...ST.descriptor.keys[0], from: "2026-09" }] };
  assert.throws(() => new S.Witness(witnessKey).cosign(pubs[0], { resolveKey, descriptor: late }), /first period is 2026-09/);
  new S.Witness(witnessKey).cosign(pubs[0], { resolveKey, descriptor: ST.descriptor });
  assert.equal(S.firstPeriod(ST.descriptor), "2026-10");
});

test("a cosignature over another payload does not count, even with a required cosigner's valid key", () => {
  const oct = S.decodeStatement(pubs[0].statement).payload;
  const other = S.jwsSign(S.statementBytes({ ...oct, issuedAt: oct.issuedAt + 1 }), witnessKey);
  const r = S.verifyStatement({ statement: pubs[0].statement, cosignatures: [{ format: "jws", signature: other }] }, { resolveKey, requireCosigners: [witnessKey.kid] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.cosigners, []);
});

test("key rotation: a retired key verifies from the descriptor's JWK, only with a required cosignature; did:web authorizes only the current key", () => {
  const newKey = S.generateSigningKey("EdDSA", "did:web:log.example#test-only-next");
  const rotated = {
    log: ST.descriptor.log,
    keys: [
      { kid: logKey.kid, from: "2026-10", until: "2026-11", jwk: S.publicJwk(logKey.publicKey) },
      { kid: newKey.kid, from: "2026-12", until: null, jwk: S.publicJwk(newKey.publicKey) },
    ],
  };
  assert.deepEqual(rotated.keys[0].jwk, ST.descriptor.keys[0].jwk, "the conformance descriptor carries the same JWK");
  // did:web and DNS now show only the new key.
  const current = S.staticResolver({ [newKey.kid]: newKey.publicKey, [witnessKey.kid]: witnessKey.publicKey });
  const onlyCurrent = (kid: string) => kid === newKey.kid;
  const cosigned = S.verifyStatement(pubs[0], { resolveKey: current, descriptor: rotated, requireCosigners: [witnessKey.kid], authorizeLogKey: onlyCurrent });
  assert.equal(cosigned.ok, true, cosigned.problems.join("; "));
  const bare = S.verifyStatement(pubs[0], { resolveKey: current, descriptor: rotated, authorizeLogKey: onlyCurrent });
  assert.equal(bare.ok, false);
  assert.match(bare.problems.join(" "), /retired/);
  assert.equal(S.verifyStatement(pubs[0], { resolveKey: current, requireCosigners: [witnessKey.kid], authorizeLogKey: onlyCurrent }).ok, false, "without the descriptor the old key cannot be found");
  const receipt = S.verifyReceipt(V.receipt, { resolveKey: current, descriptor: rotated, requireCosigners: [witnessKey.kid], authorizeLogKey: onlyCurrent });
  assert.equal(receipt.ok, true, receipt.problems.join("; "));
  // Outside the retired key's periods, cosigned or not, it is refused.
  const dec = S.verifyStatement(pubs[2], { resolveKey: current, descriptor: rotated, requireCosigners: [witnessKey.kid], authorizeLogKey: onlyCurrent });
  assert.equal(dec.ok, false);
  assert.match(dec.problems.join(" "), /not listed/);
  // The current key still needs did:web or DNS.
  const signedNew = S.signStatement(S.decodeStatement(pubs[2].statement).payload, newKey);
  assert.equal(S.verifyStatement(signedNew, { resolveKey: current, descriptor: rotated }).ok, true);
  assert.equal(S.verifyStatement(signedNew, { resolveKey: current, descriptor: rotated, authorizeLogKey: () => false }).ok, false);
});

test("verifyReceipt and verifyChain report malformed input as problems instead of throwing", () => {
  const cases: Array<[string, unknown]> = [["non-hex", ["zz".repeat(32)]], ["odd length", ["abc"]], ["number", [42]], ["missing", undefined], ["not an array", "abc"]];
  for (const [name, proof] of cases) {
    let out: S.ReceiptCheck | undefined;
    assert.doesNotThrow(() => {
      out = S.verifyReceipt({ ...V.receipt, proof } as unknown as Receipt, { resolveKey });
    }, name);
    assert.equal(out?.ok, false, name);
    assert.equal(out?.included, false, name);
  }
  assert.equal(S.verifyReceipt({ ...V.receipt, line: 7 } as unknown as Receipt, { resolveKey }).ok, false);
  let chain: { ok: boolean; problems: string[] } | undefined;
  assert.doesNotThrow(() => {
    chain = S.verifyChain([pubs[0], { statement: { format: "jws", signature: "not.a.jws" }, cosignatures: [] }, pubs[2]]);
  });
  assert.equal(chain?.ok, false);
  assert.match(chain?.problems.join(" ") ?? "", /statement 1/);
});
