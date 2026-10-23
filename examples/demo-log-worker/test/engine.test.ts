/**
 * The demo log, offline: the engine over memory and the repository's
 * simulated chain, with a simulated clock. No network, no wrangler.
 * SIMULATED: no real or test tokens move.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import * as S from "../../../src/solidarity/index.ts";
import type { PublishedStatement, Receipt } from "../../../src/solidarity/index.ts";
import { ROOT, siteFile } from "../../../test/helpers.ts";
import { ASSET, briefError, configFromEnv, DEFAULT_FACILITATOR, endBoundary, Engine, FUND, FUND_ADDRESS, usdc } from "../engine.ts";
import { exactRefs, fundCheckOf, transferToFund } from "../fundView.ts";
import { LiveIO, SimWorld, USDC } from "../io.ts";
import type { ReceiptFacts } from "../io.ts";
import { renderPage } from "../page.ts";
import { MemoryStore, SqlStore } from "../store.ts";
import { at, collected, HOUR, invariants, published, restart, rig, runUntil, tickAfter } from "./harness.ts";
import type { Rig } from "./harness.ts";

const DIR = join(ROOT, "examples/demo-log-worker");

// One simulated run shared by the first tests: 2026-10-23 to 2026-12-02, a tick every 6 hours.
let shared: Promise<{ r: Rig; reports: Awaited<ReturnType<typeof runUntil>>; ms: number }> | undefined;
const run = () =>
  (shared ??= (async () => {
    const r = await rig({ start: at("2026-10-23T00:00:00Z"), persistWorld: true });
    assert.equal(r.engine.degraded, undefined, r.engine.degraded);
    const t0 = performance.now();
    const reports = await runUntil(r, at("2026-12-02T00:00:00Z"));
    return { r, reports, ms: performance.now() - t0 };
  })());

const statements = (r: Rig): PublishedStatement[] => ["2026-10", "2026-11"].map((p) => JSON.parse(r.engine.serve(`/statements/${p}`).body));

test("simulated run across two month ends: every share collected, both months closed and cosigned by the witness and the fund", async () => {
  const { r, reports } = await run();
  const cycles = reports.map((x) => x.cycle);
  assert.equal(cycles.length, 160);
  assert.ok(cycles.every((c) => c?.ran && collected(c)), "every cycle collected its share");
  assert.deepEqual(invariants(r), []);
  assert.ok(reports.some((x) => x.maintained.includes("closed 2026-10")));
  assert.ok(reports.some((x) => x.maintained.includes("closed 2026-11")));

  const e = r.engine;
  const k = e.keys as NonNullable<typeof e.keys>;
  const resolveKey = S.staticResolver({ [k.log.kid]: k.log.publicKey, [k.witness.kid]: k.witness.publicKey, [k.fund.kid]: k.fund.publicKey });
  const pubs = statements(r);
  let fundTotal = 0n;
  for (const pub of pubs) {
    const v = S.verifyStatement(pub, { resolveKey, descriptor: e.descriptor, requireCosigners: [k.witness.kid, k.fund.kid] });
    assert.equal(v.ok, true, v.problems.join("; "));
    const p = v.payload as S.StatementPayload;
    const lines = e.serve(`/lines/${p.period}`).body;
    const settlements = e.serve(`/settlements/${p.period}`).body;
    const b = S.buildBatch(S.parseFileBody(lines));
    assert.equal(b.root, p.root);
    assert.equal(S.settlementsMatchTotals(S.parseFileBody(settlements), p.totals), true);
    for (const t of p.totals) fundTotal += BigInt(t.amount);
    // Every settlement reference is a transfer on the simulated chain, to the fund, of the listed amount.
    for (const s of S.parseFileBody(settlements).map(S.parseSettlement)) {
      const tx = s.ref.slice("exact:".length);
      const t = r.world.chain.fundView().exactTransfer(tx);
      assert.ok(t && t.to.toLowerCase() === FUND_ADDRESS && t.value === BigInt(s.amount), s.ref);
    }
  }
  assert.equal(S.verifyChain(pubs).ok, true);
  assert.equal(S.decodeStatement(pubs[0].statement).payload.previous, null, "the first month has no previous");
  // October: Oct 23 06:00 to Oct 31 18:00 is 35 ticks. November: 30 days of 4 ticks.
  assert.equal(S.decodeStatement(pubs[0].statement).payload.size, 35);
  assert.equal(S.decodeStatement(pubs[1].statement).payload.size, 120);
  // The fund address received exactly the totals of the cosigned months (December's shares are not in a statement yet).
  const decShares = cycles.filter((c) => c?.summary?.period === "2026-12").length;
  assert.equal(r.world.chain.balanceOf(USDC, FUND_ADDRESS), fundTotal + BigInt(decShares) * 1000n);

  for (const c of r.store.events().filter((x) => x.kind === "cycle" && x.body.share.period !== "2026-12")) {
    const rc = e.receipt(c.body.share.id) as Receipt;
    const v = S.verifyReceipt(rc, { resolveKey, descriptor: e.descriptor, requireCosigners: [k.witness.kid, k.fund.kid] });
    assert.equal(v.ok, true, `${c.body.share.id}: ${v.problems.join("; ")}`);
  }
  // December's shares are queued until December closes.
  const dec = r.store.events().find((x) => x.kind === "cycle" && x.body.share.period === "2026-12");
  assert.equal(JSON.parse(e.serve(`/proofs/${dec?.body.share.id}`).body).status, "queued");
  assert.equal(e.serve("/statements/2026-12").status, 404);
});

test("the descriptor, did:web documents and the policy say what the log is", async () => {
  const { r } = await run();
  const e = r.engine;
  const d = JSON.parse(e.serve("").body);
  assert.equal(d.log, "https://demo.example/solidarity");
  assert.deepEqual(d.funds, [FUND]);
  assert.deepEqual(d.accepts, [{ network: "eip155:84532", asset: ASSET, scheme: "exact", maxTimeoutSeconds: 300, minAmount: "1000", extra: { name: "USDC", version: "2" } }]);
  assert.deepEqual(d.witnesses, ["did:web:demo.example:witness"]);
  assert.equal(d.keys[0].kid, "did:web:demo.example#log-1");
  assert.equal(d.keys[0].from, "2026-10");
  const doc = e.didDocument("log") as { id: string; verificationMethod: Array<{ id: string; publicKeyJwk: unknown }>; assertionMethod: string[] };
  assert.equal(doc.id, "did:web:demo.example");
  assert.deepEqual(doc.verificationMethod[0].publicKeyJwk, d.keys[0].jwk, "the did:web key is the descriptor's key");
  assert.deepEqual(doc.assertionMethod, [d.keys[0].kid]);
  const w = e.didDocument("witness") as typeof doc;
  const f = e.didDocument("fund") as typeof doc;
  assert.equal(w.verificationMethod[0].id, e.keys?.witness.kid);
  assert.equal(f.verificationMethod[0].id, e.keys?.fund.kid);
  assert.equal((f.verificationMethod[0].publicKeyJwk as { crv: string }).crv, "P-256");
  // Keys verify the cosignatures on the published statement.
  const pub = statements(r)[0];
  const byKid = (kid: string) => S.publicKeyFromJwk((kid === w.verificationMethod[0].id ? w : f).verificationMethod[0].publicKeyJwk as S.PublicJwk);
  for (const c of pub.cosignatures) assert.equal(S.jwsVerify(c.signature, byKid(S.jwsDecode(c.signature).header.kid) as NonNullable<ReturnType<typeof byKid>>), true);
  // The owner's policy is the one the task set: 0.1%, 5 USDC a month, refunds keep.
  assert.deepEqual({ rate: e.policy?.rate, cap: e.policy?.cap, refunds: e.policy?.refunds }, { rate: "0.001", cap: { amount: "5000000", asset: ASSET }, refunds: "keep" });
  assert.deepEqual(S.policyProblems(e.policy as S.OwnerPolicy, "separate"), []);
});

test("a restart replays to byte-identical published files, with no chain call and no private key read", async () => {
  const { r, ms } = await run();
  const before = published(r);
  const n = r.store.events().filter((x) => x.kind === "cycle").length;
  const t0 = performance.now();
  const r2 = await restart(r);
  const replayMs = performance.now() - t0;
  assert.equal(r2.engine.degraded, undefined, r2.engine.degraded);
  assert.equal(r2.blockedCalls, 0, "replay called the chain");
  assert.equal(r2.keys.reads, 0, "replay read a private key");
  const after = published(r2);
  assert.deepEqual([...after.keys()], [...before.keys()]);
  for (const [path, body] of before) assert.equal(after.get(path), body, `${path} changed across the restart`);
  // The fund's ES256 cosignatures are randomized: identical bytes mean the stored JWS was re-added.
  const fundSig = (x: Map<string, string>) => (JSON.parse((x.get("/solidarity/statements/2026-11") as string).split("\n")[1]) as PublishedStatement).cosignatures[1].signature;
  assert.equal(fundSig(after), fundSig(before));
  assert.equal(S.jwsDecode(fundSig(after)).header.alg, "ES256");
  const perCycle = replayMs / n;
  console.log(`# replay of ${n} cycles took ${replayMs.toFixed(0)} ms (${perCycle.toFixed(1)} ms each; about 640 cycles to END_DATE would take ${((perCycle * 640) / 1000).toFixed(1)} s); the live run took ${ms.toFixed(0)} ms`);
  assert.ok(perCycle * 700 < 30000 / 2, "700 cycles replay well inside the 30 s blockConcurrencyWhile limit");

  // The simulated chain rebuilt from its recorded ops is the same chain.
  const world2 = await SimWorld.fromOps(r.store.simOps(), r.world.now);
  assert.equal(world2.chain.balanceOf(USDC, FUND_ADDRESS), r.world.chain.balanceOf(USDC, FUND_ADDRESS));
  assert.deepEqual([...world2.receipts.keys()], [...r.world.receipts.keys()]);

  // And the log carries on: more cycles, then December closes, chained to November.
  const r3 = await restart(r2, { world: world2 });
  const more = await runUntil(r3, at("2027-01-01T06:00:00Z"));
  assert.ok(more.every((x) => collected(x.cycle)));
  assert.ok(more.some((x) => x.maintained.includes("closed 2026-12")));
  // Everything published before stays as it was; only December's queued shares are now included.
  const after3 = published(r3);
  let moved = 0;
  for (const [path, body] of before) {
    if (body.endsWith('{"status":"queued"}') || body === "null") {
      moved++;
      continue;
    }
    assert.equal(after3.get(path), body, `${path} changed after the log carried on`);
  }
  assert.equal(moved, 10, "December's 5 shares: their proofs and receipts");
  const dec = JSON.parse(r3.engine.serve("/statements/2026-12").body) as PublishedStatement;
  assert.equal(S.verifyChain([...statements(r3), dec]).ok, true);
  assert.deepEqual(invariants(r3), []);
});

test("the site's verify.py and merkle.js accept the published months, the chain and the receipts", { skip: (!siteFile("verify.py") || !siteFile("merkle.js")) && "site verify.py or merkle.js not found: set SOLIDARITY_SITE_DIR (README, \"Run it\")" }, async () => {
  const { r } = await run();
  const e = r.engine;
  const dir = mkdtempSync(join(tmpdir(), "demo-log-"));
  try {
    for (const p of ["2026-10", "2026-11"]) {
      writeFileSync(join(dir, `${p}.lines`), e.serve(`/lines/${p}`).body);
      writeFileSync(join(dir, `${p}.settlements`), e.serve(`/settlements/${p}`).body);
      writeFileSync(join(dir, `s-${p}.json`), e.serve(`/statements/${p}`).body);
    }
    const py = (...args: string[]) => spawnSync("python3", ["-I", siteFile("verify.py") as string, ...args], { cwd: dir, encoding: "utf8" });
    for (const p of ["2026-10", "2026-11"]) {
      const v = py("--lines", `${p}.lines`, "--statement", `s-${p}.json`, "--settlements", `${p}.settlements`);
      assert.equal(v.status, 0, v.stdout + v.stderr);
      assert.match(v.stdout, /statement root, size and totals match/);
      assert.match(v.stdout, /settlements file hash and sums match/);
    }
    const chain = py("--chain", "s-2026-10.json", "s-2026-11.json");
    assert.equal(chain.status, 0, chain.stdout);
    assert.match(chain.stdout, /2026-11: chains to the previous statement/);
    const keyHex = S.ed25519PublicKeyHex((e.keys as NonNullable<typeof e.keys>).log.publicKey);
    const ids = r.store.events().filter((x) => x.kind === "cycle" && ["2026-10", "2026-11"].includes(x.body.share.period)).map((x) => x.body.share.id as string);
    for (const id of [ids[0], ids.at(-1) as string]) {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(e.receipt(id)));
      const v = py(`${id}.json`, "--key", keyHex);
      assert.equal(v.status, 0, v.stdout + v.stderr);
      assert.match(v.stdout, /included in https:\/\/demo\.example\/solidarity 2026-1[01]/);
    }
    // A tampered statement is refused.
    const bad = py("--chain", "s-2026-11.json", "s-2026-10.json");
    assert.notEqual(bad.status, 0);

    const site = await import(pathToFileURL(siteFile("merkle.js") as string).href);
    const logKey = await crypto.subtle.importKey("raw", Buffer.from(keyHex, "hex"), { name: "Ed25519" }, false, ["verify"]);
    for (const p of ["2026-10", "2026-11"]) {
      const payload = S.decodeStatement((JSON.parse(e.serve(`/statements/${p}`).body) as PublishedStatement).statement).payload;
      const b = await site.buildBatch(e.serve(`/lines/${p}`).body.split("\n").filter(Boolean));
      assert.equal(b.root, payload.root);
      assert.deepEqual(b.totals, payload.totals);
      assert.equal(await site.statementHash(payload), S.statementHash(payload));
    }
    for (const id of [ids[0], ids[40]]) {
      const v = await site.verifyReceipt(e.receipt(id), { logKey });
      assert.equal(v.ok, true, id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fund refuses a transfer that does not match, and the statement stands with the witness's cosignature only", async () => {
  const r = await rig({ start: at("2026-10-30T00:00:00Z") });
  await runUntil(r, at("2026-10-31T18:00:00Z"));
  // Rewrite one share's receipt on the simulated chain: its Transfer now says 999 units.
  const cyc = r.store.events().filter((x) => x.kind === "cycle")[2];
  const tx = r.engine.log?.inspect(cyc.body.share.id)?.exact?.transaction as string;
  const rc = r.world.receipts.get(tx) as ReceiptFacts;
  r.world.receipts.set(tx, { ...rc, logs: [{ ...rc.logs[0], data: `0x${(999).toString(16).padStart(64, "0")}` }] });
  const t = await tickAfter(r, 6 * HOUR); // 2026-11-01T00:00Z closes October
  assert.ok(t.maintained.includes("closed 2026-10"));
  const refused = r.store.get("fund-refused", "2026-10");
  assert.equal(refused?.body.definitive, true);
  assert.match(refused?.body.reason, /fund refuses: exact:0x[0-9a-f]{64} is not a transfer of 1000 to the fund/);
  const pub = JSON.parse(r.engine.serve("/statements/2026-10").body) as PublishedStatement;
  assert.equal(pub.cosignatures.length, 1);
  const k = r.engine.keys as NonNullable<typeof r.engine.keys>;
  const resolveKey = S.staticResolver({ [k.log.kid]: k.log.publicKey, [k.witness.kid]: k.witness.publicKey, [k.fund.kid]: k.fund.publicKey });
  assert.equal(S.verifyStatement(pub, { resolveKey, descriptor: r.engine.descriptor, requireCosigners: [k.witness.kid] }).ok, true);
  assert.equal(S.verifyStatement(pub, { resolveKey, descriptor: r.engine.descriptor, requireCosigners: [k.witness.kid, k.fund.kid] }).ok, false);
  // The refusal is final and the page says so.
  await tickAfter(r, 6 * HOUR);
  assert.equal(r.store.get("cosign", "2026-10:fund"), undefined);
  const html = renderPage(r.engine.snapshot());
  assert.match(html, /the demo fund did not cosign it/);
  assert.match(html, /is not a transfer of 1000 to the fund/);
  // And it survives a restart byte for byte.
  const before = published(r);
  const r2 = await restart(r);
  for (const [path, body] of before) assert.equal(published(r2).get(path), body, path);
});

test("an RPC endpoint that is down defers the fund's cosignature; after 14 days it gives up and says so", async () => {
  let down = false;
  const r = await rig({ start: at("2026-10-30T12:00:00Z"), hooks: { rpcDown: () => down } });
  await runUntil(r, at("2026-10-31T18:00:00Z"));
  down = true;
  const t = await tickAfter(r, 6 * HOUR);
  assert.ok(t.maintained.includes("closed 2026-10"), "closing needs no RPC");
  assert.match(t.cycle?.stop ?? "", /RPC endpoint did not answer/);
  assert.ok(r.store.get("cosign", "2026-10:witness"));
  assert.equal(r.store.get("cosign", "2026-10:fund"), undefined);
  assert.equal(r.store.get("fund-refused", "2026-10"), undefined, "not yet: it retries");
  down = false;
  const t2 = await tickAfter(r, 6 * HOUR);
  assert.ok(t2.maintained.includes("fund cosigned 2026-10"));
  assert.ok(collected(t2.cycle));

  // November: the RPC stays down past the 14-day deadline.
  await runUntil(r, at("2026-11-30T18:00:00Z"), 24 * HOUR);
  down = true;
  await runUntil(r, at("2026-12-14T23:00:00Z"), 24 * HOUR);
  assert.ok(r.store.get("close", "2026-11"));
  assert.equal(r.store.get("fund-refused", "2026-11"), undefined);
  await tickAfter(r, 19 * HOUR); // 2026-12-15T01:00Z
  const refused = r.store.get("fund-refused", "2026-11");
  assert.equal(refused?.body.definitive, false);
  assert.match(refused?.body.reason, /could not be checked on the simulated chain before 2026-12-15/);
  assert.match(renderPage(r.engine.snapshot()), /could not be checked on the simulated chain before 2026-12-15/);
});

test("stop conditions are checked before anything is signed", async (t) => {
  await t.test("PAUSED=1: no purchase, no chain call, no key read; recorded work and closes still run", async () => {
    const r = await rig({ start: at("2026-10-31T12:00:00Z"), config: { paused: true } });
    const calls = r.io.calls.length;
    const reads = r.keys.reads;
    const t1 = await tickAfter(r, 6 * HOUR);
    assert.equal(t1.cycle?.ran, false);
    assert.match(t1.cycle?.stop ?? "", /paused/);
    assert.equal(r.io.calls.length, calls);
    assert.equal(r.keys.reads, reads);
    const t2 = await tickAfter(r, 6 * HOUR); // 2026-11-01
    assert.ok(t2.maintained.includes("closed 2026-10"));
    assert.ok(r.store.get("cosign", "2026-10:witness") && r.store.get("cosign", "2026-10:fund"));
    assert.equal(r.store.events().filter((x) => x.kind === "cycle").length, 0);
  });

  await t.test("after END_DATE: no purchase; the last month closes, and the log retires with it as its final statement", async () => {
    const r = await rig({ start: at("2026-10-31T00:00:00Z"), config: { endDate: "2026-10-31" } });
    const a = await tickAfter(r, 6 * HOUR);
    assert.ok(collected(a.cycle), "on END_DATE itself it still runs");
    await runUntil(r, at("2026-10-31T18:00:00Z"));
    const b = await tickAfter(r, 6 * HOUR);
    assert.deepEqual(b.maintained, ["closed 2026-10", "retired: the final statement is for 2026-10"]);
    assert.match(b.cycle?.stop ?? "", /^retired: the log's final statement is for 2026-10$/);
    assert.ok(r.store.get("cosign", "2026-10:witness") && r.store.get("cosign", "2026-10:fund"), "retired only once both cosignatures were attached");
    assert.deepEqual(r.store.get("retire", "2026-10")?.body, { period: "2026-10" });
    const descriptor = JSON.parse(r.engine.serve("").body);
    assert.equal(descriptor.keys[0].until, "2026-10");
    assert.equal(S.finalPeriod(descriptor), "2026-10");
    const snap = r.engine.snapshot();
    assert.deepEqual([snap.state, snap.finalPeriod], ["retired", "2026-10"]);
    assert.match(renderPage(snap), /Retired\./);
    // Its statement now verifies with the retired key's JWK and a required cosignature; receipts too.
    const resolveKey = S.staticResolver({ [snap.kids?.witness as string]: (r.engine.keys as NonNullable<typeof r.engine.keys>).witness.publicKey });
    const oct = JSON.parse(r.engine.serve("/statements/2026-10").body);
    assert.ok(S.verifyStatement(oct, { resolveKey, descriptor, requireCosigners: [snap.kids?.witness as string] }).ok);
    assert.deepEqual(S.verifyChain([oct], { complete: descriptor }), { ok: true, problems: [] });
    // A restart replays the retirement; a month later nothing closes, and everything is still served.
    const before = published(r);
    const r2 = await restart(r);
    assert.equal(r2.engine.degraded, undefined, r2.engine.degraded);
    assert.equal(r2.blockedCalls, 0);
    assert.deepEqual(published(r2), before);
    r2.io.advance(31 * 86400);
    const c = await r2.engine.tick();
    assert.deepEqual(c.maintained, []);
    assert.match(c.cycle?.stop ?? "", /^retired/);
    assert.equal(r2.store.get("close-intent", "2026-11"), undefined);
    assert.equal(r2.engine.serve("/statements/2026-10").status, 200);
    assert.equal(endBoundary("2027-02-30"), undefined);
    const bad = await rig({ config: { endDate: "2027-02-30" } });
    assert.match((await tickAfter(bad, HOUR)).cycle?.stop ?? "", /END_DATE 2027-02-30 is not a YYYY-MM-DD date/);
  });

  await t.test("the payer's balance below 2 USDC: only reads", async () => {
    const r = await rig();
    const payer = r.engine.genesis?.payer as string;
    r.world.chain.transfer(USDC, payer, "0x000000000000000000000000000000000000dead", 18_500_000n);
    const calls = r.io.calls.length;
    const t1 = await tickAfter(r, HOUR);
    assert.match(t1.cycle?.stop ?? "", /holds 1\.5 USDC, below 2 USDC/);
    assert.deepEqual(r.io.calls.slice(calls), ["chainId", "balanceOf"]);
    assert.equal(r.store.events().filter((x) => x.kind === "cycle").length, 0);
  });

  await t.test("an RPC endpoint on another chain", async () => {
    const r = await rig();
    r.io.chainIdValue = 1;
    const t1 = await tickAfter(r, HOUR);
    assert.match(t1.cycle?.stop ?? "", /reports chain 1, not Base Sepolia/);
    assert.ok(!r.io.calls.includes("settle"));
  });

  await t.test("live mode: PAYER_KEY missing, malformed or not the payer's", async () => {
    const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
    const good = generatePrivateKey();
    const address = privateKeyToAccount(good).address;
    let key: string | undefined;
    const r = await rig({ config: { mode: "live", payerAddress: address }, payerKey: () => key });
    assert.equal(r.engine.degraded, undefined, r.engine.degraded);
    r.world.mint(address, 20_000_000n);
    assert.match((await tickAfter(r, HOUR)).cycle?.stop ?? "", /PAYER_KEY is not set/);
    // The headline says so: it does not claim purchases are running.
    const waiting = r.engine.snapshot();
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.waiting, "PAYER_KEY is not set");
    const html = renderPage(waiting);
    assert.match(html, /<strong>No purchases\.<\/strong> The last tick, at [^,]+, started no purchase: PAYER_KEY is not set\./);
    assert.ok(!/<strong>Running\.<\/strong>/.test(html));
    key = "0x1234";
    assert.match((await tickAfter(r, HOUR)).cycle?.stop ?? "", /PAYER_KEY must be 0x followed by 64 hex digits/);
    // 64 hex digits that are not a secp256k1 key (zero, or at or above the curve order): a clean stop,
    // and the value never reaches the status, the page or the failure count.
    for (const bad of [`0x${"00".repeat(32)}`, `0x${"ff".repeat(32)}`, "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"]) {
      key = bad;
      const t1 = await tickAfter(r, HOUR);
      assert.equal(t1.cycle?.stop, "PAYER_KEY is not a valid secp256k1 private key");
      const out = JSON.stringify(r.engine.snapshot()) + renderPage(r.engine.snapshot());
      const dec = BigInt(bad).toString();
      assert.ok((dec.length < 30 || !out.includes(dec)) && !out.toLowerCase().includes(bad.slice(2).toLowerCase()), "the key's value is published");
      assert.equal(r.store.status("lastError"), undefined);
      assert.equal(r.store.status("failures") ?? 0, 0);
    }
    key = generatePrivateKey();
    assert.match((await tickAfter(r, HOUR)).cycle?.stop ?? "", /PAYER_KEY is not the key of the payer/);
    assert.ok(!r.io.calls.includes("settle"));
    key = good;
    const ok = await tickAfter(r, HOUR);
    assert.ok(collected(ok.cycle), JSON.stringify(ok.cycle));
    assert.equal(r.engine.snapshot().state, "running");
    assert.ok(r.alarms.length >= 2, "live mode arms the alarm for the purchase and the share");
    assert.equal(configFromEnv({ MODE: "live", PUBLIC_ORIGIN: "https://x.example" }).problem, "PAYER_ADDRESS must be set to the payer's address");
    assert.match(configFromEnv({ MODE: "sim", PUBLIC_ORIGIN: "http://127.0.0.1:8850" }).problem ?? "", /https origin/);
    assert.match(configFromEnv({ MODE: "test", PUBLIC_ORIGIN: "https://x.example" }).problem ?? "", /MODE must be/);
  });

  await t.test("an RPC error on the block number read is a stop, not a failed purchase", async () => {
    const r = await rig();
    const real = r.io.blockNumber.bind(r.io);
    let errors = 3;
    r.io.blockNumber = async () => {
      if (errors-- > 0) throw new Error("simulated RPC timeout");
      return real();
    };
    for (let i = 0; i < 3; i++) {
      const t1 = await tickAfter(r, 6 * HOUR);
      assert.equal(t1.cycle?.ran, false);
      assert.match(t1.cycle?.stop ?? "", /^the RPC endpoint did not answer: simulated RPC timeout$/);
      assert.match(renderPage(r.engine.snapshot()), /No purchases\./);
    }
    assert.equal(r.store.status("failures") ?? 0, 0);
    assert.equal(r.store.status("backoffUntil"), undefined);
    assert.equal(r.store.events().filter((x) => x.kind === "cycle").length, 0, "nothing was signed");
    assert.ok(collected((await tickAfter(r, 6 * HOUR)).cycle), "the next tick runs");
  });

  await t.test("three failed purchases in a row back off for a day", async () => {
    let refuse = true;
    const r = await rig({ hooks: { refuse: () => (refuse ? { ok: false, error: "facilitator /settle (400): invalid_exact_evm_insufficient_balance", transport: false } : undefined) } });
    for (let i = 0; i < 3; i++) {
      const t1 = await tickAfter(r, 6 * HOUR);
      assert.equal(t1.cycle?.summary?.reason, "purchase-not-final");
    }
    refuse = false;
    const t4 = await tickAfter(r, 6 * HOUR);
    assert.match(t4.cycle?.stop ?? "", /3 cycles failed in a row/);
    const t5 = await tickAfter(r, 19 * HOUR);
    assert.ok(collected(t5.cycle), "after the day it runs again");
    // A refused purchase never reaches the chain, and its share is never submitted.
    const shareNonces = r.store.events().filter((x) => x.kind === "cycle").slice(0, 3).map((x) => x.body.share.info.payment.payload.authorization.nonce);
    for (const n of shareNonces) assert.equal(r.world.executions.get(n), undefined);
  });
});

test("tampered records or changed variables stop the log instead of rewriting it", async (t) => {
  const base = await rig({ start: at("2026-10-31T00:00:00Z") });
  await runUntil(base, at("2026-11-01T06:00:00Z"));
  assert.ok(base.store.get("close", "2026-10"));

  await t.test("a stored statement that does not verify", async () => {
    const r = await rig({ start: at("2026-10-31T00:00:00Z") });
    await runUntil(r, at("2026-11-01T06:00:00Z"));
    r.store.tamper("close", "2026-10", (b) => ({ ...b, jws: `${b.jws.slice(0, -6)}AAAAAA` }));
    const r2 = await restart(r);
    assert.match(r2.engine.degraded ?? "", /could not be rebuilt/);
    assert.equal(r2.engine.serve("/statements/2026-10").status, 503);
    const t1 = await tickAfter(r2, 6 * HOUR);
    assert.match(t1.stop ?? "", /degraded/);
    assert.equal(r2.io.calls.length, 0);
    assert.match(renderPage(r2.engine.snapshot()), /Stopped\./);
  });

  await t.test("a stored cosignature that does not check", async (tt) => {
    const cases: Array<[string, string, (b: Record<string, string>, r: Rig) => Record<string, string>, RegExp]> = [
      ["the fund's JWS broken", "2026-10:fund", (b) => ({ ...b, jws: `${b.jws.slice(0, -6)}AAAAAA` }), /cosignature 2026-10:fund: the signature does not verify/],
      ["the witness's JWS over other bytes", "2026-10:witness", (b, r) => {
        const k = r.engine.keys as NonNullable<Rig["engine"]["keys"]>;
        return { ...b, jws: S.jwsSign(new TextEncoder().encode('{"period":"2026-10"}'), k.witness) };
      }, /cosignature 2026-10:witness: it signs other bytes than the stored statement/],
      ["another kid", "2026-10:witness", (b) => ({ ...b, kid: "did:web:demo.example:fund#fund-1" }), /cosignature 2026-10:witness: kid did:web:demo\.example:fund#fund-1 is not the demo witness's key/],
      ["the fund's JWS stored as the witness's", "2026-10:witness", (b, r) => ({ ...b, jws: r.store.get("cosign", "2026-10:fund")?.body.jws }), /cosignature 2026-10:witness: the JWS header names ES256/],
      ["a payloadHash that is not the statement's", "2026-10:fund", (b) => ({ ...b, payloadHash: "0".repeat(64) }), /cosignature 2026-10:fund: its payloadHash is not the stored statement's hash/],
    ];
    for (const [name, key, change, want] of cases) {
      await tt.test(name, async () => {
        const r = await rig({ start: at("2026-10-31T00:00:00Z") });
        await runUntil(r, at("2026-11-01T06:00:00Z"));
        assert.ok(r.store.get("cosign", key));
        r.store.tamper("cosign", key, (b) => change(b, r));
        const r2 = await restart(r);
        assert.match(r2.engine.degraded ?? "", want);
        assert.equal(r2.engine.serve("/statements/2026-10").status, 503);
        assert.equal(r2.engine.snapshot().statements.length, 0, "the page does not report the cosignatures");
        assert.match((await tickAfter(r2, 6 * HOUR)).stop ?? "", /degraded/);
      });
    }
  });

  await t.test("a recorded decision that replay does not reproduce", async () => {
    const r = await rig({ start: at("2026-10-31T00:00:00Z") });
    await runUntil(r, at("2026-10-31T12:00:00Z"));
    const c = r.store.events().find((x) => x.kind === "cycle-end");
    r.store.tamper("cycle-end", c?.key as string, (b) => ({ ...b, summary: { ...b.summary, amount: "999" } }));
    const r2 = await restart(r);
    assert.match(r2.engine.degraded ?? "", /replay decided/);
  });

  await t.test("another PUBLIC_ORIGIN or MODE", async () => {
    const a = await restart({ ...base, config: { ...base.config, origin: "https://other.example" } });
    assert.match(a.engine.degraded ?? "", /never changes its URL/);
    const b = await restart({ ...base, config: { ...base.config, mode: "live", payerAddress: "0x425c543799fe6452BfCfc3197ccD249b4989ad0B" } });
    assert.match(b.engine.degraded ?? "", /simulated and real records never mix/);
    const ok = await restart(base);
    assert.equal(ok.engine.degraded, undefined);
  });
});

test("a refusal by the demo witness stands, and the log goes on: the statement stays as it is, later months chain through it", async (t) => {
  await t.test("the witness refuses October", async () => {
    const orig = S.Witness.prototype.cosign;
    S.Witness.prototype.cosign = function (this: S.Witness, pub: PublishedStatement, ...rest: unknown[]) {
      if (S.decodeStatement(pub.statement).payload.period === "2026-10") throw new Error("witness refuses: test refusal of October");
      return (orig as (...a: unknown[]) => S.JwsEnvelope).call(this, pub, ...rest);
    } as typeof orig;
    try {
      const r = await rig({ start: at("2026-10-31T00:00:00Z") });
      await runUntil(r, at("2026-10-31T18:00:00Z"));
      const t1 = await tickAfter(r, 6 * HOUR); // 2026-11-01T00:00Z closes October
      assert.ok(t1.maintained.includes("closed 2026-10"));
      assert.equal(r.engine.degraded, undefined);
      const refused = r.store.get("witness-refused", "2026-10")?.body;
      assert.equal(refused?.reason, "witness refuses: test refusal of October");
      assert.equal(refused?.payloadHash, S.statementHash(S.decodeStatement(JSON.parse(r.engine.serve("/statements/2026-10").body).statement).payload));
      assert.equal(r.store.get("cosign", "2026-10:witness"), undefined);
      assert.ok(r.store.get("cosign", "2026-10:fund"), "the fund checks on its own");
      assert.ok(collected(t1.cycle), "the log goes on");
      assert.match(renderPage(r.engine.snapshot()), /the demo witness refused it:<\/strong> witness refuses: test refusal of October/);
      // A restart keeps the refusal and the statement as they are.
      const r2 = await restart(r);
      assert.equal(r2.engine.degraded, undefined, r2.engine.degraded);
      const oct = JSON.parse(r2.engine.serve("/statements/2026-10").body) as PublishedStatement;
      assert.equal(oct.cosignatures.length, 1, "the fund's only");
      // November chains through the refused October, and the witness cosigns it; its refusal of October stands.
      await runUntil(r2, at("2026-12-02T00:00:00Z")); // the fund reads at most 30 receipts a run
      assert.equal(JSON.parse(r2.engine.serve("/statements/2026-11").body).cosignatures.length, 2);
      assert.ok(r2.store.get("cosign", "2026-11:witness"));
      assert.equal(r2.store.get("cosign", "2026-10:witness"), undefined);
      const k = r2.engine.keys as NonNullable<typeof r2.engine.keys>;
      const resolveKey = S.staticResolver({ [k.log.kid]: k.log.publicKey, [k.witness.kid]: k.witness.publicKey });
      const nov = JSON.parse(r2.engine.serve("/statements/2026-11").body) as PublishedStatement;
      assert.equal(S.verifyStatement(oct, { resolveKey, requireCosigners: [k.witness.kid] }).ok, false, "a verifier that requires the witness rejects October");
      assert.equal(S.verifyStatement(nov, { resolveKey, requireCosigners: [k.witness.kid] }).ok, true);
      assert.deepEqual(S.verifyChain([oct, nov]), { ok: true, problems: [] });
    } finally {
      S.Witness.prototype.cosign = orig;
    }
  });

  await t.test("the witness's memory is its own stored cosignatures, not the log's book", async () => {
    const r = await rig({ start: at("2026-10-31T00:00:00Z") });
    await runUntil(r, at("2026-11-01T06:00:00Z"));
    assert.ok(r.store.get("cosign", "2026-10:witness"));
    // As if the witness had cosigned another October payload: November's previous no longer chains to it.
    r.store.tamper("cosign", "2026-10:witness", (b) => ({ ...b, payloadHash: "ab".repeat(32) }));
    r.io.advance(30 * 86400 - 6 * HOUR); // 2026-12-01T00:00Z
    const t1 = await r.engine.tick();
    assert.ok(t1.maintained.includes("closed 2026-11"));
    assert.equal(r.engine.degraded, undefined);
    assert.match(r.store.get("witness-refused", "2026-11")?.body.reason, /witness refuses: previous does not chain to the last payload it cosigned/);
    assert.equal(r.store.get("cosign", "2026-11:witness"), undefined);
    assert.ok(r.store.get("cosign", "2026-11:fund"));
    // December chains through November to the October it remembers wrongly, so it is refused too.
    r.io.advance(31 * 86400);
    const t2 = await r.engine.tick();
    assert.ok(t2.maintained.includes("closed 2026-12"));
    assert.match(r.store.get("witness-refused", "2026-12")?.body.reason, /witness refuses: history does not chain to the last cosigned payload/);
  });
});

test("the fund's view reads the 2026-10-22 Base Sepolia share receipt (recorded fixture)", () => {
  const fx = JSON.parse(readFileSync(join(DIR, "test/fixtures/receipt-share-2026-10-22.json"), "utf8")).receipt;
  const receipt: ReceiptFacts = { status: fx.status === "0x1" ? "success" : "reverted", blockNumber: BigInt(fx.blockNumber), logs: fx.logs };
  assert.deepEqual(transferToFund(receipt, USDC, FUND_ADDRESS), { token: ASSET, to: FUND_ADDRESS, value: "1000" });
  const check = fundCheckOf(fx.transactionHash, receipt, USDC, FUND_ADDRESS);
  assert.equal(check.block, "48983683");
  assert.equal(transferToFund(receipt, USDC, "0x000000000000000000000000000000000000beef"), null, "another address");
  assert.equal(transferToFund(receipt, "0x0000000000000000000000000000000000000001", FUND_ADDRESS), null, "another token");
  assert.equal(transferToFund({ ...receipt, logs: [...receipt.logs, ...receipt.logs] }, USDC, FUND_ADDRESS), null, "two transfers to the fund");
  assert.equal(fundCheckOf(fx.transactionHash, { ...receipt, status: "reverted" }, USDC, FUND_ADDRESS).transfer, null);
  assert.deepEqual(exactRefs([{ ref: `exact:${fx.transactionHash}` }]), [fx.transactionHash]);
  assert.throws(() => exactRefs([{ ref: "payout:abc" }]), /fund refuses/);
});

const RPC = process.env.BASE_SEPOLIA_RPC_URL;

test("the fund's view reads the same receipt live from Base Sepolia (read only)", { skip: !RPC && "no RPC endpoint: set BASE_SEPOLIA_RPC_URL (README, \"Run it\")" }, async () => {
  const { LiveIO } = await import("../io.ts");
  const io = new LiveIO({ rpcUrl: RPC as string, facilitatorUrl: "https://facilitator.invalid" });
  assert.equal(await io.chainId(), 84532);
  const tx = "0xd1e4a7fb3152953a4ddcec9daeb49b09edff94074e3eb69c6c976bda37002a70";
  const receipt = await io.receipt(tx);
  assert.ok(receipt);
  assert.deepEqual(fundCheckOf(tx, receipt, USDC, FUND_ADDRESS), { tx, block: "48983683", status: "success", transfer: { token: ASSET, to: FUND_ADDRESS, value: "1000" } });
  assert.equal(await io.receipt(`0x${"ab".repeat(32)}`), undefined, "an unknown transaction has no receipt");
});

test("the page says what is real and what is simulated, with no scripts, no external fonts and no dashes", async () => {
  const { r } = await run();
  const html = renderPage(r.engine.snapshot());
  for (const phrase of [/What is real/, /What is simulated/, /placeholder address <code>0x000000000000000000000000000000000000f00d<\/code>, which nobody controls/, /demo keys held by this Worker/, /Both are this Worker/, /not part of x402/, /not affiliated with or endorsed by anyone/, /verify\.py/, /merkle\.js/, /simulated mode/]) {
    assert.match(html, phrase);
  }
  assert.ok(!/<script/i.test(html), "no scripts");
  assert.ok(!/<link/i.test(html), "no external stylesheets or fonts");
  assert.ok(!/@import|url\(/.test(html), "no external CSS");
  assert.ok(!new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`).test(html));
  // A simulated log never says it read anything on Base Sepolia.
  assert.match(html, /it read every listed transaction on the repository's simulated chain/);
  assert.ok(!/on Base Sepolia/.test(html), "the simulated page claims Base Sepolia");
  // The facilitator line names the public facilitator (which pays the gas) only when it is the one configured.
  const snap = r.engine.snapshot();
  const live = (facilitator: string) => renderPage({ ...snap, mode: "live", facilitator, statements: [] });
  assert.match(live(DEFAULT_FACILITATOR), /through the public x402 facilitator at <code>https:\/\/x402\.org\/facilitator<\/code>, which pays the gas/);
  const other = live("https://facilitator.other.example");
  assert.match(other, /through the x402 facilitator at <code>https:\/\/facilitator\.other\.example<\/code>\./);
  assert.ok(!/public x402 facilitator|pays the gas/.test(other));
  assert.equal(usdc(1500000n), "1.5");
  assert.equal(usdc(1000n), "0.001");
  assert.equal(usdc(2000000n), "2");
});

test("wrangler.jsonc: one SQLite Durable Object, the cron, vars only (no secret), and only worker.ts imports cloudflare:workers", () => {
  const raw = readFileSync(join(DIR, "wrangler.jsonc"), "utf8");
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(cfg.name, "solidarity-demo-log");
  assert.equal(cfg.main, "worker.ts");
  assert.equal(cfg.compatibility_date, "2026-06-01");
  assert.deepEqual(cfg.compatibility_flags, ["nodejs_compat"]);
  assert.deepEqual(cfg.durable_objects.bindings, [{ name: "LOG", class_name: "DemoLogObject" }]);
  assert.deepEqual(cfg.migrations, [{ tag: "v1", new_sqlite_classes: ["DemoLogObject"] }]);
  assert.deepEqual(cfg.triggers.crons, ["0 */6 * * *"]);
  assert.equal(cfg.vars.MODE, "live");
  assert.equal(cfg.vars.PUBLIC_ORIGIN, "https://solidarity-demo-log.craigm26.workers.dev");
  assert.equal(cfg.vars.END_DATE, "2027-03-31");
  assert.equal(cfg.vars.PAUSED, "0");
  assert.ok(!("PAYER_KEY" in cfg.vars) && !("ADMIN_TOKEN" in cfg.vars));
  assert.ok(!/0x[0-9a-fA-F]{64}/.test(raw), "no 32-byte hex (a key) in wrangler.jsonc");
  assert.equal(configFromEnv(cfg.vars).problem, undefined);
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(join(DIR, f), "utf8");
    assert.equal(/from "cloudflare:workers"/.test(src), f === "worker.ts", f);
  }
});

