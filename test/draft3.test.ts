/**
 * The rules draft 3 of the spec (2026-10-23) added, each tested against the
 * text: which key may sign as a log, a witness's and a fund's record, one
 * stored payload per period, exact shares that are uncollected only once they
 * can no longer execute, late recording, held shares, a lost settle response,
 * and retiring a log. Test names start with the spec section they check.
 * SIMULATED: no network, no real tokens.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SimulatedChain } from "../src/sim/chain.ts";
import * as S from "../src/solidarity/index.ts";
import type { LogDescriptor, OwnerPolicy, PaymentPayload, PaymentRequirements, PublishedStatement, SettleResponse, SolidarityInfo } from "../src/solidarity/index.ts";
import { conformance, conformanceText } from "./helpers.ts";

const V = conformance("spec-draft2-vectors.json");
const ST = conformance("statements.json");
const P = conformance("payloads.json");
const logKey = S.ed25519FromSeed(V.keys.log.privateKeyHex, V.keys.log.kid);
const witnessKey = S.ed25519FromSeed(V.keys.witness.privateKeyHex, V.keys.witness.kid);
const resolveKey = S.staticResolver({ [logKey.kid]: logKey.publicKey, [witnessKey.kid]: witnessKey.publicKey });
const LOG: string = ST.descriptor.log;
const pubs: PublishedStatement[] = ["2026-10", "2026-11", "2026-12"].map((p) => JSON.parse(conformanceText(`files/${p}.statement.json`)));
/** A statement as the log first publishes it, before any cosignature (the conformance files carry this witness's own). */
const bare = (p: PublishedStatement): PublishedStatement => ({ statement: p.statement, cosignatures: [] });

const DESCRIPTOR: LogDescriptor = P.descriptor;
const POLICY: OwnerPolicy = P.policy;
const USDC = S.USDC_BASE_SEPOLIA.address;
const NET = "eip155:84532";
const FUND = "eip155:84532:0x000000000000000000000000000000000000f00d";
const FUND_ADDR = "0x000000000000000000000000000000000000f00d";
const ELSEWHERE = "0x5555555555555555555555555555555555555555";
const at = (iso: string) => Date.parse(iso) / 1000;

// ---- "Signatures and keys" ---------------------------------------------------------------

test("Signatures and keys: only the root did:web DID of the log's host authorizes a log key, never a path DID on that host", () => {
  // A witness's key served next to the log, on the log's own host (as the demo log serves its witness and fund).
  const neighbour = S.generateSigningKey("EdDSA", "did:web:log.example:witness#witness-1");
  const resolve = S.staticResolver({ [neighbour.kid]: neighbour.publicKey, [logKey.kid]: logKey.publicKey, [witnessKey.kid]: witnessKey.publicKey });
  const forged = S.signStatement(S.decodeStatement(pubs[0].statement).payload, neighbour);
  const r = S.verifyStatement(forged, { resolveKey: resolve });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /did:web:log\.example:witness#witness-1 is not authorized/);
  assert.equal(S.verifyReceipt({ ...V.receipt, statement: forged.statement, cosignatures: [] }, { resolveKey: resolve }).signature, false);
  assert.throws(() => new S.Witness(witnessKey).cosign(forged, { resolveKey: resolve, descriptor: ST.descriptor }), /not authorized/);
  const fund = new S.FundCosigner({ fund: FUND, key: witnessKey, view: { exactTransfer: () => undefined, claimIncrease: () => undefined } });
  assert.throws(() => fund.cosign(forged, "", { resolveKey: resolve }), /not authorized/);
  // The log's own root key still verifies.
  assert.equal(S.verifyStatement(bare(pubs[0]), { resolveKey: resolve }).ok, true);

  const ok = (kid: string, log = LOG) => S.didWebAuthorizesLogKey(kid, log);
  assert.ok(ok("did:web:log.example#test-only-1"));
  assert.ok(ok("did:web:LOG.example#1"), "hosts compare case-insensitively");
  assert.ok(ok("did:web:log.example"), "the DID alone, with no fragment");
  for (const kid of [
    "did:web:log.example:witness#1",
    "did:web:log.example:solidarity#1",
    "did:web:log.example/keys#1",
    "did:web:log.example?service=x#1",
    "did:web:log.example.attacker.example#1",
    "did:web:l%6Fg.example#1",
    "did:web:log.example%3A443#1",
    "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#1",
  ]) {
    assert.ok(!ok(kid), kid);
  }
  // A port is written %3A, in either case; a path after it is still a path.
  const withPort = "https://log.example:8443/solidarity";
  assert.ok(ok("did:web:log.example%3A8443#1", withPort));
  assert.ok(ok("did:web:log.example%3a8443#1", withPort));
  assert.ok(!ok("did:web:log.example#1", withPort));
  assert.ok(!ok("did:web:log.example%3A8443:solidarity#1", withPort));
  assert.equal(S.kidDid("did:web:log.example:witness#witness-1"), "did:web:log.example:witness");
  assert.equal(S.didWebOfHost("log.example:8443"), "did:web:log.example%3A8443");
  assert.equal(S.didWebOfHost("[::1]:8443"), "did:web:[::1]%3A8443", "only the port's colon is encoded");
});

test("Signatures and keys: the DNS route authorizes exactly the DIDs the TXT record at _controllers.<host> names", () => {
  const DIDKEY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  const records: Record<string, string[]> = { "log.example": ["did:web:log.example:solidarity", DIDKEY] };
  const asked: string[] = [];
  const authorize = S.logKeyAuthorizer({ dnsControllers: (host) => (asked.push(host), records[host]) });
  assert.ok(authorize("did:web:log.example#1", LOG), "the did:web route still applies");
  assert.ok(authorize("did:web:log.example:solidarity#key-1", LOG), "a path DID the record names");
  assert.ok(authorize(`${DIDKEY}#${DIDKEY.slice(8)}`, LOG));
  assert.ok(!authorize("did:web:log.example:witness#witness-1", LOG), "a path DID it does not name");
  assert.ok(!authorize("did:web:log.example:solidarity:more#1", LOG), "exactly the DID, not one under it");
  assert.ok(!authorize("did:web:log.example:solidarity#1", "https://other.example/solidarity"), "another host's record");
  authorize("did:web:x.example:y#1", "https://Log.Example:8443/solidarity");
  assert.equal(asked.at(-1), "log.example", "looked up by host name, without the port");
  // With no DNS answer, only the root did:web document authorizes.
  assert.ok(!S.logKeyAuthorizer()("did:web:log.example:solidarity#key-1", LOG));
  // As verifyStatement's authorizeLogKey.
  const k = S.generateSigningKey("EdDSA", "did:web:log.example:solidarity#key-1");
  const st = S.signStatement(S.decodeStatement(pubs[0].statement).payload, k);
  const resolve = S.staticResolver({ [k.kid]: k.publicKey });
  assert.equal(S.verifyStatement(st, { resolveKey: resolve }).ok, false);
  assert.equal(S.verifyStatement(st, { resolveKey: resolve, authorizeLogKey: authorize }).ok, true);
});

// ---- "Witnesses and the fund": the witness's record ---------------------------------------------