test("an RPC error is published as a short reason: no URL (an RPC_URL can carry a credential) and no request body", async () => {
  // A closed local port: the connection is refused, nothing leaves this machine.
  const { createServer } = await import("node:net");
  const port = await new Promise<number>((done) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => done(p));
    });
  });
  const secret = "PRETEND-PROVIDER-API-KEY";
  const rpcUrl = `http://127.0.0.1:${port}/v2/${secret}`;
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const key = generatePrivateKey();
  const config = { ...configFromEnv({ MODE: "live", PUBLIC_ORIGIN: "https://demo.example", PAYER_ADDRESS: privateKeyToAccount(key).address, RPC_URL: rpcUrl }) };
  const engine = new Engine({ store: new MemoryStore(), io: new LiveIO({ rpcUrl, facilitatorUrl: "https://facilitator.invalid" }), config, payerKey: () => key });
  await engine.boot();
  assert.equal(engine.degraded, undefined, engine.degraded);
  const t1 = await engine.tick();
  assert.match(t1.cycle?.stop ?? "", /^the RPC endpoint did not answer: /);
  const out = [JSON.stringify(t1), JSON.stringify(engine.snapshot()), renderPage(engine.snapshot())];
  for (const o of out) {
    assert.ok(!o.includes(secret), `published: ${t1.cycle?.stop}`);
    assert.ok(!o.includes(`127.0.0.1:${port}`));
    assert.ok(!o.includes("eth_chainId"), "the request body is published");
  }
  // briefError: viem's short message, first line only, no URL, no long number.
  const { HttpRequestError } = await import("viem");
  assert.equal(briefError(new HttpRequestError({ url: rpcUrl, body: { method: "eth_chainId" }, status: 401, details: "unauthorized" })), "HTTP request failed.");
  assert.equal(briefError(new Error(`fetch ${rpcUrl} failed\nsecond line`)), "fetch <url> failed");
  assert.equal(briefError(new Error(`expected valid private key: 1 <= n < 1157920892373161954235709850086879078528375642790749043826051631415181614943, got ${BigInt(`0x${"ff".repeat(32)}`)}`)), "expected valid private key: 1 <= n < <number>, got <number>");
  assert.equal(briefError(new Error("UNIQUE constraint failed: events result submit:0x1234567890123456789012345678901234567890123456789012345678901234")), "UNIQUE constraint failed: events result submit:0x1234567890123456789012345678901234567890123456789012345678901234", "transaction hashes and nonces stay");
});

test("store.ts: recent() reads the newest rows of one kind through the (kind, seq) index, in node:sqlite", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec: (q: string, ...b: unknown[]) => {
        const rows = db.prepare(q).all(...(b as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
  };
  const store = new SqlStore(storage);
  for (let i = 0; i < 50; i++) {
    store.append("cycle", `c${i}`, i, { n: i });
    store.append("settled", `c${i}`, i, { n: i });
  }
  assert.deepEqual(store.recent("cycle", 3).map((e) => e.body.n), [49, 48, 47]);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT seq, at, kind, key, body FROM events WHERE kind = ? ORDER BY seq DESC LIMIT ?").all("cycle", 20).map((x) => String((x as { detail: string }).detail));
  assert.deepEqual(plan, ["SEARCH events USING INDEX events_kind_seq (kind=?)"], "no sort of every row of the kind");
  // The index is added to a store created before it existed, too.
  const store2 = new SqlStore(storage);
  assert.equal(store2.events().length, 100);
});