test("Witnesses and the fund: a witness with no record for a log never skips the previous check; it walks back to the log's first statement", () => {
  const w = new S.Witness(witnessKey);
  // Draft 2's witness cosigned this: with no record it made no previous check at all.
  assert.throws(() => w.cosign(bare(pubs[1]), { resolveKey, descriptor: ST.descriptor }), /needs history back to the log's first statement \(2026-10\)/);
  const nov = S.decodeStatement(pubs[1].statement).payload;
  const fork = S.signStatement({ ...nov, previous: "00".repeat(32) }, logKey);
  assert.throws(() => w.cosign(fork, { resolveKey, descriptor: ST.descriptor, history: [bare(pubs[0])] }), /previous does not chain to the history/);
  assert.throws(() => w.cosign(bare(pubs[2]), { resolveKey, descriptor: ST.descriptor, history: [bare(pubs[1])] }), /must start at the log's first statement/);
  assert.throws(() => new S.Witness(witnessKey).cosign(bare(pubs[0]), { resolveKey }), /needs the log's descriptor/);
  const c = w.cosign(bare(pubs[2]), { resolveKey, descriptor: ST.descriptor, history: [bare(pubs[0]), bare(pubs[1])] });
  assert.ok(S.jwsVerify(c.signature, witnessKey.publicKey));
  assert.deepEqual(w.record(), [{ log: LOG, period: "2026-12", hash: S.decodeStatement(pubs[2].statement).hash }], "it records only what it cosigned");
});

test("Witnesses and the fund: a witness with a record may be handed the whole chain; what it cosigned must match its record", () => {
  const w = new S.Witness(witnessKey);
  w.cosign(bare(pubs[0]), { resolveKey, descriptor: ST.descriptor });
  // History from the log's first statement: October is checked against the record, November chains.
  w.cosign(bare(pubs[2]), { resolveKey, history: [bare(pubs[0]), bare(pubs[1])] });
  assert.deepEqual(
    w.record().map((e) => e.period),
    ["2026-10", "2026-12"],
  );
  // A history that holds another October than the one it cosigned is refused.
  const w2 = new S.Witness(witnessKey);
  w2.cosign(bare(pubs[0]), { resolveKey, descriptor: ST.descriptor });
  const oct = S.decodeStatement(pubs[0].statement).payload;
  const otherOct = S.signStatement({ ...oct, issuedAt: oct.issuedAt + 1 }, logKey);
  assert.throws(() => w2.cosign(bare(pubs[2]), { resolveKey, history: [otherOct, bare(pubs[1])] }), /history holds another payload for 2026-10/);
});

test("Witnesses and the fund: a witness's record survives a restart, and is stored before the cosignature is returned", () => {
  const stored: S.WitnessRecordEntry[] = [];
  const w = new S.Witness(witnessKey, { persist: (e) => stored.push(e) });
  w.cosign(bare(pubs[0]), { resolveKey, descriptor: ST.descriptor });
  assert.deepEqual(stored, [{ log: LOG, period: "2026-10", hash: S.decodeStatement(pubs[0].statement).hash }]);
  // A storage failure: nothing is cosigned, and nothing is remembered.
  const failing = new S.Witness(witnessKey, {
    record: stored,
    persist: () => {
      throw new Error("disk full");
    },
  });
  assert.throws(() => failing.cosign(bare(pubs[1]), { resolveKey }), /disk full/);
  assert.equal(failing.record().length, 1);
  // After a restart, from the stored record: a second October payload and a November that forks are
  // refused, and the true November chains.
  const again = new S.Witness(witnessKey, { record: stored, persist: (e) => stored.push(e) });
  const oct = S.decodeStatement(pubs[0].statement).payload;
  assert.throws(() => again.cosign(S.signStatement({ ...oct, issuedAt: oct.issuedAt + 1 }, logKey), { resolveKey, descriptor: ST.descriptor }), /already cosigned another payload for 2026-10/);
  const nov = S.decodeStatement(pubs[1].statement).payload;
  assert.throws(() => again.cosign(S.signStatement({ ...nov, previous: "00".repeat(32) }, logKey), { resolveKey }), /previous does not chain to the last payload it cosigned/);
  again.cosign(bare(pubs[1]), { resolveKey });
  assert.deepEqual(
    stored.map((e) => e.period),
    ["2026-10", "2026-11"],
  );
  assert.throws(() => new S.Witness(witnessKey, { record: [stored[0], { ...stored[0], hash: "00".repeat(32) }] }), /two payloads/);
});

test("Witnesses and the fund: a witness that lost its record refuses a log whose statements carry its own cosignature; under a new kid it starts again", () => {
  const fresh = new S.Witness(witnessKey);
  assert.throws(() => fresh.cosign(pubs[0], { resolveKey, descriptor: ST.descriptor }), /lost its record/);
  assert.throws(() => fresh.cosign(bare(pubs[2]), { resolveKey, descriptor: ST.descriptor, history: [pubs[0], pubs[1]] }), /lost its record/);
  const renamed: S.SigningKey = { ...witnessKey, kid: "did:web:witness.example#test-only-2b" };
  const c = new S.Witness(renamed).cosign(bare(pubs[2]), { resolveKey, descriptor: ST.descriptor, history: [pubs[0], pubs[1]] });
  assert.equal(S.jwsDecode(c.signature).header.kid, renamed.kid);
});

test("Witnesses and the fund: a new witness walks history signed by a key the log has since retired, and refuses a gap in it", () => {
  const newKey = S.generateSigningKey("EdDSA", "did:web:log.example#test-only-next");
  const rotated = {
    log: LOG,
    keys: [
      { kid: logKey.kid, from: "2026-10", until: "2026-11", jwk: S.publicJwk(logKey.publicKey) },
      { kid: newKey.kid, from: "2026-12", until: null, jwk: S.publicJwk(newKey.publicKey) },
    ],
  };
  const current = S.staticResolver({ [newKey.kid]: newKey.publicKey }); // did:web now shows only the new key
  const dec = S.signStatement(S.decodeStatement(pubs[2].statement).payload, newKey);
  assert.throws(() => new S.Witness(witnessKey).cosign(dec, { resolveKey: current, descriptor: rotated, history: [bare(pubs[0])] }), /previous does not chain to the history/);
  const c = new S.Witness(witnessKey).cosign(dec, { resolveKey: current, descriptor: rotated, history: [bare(pubs[0]), bare(pubs[1])] });
  assert.ok(S.jwsVerify(c.signature, witnessKey.publicKey));
});

// ---- "Witnesses and the fund": the fund's record ------------------------------------------------

test("Witnesses and the fund: the fund's record survives a restart and covers every log that pays it", () => {
  const asset = USDC.toLowerCase();
  const chain = new SimulatedChain({ now: 1793000000 });
  const payer = privateKeyToAccount(generatePrivateKey());
  chain.mint(USDC, payer.address, 1_000_000n);
  const tx = chain.transfer(USDC, payer.address, FUND_ADDR, 48000n);
  const fundKey = S.generateSigningKey("EdDSA", "did:web:fund.example#1");
  const otherKey = S.generateSigningKey("EdDSA", "did:web:other.example#1");
  const resolve = S.staticResolver({ [logKey.kid]: logKey.publicKey, [otherKey.kid]: otherKey.publicKey });
  const settlements = S.fileBody([S.formatSettlement({ fund: FUND, asset, ref: `exact:${tx}`, amount: "48000" })]);
  const statement = (log: string, key: S.SigningKey, period: string, id: string) => {
    const batch = S.buildBatch([S.formatLine({ period, fund: FUND, asset, id, amount: "48000" })]);
    return S.signStatement(S.statementPayload({ log, period, batch, settlementsBody: settlements, previous: null, issuedAt: 1793836800 }), key);
  };
  const stored: S.FundRecord = { refs: [], cosigned: [] };
  const persist = (added: S.FundRecord) => {
    stored.refs = [...stored.refs.filter((r) => !added.refs.some((a) => a.ref === r.ref && a.log === r.log)), ...added.refs];
    stored.cosigned.push(...added.cosigned);
  };
  const first = statement(LOG, logKey, "2026-10", "fund-record-share-0001");
  new S.FundCosigner({ fund: FUND, key: fundKey, view: chain.fundView(), persist }).cosign(first, settlements, { resolveKey: resolve });
  assert.deepEqual(stored, { refs: [{ ref: `exact:${tx}`, log: LOG, used: "48000" }], cosigned: [{ log: LOG, period: "2026-10", hash: S.decodeStatement(first.statement).hash }] });
  // Restarted from its record: another log listing the same transfer, or this log listing it again, is refused.
  const again = new S.FundCosigner({ fund: FUND, key: fundKey, view: chain.fundView(), record: stored });
  assert.throws(() => again.cosign(statement("https://other.example/solidarity", otherKey, "2026-10", "fund-record-share-0002"), settlements, { resolveKey: resolve }), /already listed by another log/);
  assert.throws(() => again.cosign(statement(LOG, logKey, "2026-11", "fund-record-share-0003"), settlements, { resolveKey: resolve }), /listed twice/);
  assert.deepEqual(again.record(), stored);
  // The same payload again after the restart is cosigned again; another one for that period is not.
  assert.ok(S.jwsVerify(again.cosign(first, settlements, { resolveKey: resolve }).signature, fundKey.publicKey));
  // A storage failure: nothing is cosigned.
  const failing = new S.FundCosigner({
    fund: FUND,
    key: fundKey,
    view: chain.fundView(),
    persist: () => {
      throw new Error("disk full");
    },
  });
  assert.throws(() => failing.cosign(first, settlements, { resolveKey: resolve }), /disk full/);
  assert.deepEqual(failing.record(), { refs: [], cosigned: [] });
});

// ---- "Statements": one payload per period ------------------------------------------------------

test("Statements: a log stores each statement before it publishes it; if it cannot, the period stays open", async () => {
  const descriptor = { version: 2 as const, log: LOG, funds: [FUND], keys: [{ kid: "did:web:log.example#log-1", from: "2026-10", until: null }] };
  const key = S.generateSigningKey("EdDSA", descriptor.keys[0].kid);
  const chain = { submitExact: async () => ({ ok: false as const, error: "unused" }), channelState: () => undefined, claim: async () => ({ ok: false as const, error: "unused" }) };
  const now = at("2026-11-02T00:00:00Z");
  const stored: Array<{ period: string; payload: S.StatementPayload; statement: S.JwsEnvelope }> = [];
  let full = true;
  const persistStatement = (c: (typeof stored)[number]) => {
    if (full) throw new Error("disk full");
    stored.push(c);
  };
  const log = new S.SolidarityLog({ descriptor, key, chain, clock: () => now, persistStatement });
  await assert.rejects(() => log.closePeriod("2026-10", now), /disk full/);
  assert.equal(log.handle("/statements/2026-10").status, 404, "nothing was published");
  full = false;
  const pub = await log.closePeriod("2026-10", now);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].statement.signature, pub.statement.signature);
  assert.equal(stored[0].payload.issuedAt, now);
  // A restart re-adds the stored statement without storing it again, and refuses any other issuedAt.
  const rebuilt = new S.SolidarityLog({ descriptor, key, chain, clock: () => now + 3600, persistStatement: () => assert.fail("stored twice") });
  await assert.rejects(() => rebuilt.closePeriod("2026-10", now + 3600, { signed: pub.statement }), /another payload/);
  assert.equal(JSON.stringify(await rebuilt.closePeriod("2026-10", stored[0].payload.issuedAt, { signed: stored[0].statement })), JSON.stringify(pub));
  // The stored statement alone is enough: its own issuedAt is used, not the clock's.
  const again = new S.SolidarityLog({ descriptor, key, chain, clock: () => now + 7200 });
  assert.equal(JSON.stringify(await again.closePeriod("2026-10", undefined, { signed: stored[0].statement })), JSON.stringify(pub));
});

test("Statements: issuedAt is the time of the first write, for a processor's log too, and a book rebuilt from the stored statement keeps it", () => {
  const descriptor: LogDescriptor = { version: 2, log: "https://processor.example/solidarity", funds: ["https://fund.example/solidarity"], keys: [{ kid: "did:web:processor.example#1", from: "2026-10", until: null }] };
  const key = S.generateSigningKey("EdDSA", descriptor.keys[0].kid);
  const now = at("2026-11-03T09:00:00Z");
  const stored: Array<{ period: string; payload: S.StatementPayload; statement: S.JwsEnvelope }> = [];
  const p = new S.ProcessorHolder({ descriptor, key, clock: () => now, persistStatement: (c) => stored.push(c) });
  const pub = p.closePeriod("2026-10");
  assert.equal(S.decodeStatement(pub.statement).payload.issuedAt, now, "the time it was written, not the start of November");
  assert.equal(stored.length, 1, "stored before it was published");
  assert.equal(stored[0].statement.signature, pub.statement.signature);
  // A book rebuilt a day later from that record: the stored payload, issuedAt included, not a new one.
  const book = new S.LogBook(descriptor, key, { clock: () => now + 86400, persist: () => assert.fail("stored twice") });
  assert.equal(book.close("2026-10", [], undefined, stored[0].statement).statement.signature, pub.statement.signature);
  // A LogBook on its own takes its clock too.
  const plain = new S.LogBook(descriptor, key, { clock: () => now + 7 });
  assert.equal(S.decodeStatement(plain.close("2026-10", []).statement).payload.issuedAt, now + 7);
});

// ---- "Accepted and uncollected shares" -----------------------------------------------------------

/** A log on the simulated chain, and an owner whose agent buys from a seller with an exact share. */
async function world(opts: { now?: number; descriptor?: LogDescriptor; logChain?: (chain: SimulatedChain) => S.LogChain } = {}) {
  const chain = new SimulatedChain({ now: opts.now ?? at("2026-12-10T12:00:00Z") });
  const agent = privateKeyToAccount(generatePrivateKey());
  chain.mint(USDC, agent.address, 1_000_000_000n);
  const descriptor: LogDescriptor = opts.descriptor ?? structuredClone(DESCRIPTOR);
  const key = S.generateSigningKey("EdDSA", descriptor.keys[0].kid);
  descriptor.keys[0] = { ...descriptor.keys[0], jwk: S.publicJwk(key.publicKey) }; // this log's own key, not the conformance one
  const log = new S.SolidarityLog({ descriptor, key, chain: opts.logChain ? opts.logChain(chain) : chain, clock: () => chain.now });
  const counter = new S.CapCounter({ ...POLICY, cap: { ...POLICY.cap, amount: "1000000000" } });
  const req = (amount = "48000000"): PaymentRequirements => ({ scheme: "exact", network: NET, amount, asset: USDC, payTo: "0x2222222222222222222222222222222222222222", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } });
  const payload = (accepted: PaymentRequirements, info: SolidarityInfo): PaymentPayload => ({ x402Version: 2, accepted, payload: {}, extensions: { solidarity: { info, schema: S.solidaritySchema } } });
  const ok = (extra: Partial<SettleResponse> = {}): SettleResponse => ({ success: true, transaction: "0xpurchase", network: NET, payer: agent.address, ...extra });
  /** The agent signs a purchase (valid 60 s) and its exact share (valid 60 s longer). */
  async function share(accepted = req()) {
    const d = await S.buildShare(
      { policy: POLICY, counter, signer: agent, descriptor, now: chain.now },
      { declared: { version: 2, logs: [{ network: NET, scheme: "exact", log: descriptor.log }] }, accepted, purchaseWindow: { validAfter: String(chain.now - 60), validBefore: String(chain.now + 60) } },
    );
    assert.ok(d.attached, d.attached ? "" : d.why);
    const info = (d as Extract<S.ShareDecision, { attached: true }>).info;
    const auth = (info.payment?.payload as unknown as S.ExactEip3009Payload).authorization;
    return { info, id: info.id as string, auth, accepted };
  }
  /** Settle the purchase and hand the share to the log. */
  async function settle(s: Awaited<ReturnType<typeof share>>, response = ok()) {
    return log.onSettled(payload(s.accepted, s.info), s.accepted, response);
  }
  const state = (id: string) => log.inspect(id)?.state;
  const proof = (id: string) => JSON.parse(log.handle(`/proofs/${id}`).body);
  const drain = () => chain.transfer(USDC, agent.address, ELSEWHERE, chain.balanceOf(USDC, agent.address));
  return { chain, agent, log, key, counter, descriptor, req, ok, share, settle, state, proof, drain };
}

/**
 * The log's view of the chain, which can fall behind the chain itself: while
 * `behind`, it finds no transfer and reads every authorization unused. While
 * `lostAnswers`, a submit runs on the chain but its answer is lost.
 */
function laggingView(chain: SimulatedChain) {
  const v = { behind: false, lostAnswers: false, submits: 0 };
  const view: S.LogChain = {
    submitExact: async (a, p) => {
      v.submits++;
      const r = await chain.submitExact(a, p);
      return v.lostAnswers ? { ok: false as const, error: "timeout" } : r;
    },
    channelState: (id) => chain.channelState(id),
    claim: (id, voucher, total) => chain.claim(id, voucher, total),
    findExactTransfer: async (a, p) => (v.behind ? undefined : chain.findExactTransfer(a, p)),
    authorizationUsed: async (a, p) => (v.behind ? false : chain.authorizationUsed(a, p)),
  };
  return { v, view };
}

test("Accepted and uncollected shares: a failed submit leaves an exact share queued; it is uncollected only once validBefore has passed and the authorization reads unused", async () => {
  const w = await world();
  // The agent's balance is gone when the log submits the share.
  const a = await w.share();
  w.drain();
  await (await w.settle(a)).followUp;
  assert.equal(w.state(a.id), "queued", "a failed submit does not show that the transfer never executed");
  assert.deepEqual(w.proof(a.id), { status: "queued" });
  // Looked at again while still valid and unused, it is submitted again, and now it runs.
  w.chain.mint(USDC, w.agent.address, 1_000_000n);
  await w.log.reconcileExact();
  assert.equal(w.state(a.id), "collected");
  assert.equal(w.chain.balanceOf(USDC, FUND_ADDR), 48000n);

  const b = await w.share();
  w.drain();
  await (await w.settle(b)).followUp;
  const validBefore = Number(b.auth.validBefore);
  w.chain.now = validBefore + 29; // passed, but inside the margin for block timestamps that lag the log's clock
  await w.log.reconcileExact();
  assert.equal(w.state(b.id), "queued");
  w.chain.now = validBefore + 30;
  await w.log.reconcileExact();
  assert.equal(w.state(b.id), "uncollected");
  assert.deepEqual(w.proof(b.id), { status: "uncollected" });
});

test("Share kinds: a cancelled share is uncollected once its validBefore has passed and the chain shows the cancellation, so the log can still retire", async () => {
  const w = await world({ descriptor: { ...structuredClone(DESCRIPTOR), keys: [{ ...DESCRIPTOR.keys[0], from: "2026-12" }] } });
  const s = await w.share();
  w.chain.cancelAuthorization(USDC, s.auth.from, s.auth.nonce); // the agent voided it (EIP-3009 cancelAuthorization)
  await (await w.settle(s)).followUp;
  assert.equal(w.state(s.id), "queued", "the submit failed; that alone shows nothing");
  assert.equal(await w.chain.authorizationUsed(s.accepted, s.info.payment?.payload as unknown as S.ExactEip3009Payload), true, "authorizationState reads true for a cancelled authorization");
  w.chain.now = Number(s.auth.validBefore) + 29;
  await w.log.reconcileExact();
  assert.equal(w.state(s.id), "queued", "not before validBefore has passed");
  w.chain.now = Number(s.auth.validBefore) + 30;
  await w.log.reconcileExact();
  assert.equal(w.state(s.id), "uncollected");
  assert.deepEqual(w.proof(s.id), { status: "uncollected" });
  w.chain.now = at("2027-01-03T00:00:00Z");
  assert.equal(S.decodeStatement((await w.log.closePeriod("2026-12")).statement).payload.size, 0, "closed at once: nothing is unresolved");
  assert.equal(w.log.retire(), "2026-12");
});

test("Share kinds: without a way to see the cancellation, a cancelled share is never reported uncollected; its month waits for the claim grace, then closes without it, and the log cannot retire", async () => {
  // The log's chain reads authorizationState (true) but cannot tell a cancellation from a use.
  const w = await world({
    logChain: (c) => ({
      submitExact: (a, p) => c.submitExact(a, p),
      channelState: (id) => c.channelState(id),
      claim: (id, voucher, total) => c.claim(id, voucher, total),
      findExactTransfer: (a, p) => c.findExactTransfer(a, p),
      authorizationUsed: (a, p) => c.authorizationUsed(a, p),
    }),
  });
  const s = await w.share();
  w.chain.cancelAuthorization(USDC, s.auth.from, s.auth.nonce);
  await (await w.settle(s)).followUp;
  w.chain.now = Number(s.auth.validBefore) + 3600;
  await w.log.reconcileExact();
  assert.equal(w.state(s.id), "queued");
  w.chain.now = at("2027-01-03T00:00:00Z");
  await assert.rejects(() => w.log.closePeriod("2026-12"), /a transfer is not final; try again/);
  w.chain.now = at("2027-01-20T00:00:00Z"); // past the 14-day grace
  const st = S.decodeStatement((await w.log.closePeriod("2026-12")).statement).payload;
  assert.equal(st.size, 0);
  assert.equal(w.state(s.id), "queued", "left out, never reported uncollected");
  assert.deepEqual(w.proof(s.id), { status: "queued" });
  assert.throws(() => w.log.retire(), /not resolved/);
});

test("Accepted and uncollected shares: a share reported uncollected whose transfer the log later sees executed is recorded late, in the period in which it sees it", async () => {
  let lag: ReturnType<typeof laggingView> | undefined;
  const w = await world({
    logChain: (c) => {
      lag = laggingView(c);
      return lag.view;
    },
  });
  const v = (lag as ReturnType<typeof laggingView>).v;
  v.behind = true;
  v.lostAnswers = true;
  const s = await w.share();
  await (await w.settle(s)).followUp;
  assert.equal(w.chain.balanceOf(USDC, FUND_ADDR), 48000n, "the transfer ran; only the log's view missed it");
  w.chain.now = Number(s.auth.validBefore) + 30;
  await w.log.reconcileExact();
  assert.equal(w.state(s.id), "uncollected", "its view of the chain was behind");
  w.chain.now = at("2027-01-03T00:00:00Z");
  assert.equal(S.decodeStatement((await w.log.closePeriod("2026-12")).statement).payload.size, 0);

  // In January its view catches up.
  v.behind = false;
  w.chain.now = at("2027-01-05T00:00:00Z");
  await w.log.reconcileExact();
  const rec = w.log.inspect(s.id);
  assert.equal(rec?.state, "collected");
  assert.equal(rec?.period, "2027-01");
  assert.match(rec?.line ?? "", /^solidarity\/2\|2027-01\|/);
  assert.deepEqual(w.proof(s.id), { status: "queued" });
  w.chain.now = at("2027-02-03T00:00:00Z");
  const pub = await w.log.closePeriod("2027-01");
  const jan = S.decodeStatement(pub.statement).payload;
  assert.equal(jan.size, 1);
  assert.deepEqual(jan.totals.map((t) => t.amount), ["48000"], "the amount it accepted");
  assert.equal(w.proof(s.id).status, "included");
  assert.equal(w.proof(s.id).period, "2027-01");
  const settlements = w.log.handle("/settlements/2027-01").body;
  assert.match(settlements, new RegExp(`\\|exact:${rec?.exact?.transaction}\\|48000\\n$`));
  // The fund attests it: that transfer reached it.
  const fund = new S.FundCosigner({ fund: FUND, key: S.generateSigningKey("EdDSA", "did:web:fund.example#1"), view: w.chain.fundView() });
  fund.cosign(pub, settlements, { resolveKey: S.staticResolver({ [w.key.kid]: w.key.publicKey }) });
});

test("Accepted and uncollected shares: closing a month never submits a share again while its own submit is still running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let submits = 0;
  const w = await world({
    now: at("2026-12-31T23:59:00Z"),
    logChain: (c) => ({
      submitExact: async (a, p) => {
        submits++;
        await gate;
        return c.submitExact(a, p);
      },
      channelState: (id) => c.channelState(id),
      claim: (id, voucher, total) => c.claim(id, voucher, total),
      findExactTransfer: (a, p) => c.findExactTransfer(a, p),
      authorizationUsed: (a, p) => c.authorizationUsed(a, p),
    }),
  });
  const s = await w.share();
  const r = await w.settle(s);
  w.chain.now = at("2027-01-01T00:00:10Z"); // the share is valid until 00:01:00
  await assert.rejects(() => w.log.closePeriod("2026-12"), /try again/);
  assert.equal(submits, 1, "no second submit beside the first");
  release();
  await r.followUp;
  assert.equal(w.state(s.id), "collected");
  assert.equal(S.decodeStatement((await w.log.closePeriod("2026-12")).statement).payload.size, 1);
});

test("Purchases that can carry a share: a share held while its purchase is settlement_pending falls in the month the purchase confirms", async () => {
  const w = await world({ now: at("2026-12-31T23:59:00Z") });
  const s = await w.share();
  const r = await w.settle(s, { success: false, errorReason: "settlement_pending", transaction: "0xheld", network: NET });
  assert.equal(r.outcome?.status, "pending");
  assert.deepEqual(w.proof(s.id), { status: "pending" });
  w.chain.now = at("2027-01-01T00:00:30Z");
  const res = await w.log.resolvePending("0xheld", true);
  assert.equal(res?.outcome.status, "accepted");
  assert.equal(res?.outcome.period, "2027-01");
  await res?.followUp;
  w.chain.now = at("2027-02-03T00:00:00Z");
  assert.equal(S.decodeStatement((await w.log.closePeriod("2026-12")).statement).payload.size, 0);
  assert.equal(S.decodeStatement((await w.log.closePeriod("2027-01")).statement).payload.size, 1);
});

test("Facilitator behaviour: a lost settle response may be rebuilt from the chain, and every check still applies", async () => {
  const w = await world();
  // The response was lost; the chain shows the purchase collected ten minutes later, after the share expired.
  const late = await w.share();
  w.chain.now += 600;
  const r1 = await w.settle(late, w.ok({ transaction: "0xseenonchain", amount: late.accepted.amount }));
  assert.deepEqual([r1.outcome?.status, r1.outcome?.reason], ["skipped", "bad-payment"]);
  // Seen collected in time: processed as if the settle had just succeeded, and the buyer reads the outcome from /proofs.
  const s = await w.share();
  w.chain.now += 10;
  const r2 = await w.settle(s, w.ok({ transaction: "0xseenonchain2", amount: s.accepted.amount }));
  assert.equal(r2.outcome?.status, "accepted");
  await r2.followUp;
  assert.deepEqual(w.proof(s.id), { status: "queued" });
  assert.equal(w.state(s.id), "collected");
});

// ---- "Retiring a log" ----------------------------------------------------------------------------

test("Retiring a log: stop accepting shares, resolve every one, publish the final statement, then set until", async () => {
  const descriptor: LogDescriptor = { ...structuredClone(DESCRIPTOR), keys: [{ ...DESCRIPTOR.keys[0], from: "2026-12" }] };
  const w = await world({ descriptor });
  const resolve = S.staticResolver({ [w.key.kid]: w.key.publicKey, [witnessKey.kid]: witnessKey.publicKey });
  const a = await w.share();
  await (await w.settle(a)).followUp;
  const held = await w.share();
  assert.equal((await w.settle(held, { success: false, errorReason: "settlement_pending", transaction: "0xheld", network: NET })).outcome?.status, "pending");

  // Step 1: no more shares. A purchase's response passes through with no outcome.
  w.log.stopAccepting();
  assert.equal(w.log.accepting, false);
  const after = await w.share();
  const sr = w.ok();
  const passed = await w.settle(after, sr);
  assert.equal(passed.outcome, undefined);
  assert.equal(passed.settleResponse, sr);
  assert.equal(w.log.inspect(after.id), undefined);

  // Step 2: every share resolved, and a statement for every period with one.
  assert.throws(() => w.log.retire(), /settlement_pending/);
  const res = await w.log.resolvePending("0xheld", true);
  assert.equal(res?.outcome.status, "accepted", "a share held before the log stopped is still processed");
  await res?.followUp;
  assert.throws(() => w.log.retire(), /published none/);
  w.chain.now = at("2027-01-03T00:00:00Z");
  const pub = await w.log.closePeriod("2026-12");

  // Step 3 waits for the cosignatures the log expects; a refusal changes nothing.
  assert.throws(() => w.log.retire({ requireCosigners: [witnessKey.kid], resolveKey: resolve }), /no valid cosignature by/);
  assert.equal(S.isRetired(w.descriptor), false);
  w.log.addCosignature("2026-12", new S.Witness(witnessKey).cosign(pub, { resolveKey: resolve, descriptor: w.descriptor }));
  assert.equal(w.log.retire({ requireCosigners: [witnessKey.kid], resolveKey: resolve }), "2026-12");

  // A descriptor with no current key: a retired log, whose final statement is for 2026-12.
  const d: LogDescriptor = JSON.parse(w.log.handle("").body);
  assert.equal(d.keys[0].until, "2026-12");
  assert.equal(S.isRetired(d), true);
  assert.equal(S.finalPeriod(d), "2026-12");
  assert.equal(w.log.retired, true);
  w.chain.now = at("2027-02-03T00:00:00Z");
  await assert.rejects(() => w.log.closePeriod("2027-01"), /retired/);
  assert.throws(() => w.log.retire(), /already retired/);
  // The key is now retired: its statements verify only with a cosignature the verifier requires.
  const published: PublishedStatement = JSON.parse(w.log.handle("/statements/2026-12").body);
  assert.match(S.verifyStatement(published, { resolveKey: resolve, descriptor: d }).problems.join(" "), /retired/);
  assert.equal(S.verifyStatement(published, { resolveKey: resolve, descriptor: d, requireCosigners: [witnessKey.kid] }).ok, true);
  assert.equal(S.verifyReceipt(w.log.receipt(a.id) as S.Receipt, { resolveKey: resolve, descriptor: d, requireCosigners: [witnessKey.kid] }).ok, true);
  assert.deepEqual(S.verifyChain([published], { complete: d }), { ok: true, problems: [] });
  // A later statement, were one signed, is for a period no key is listed for.
  const later = S.signStatement({ ...S.decodeStatement(published.statement).payload, period: "2027-01", previous: S.decodeStatement(published.statement).hash, size: 0, root: S.EMPTY_ROOT_HEX, totals: [], settlements: S.sha256Hex("") }, w.key);
  assert.match(S.verifyStatement(later, { resolveKey: resolve, descriptor: d, requireCosigners: [witnessKey.kid] }).problems.join(" "), /not listed for 2027-01/);
  assert.match(S.verifyChain([published, later], { complete: d }).problems.join(" "), /retired with 2026-12 as its final statement/);
});

test("Retiring a log: retire() that refuses changes nothing; the log still accepts shares", async () => {
  const w = await world({ descriptor: { ...structuredClone(DESCRIPTOR), keys: [{ ...DESCRIPTOR.keys[0], from: "2026-12" }] } });
  assert.throws(() => w.log.retire(), /published none/);
  assert.equal(w.log.accepting, true);
  const s = await w.share();
  assert.equal((await w.settle(s)).outcome?.status, "accepted");
  const p = new S.ProcessorHolder({ descriptor: { version: 2, log: "https://processor.example/solidarity", funds: ["https://fund.example/solidarity"], keys: [{ kid: "did:web:processor.example#1", from: "2026-10", until: null }] }, key: S.generateSigningKey("EdDSA", "did:web:processor.example#1"), clock: () => at("2026-10-10T00:00:00Z") });
  p.addOwner("owner-1", { version: 2, rate: "0.01", cap: { amount: "100000", asset: "USD" }, fund: "https://fund.example/solidarity", refunds: "keep", since: "2026-10-01T00:00:00Z" });
  assert.throws(() => p.retire(), /published none/);
  assert.equal(typeof p.recordPurchase({ owner: "owner-1", purchaseId: "p1", amount: "20000", asset: "USD" }), "string");
});

test("Retiring a log: a retired log records nothing after its final statement, even a transfer its lagging view finds late", async () => {
  let lag: ReturnType<typeof laggingView> | undefined;
  const descriptor: LogDescriptor = { ...structuredClone(DESCRIPTOR), keys: [{ ...DESCRIPTOR.keys[0], from: "2026-12" }] };
  const w = await world({
    descriptor,
    logChain: (c) => {
      lag = laggingView(c);
      return lag.view;
    },
  });
  const v = (lag as ReturnType<typeof laggingView>).v;
  v.behind = true;
  v.lostAnswers = true;
  const s = await w.share();
  await (await w.settle(s)).followUp;
  w.chain.now = Number(s.auth.validBefore) + 30;
  await w.log.reconcileExact();
  assert.equal(w.state(s.id), "uncollected");
  w.chain.now = at("2027-01-03T00:00:00Z");
  await w.log.closePeriod("2026-12");
  assert.equal(w.log.retire(), "2026-12");
  // Its view catches up after it retired: it has no period left to record the share in.
  v.behind = false;
  await w.log.reconcileExact();
  assert.equal(w.state(s.id), "uncollected");
  assert.deepEqual(w.proof(s.id), { status: "uncollected" });
  assert.throws(() => w.log.book.addSettlement("2027-01", "x"), /retired: its final statement is for 2026-12/);
  assert.throws(() => w.log.book.markActive("2027-01"), /retired/);
});

test("Retiring a log: a processor's log retires the same way; shares still below minCollection are uncollected", () => {
  const descriptor: LogDescriptor = { version: 2, log: "https://processor.example/solidarity", funds: ["https://fund.example/solidarity"], minCollection: "100", keys: [{ kid: "did:web:processor.example#1", from: "2026-10", until: null }] };
  const clock = { now: at("2026-10-10T00:00:00Z") };
  const key = S.generateSigningKey("EdDSA", descriptor.keys[0].kid);
  const p = new S.ProcessorHolder({ descriptor, key, clock: () => clock.now });
  p.addOwner("owner-1", { version: 2, rate: "0.01", cap: { amount: "100000", asset: "USD" }, fund: "https://fund.example/solidarity", refunds: "keep", since: "2026-10-01T00:00:00Z" });
  const big = p.recordPurchase({ owner: "owner-1", purchaseId: "p1", amount: "20000", asset: "USD" }) as string;
  p.collect();
  p.addOwner("owner-2", { version: 2, rate: "0.01", cap: { amount: "100000", asset: "USD" }, fund: "https://fund.example/solidarity", refunds: "keep", since: "2026-10-01T00:00:00Z" });
  const small = p.recordPurchase({ owner: "owner-2", purchaseId: "p2", amount: "4000", asset: "USD" }) as string; // 40 cents, below minCollection
  assert.deepEqual(p.collect().carried, [small]);
  p.stopAccepting();
  assert.equal(p.recordPurchase({ owner: "owner-1", purchaseId: "p4", amount: "20000", asset: "USD" }), undefined, "step 1: no more shares");
  assert.throws(() => p.retire(), /published none/);
  clock.now = at("2026-11-02T00:00:00Z");
  const pub = p.closePeriod("2026-10");
  // Step 3 waits for the witness the processor expects.
  const resolve = S.staticResolver({ [key.kid]: key.publicKey, [witnessKey.kid]: witnessKey.publicKey });
  const expect = { requireCosigners: [witnessKey.kid], resolveKey: resolve };
  assert.throws(() => p.retire(expect), /no valid cosignature by/);
  assert.equal(descriptor.keys[0].until, null);
  const closed = p.book.get("2026-10") as NonNullable<ReturnType<typeof p.book.get>>;
  p.book.addCosignature("2026-10", new S.Witness(witnessKey).cosign(pub, { resolveKey: resolve, descriptor, files: { lines: closed.lines, settlements: closed.settlements } }));
  assert.equal(p.retire(expect), "2026-10");
  assert.equal(descriptor.keys[0].until, "2026-10");
  assert.equal(p.recordPurchase({ owner: "owner-1", purchaseId: "p3", amount: "20000", asset: "USD" }), undefined, "it records no more shares");
  assert.equal(JSON.parse(p.handle(`/proofs/${big}`).body).status, "included");
  assert.deepEqual(JSON.parse(p.handle(`/proofs/${small}`).body), { status: "uncollected" });
  clock.now = at("2026-12-02T00:00:00Z");
  assert.throws(() => p.closePeriod("2026-11"), /retired/);
});
