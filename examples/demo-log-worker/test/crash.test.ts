/**
 * Crash points: the Durable Object is reset between two steps, then a new
 * instance rebuilds the log from what was recorded (with no chain call and
 * no private key read) and finishes the work. SIMULATED chain and clock.
 *
 * A reset drops every write made after the last confirmed one (sync() or an
 * outgoing call, the output gate), as MemoryStore.crash() does.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as S from "../../../src/solidarity/index.ts";
import type { PublishedStatement } from "../../../src/solidarity/index.ts";
import type { SimHooks } from "../io.ts";
import { NotYet } from "../engine.ts";
import { Crash } from "../store.ts";
import { at, collected, HOUR, invariants, published, restart, rig, runUntil, tickAfter } from "./harness.ts";
import type { Rig } from "./harness.ts";

/** A log with one finished cycle, and hooks to set for the next. */
async function warm(start = "2026-10-23T00:00:00Z"): Promise<{ r: Rig; hooks: SimHooks }> {
  const hooks: SimHooks = {};
  const r = await rig({ start: at(start), hooks });
  assert.ok(collected((await tickAfter(r, 6 * HOUR)).cycle));
  return { r, hooks };
}

/** The tick that dies, then the reset and the new instance. */
async function crashAndRestart(r: Rig, step = 6 * HOUR): Promise<Rig> {
  await assert.rejects(tickAfter(r, step), (e: unknown) => e instanceof Crash);
  r.store.crash();
  const r2 = await restart(r);
  assert.equal(r2.engine.degraded, undefined, r2.engine.degraded);
  assert.equal(r2.blockedCalls, 0, "the rebuild called the chain");
  assert.equal(r2.keys.reads, 0, "the rebuild read a private key");
  return r2;
}

const lastCycle = (r: Rig) => r.store.events().filter((e) => e.kind === "cycle").at(-1) as NonNullable<ReturnType<Rig["store"]["get"]>>;
const shareNonce = (c: ReturnType<typeof lastCycle>) => (c.body.share.info.payment.payload.authorization.nonce as string).toLowerCase();
const purchaseNonce = (c: ReturnType<typeof lastCycle>) => (c.body.purchase.payload.authorization.nonce as string).toLowerCase();
const endOf = (r: Rig, c: ReturnType<typeof lastCycle>) => r.store.get("cycle-end", c.key)?.body.summary;

function settleNth(hooks: SimHooks, which: "beforeSettle" | "afterExecuted", n: number, kill: () => Error): void {
  let seen = 0;
  hooks[which] = () => {
    if (++seen === n) throw kill();
  };
}

test("C1: dies after the cycle row, before the purchase is sent", async (t) => {
  for (const [name, wait, expectCollected] of [["still valid: resubmitted", 90, true], ["expired: the purchase never ran, the share is never sent", 400, false]] as const) {
    await t.test(name, async () => {
      const { r, hooks } = await warm();
      settleNth(hooks, "beforeSettle", 1, () => r.store.kill("before the purchase POST"));
      const r2 = await crashAndRestart(r);
      const c = lastCycle(r2);
      assert.equal(c.body.n, 2);
      assert.equal(r2.engine.snapshot().unfinished, 2);
      assert.match((await r2.engine.cycle()).stop ?? "", /cycle 2 is unfinished/, "no new cycle while one is unfinished");
      assert.ok(!r2.io.calls.includes("settle"));
      r2.io.advance(wait);
      await r2.engine.maintain();
      const sum = endOf(r2, c);
      if (expectCollected) {
        assert.equal(sum.state, "collected");
        assert.equal(r2.store.get("result", `submit:${purchaseNonce(c)}`)?.body.via, "facilitator");
      } else {
        assert.equal(sum.reason, "purchase-not-final");
        assert.equal(r2.store.get("result", `submit:${purchaseNonce(c)}`)?.body.via, "chain");
        assert.equal(r2.world.executions.get(purchaseNonce(c)), undefined);
        assert.equal(r2.world.executions.get(shareNonce(c)), undefined);
        assert.equal(r2.store.get("intent", `submit:${shareNonce(c)}`), undefined);
      }
      assert.deepEqual(invariants(r2), []);
      assert.ok(collected((await tickAfter(r2, 6 * HOUR)).cycle), "the next cycle runs");
    });
  }
});

test("C2: the purchase executed but its answer was lost", async (t) => {
  for (const [name, wait] of [["the share is still valid: submitted and collected", 60], ["past the share's validBefore: skipped, never sent", 700]] as const) {
    await t.test(name, async () => {
      const { r, hooks } = await warm();
      settleNth(hooks, "afterExecuted", 1, () => r.store.kill("after the purchase executed"));
      const r2 = await crashAndRestart(r);
      const c = lastCycle(r2);
      assert.equal(r2.world.executions.get(purchaseNonce(c)), 1);
      r2.io.advance(wait);
      await r2.engine.maintain();
      const res = r2.store.get("result", `submit:${purchaseNonce(c)}`)?.body;
      assert.equal(res.ok, true);
      assert.equal(res.via, "chain", "found on chain, not resubmitted");
      assert.equal(r2.world.executions.get(purchaseNonce(c)), 1);
      const sum = endOf(r2, c);
      if (wait === 60) assert.equal(sum.state, "collected");
      else {
        assert.equal(sum.status, "skipped");
        assert.equal(sum.reason, "bad-payment");
        assert.equal(r2.world.executions.get(shareNonce(c)), undefined);
      }
      assert.deepEqual(invariants(r2), []);
    });
  }
});

test("C3: dies after the settled row, before the share's intent", async (t) => {
  for (const [name, wait] of [
    ["resumed in time: submitted", 30],
    ["resumed with under a minute left: never sent; it waits for validBefore to pass, then reads the chain", 560],
    ["resumed too late: never sent, and uncollected only once the chain shows it unused after validBefore", 700],
  ] as const) {
    await t.test(name, async () => {
      const { r } = await warm();
      r.store.onAppend = (kind) => {
        if (kind === "intent") throw r.store.kill("before the share intent");
      };
      const r2 = await crashAndRestart(r);
      const c = lastCycle(r2);
      assert.ok(r2.store.get("settled", c.key), "the settled row was confirmed");
      r2.io.advance(wait);
      await r2.engine.maintain();
      const sum = endOf(r2, c);
      assert.equal(sum.status, "accepted", "the same decision at the recorded clock reading");
      if (wait === 30) assert.equal(sum.state, "collected");
      else {
        assert.equal(sum.state, "uncollected");
        // Draft 3: no "never sent" shortcut. The answer is the chain's, read after validBefore.
        const result = r2.store.get("result", `submit:${shareNonce(c)}`);
        assert.deepEqual([result?.body.via, result?.body.used], ["chain", false]);
        assert.ok((result?.at ?? 0) > c.body.share.validBefore + 30, "recorded only after validBefore + 30 seconds");
        assert.equal(r2.store.get("lookup", `lookup:${shareNonce(c)}`)?.body.found, null);
        assert.equal(r2.world.executions.get(shareNonce(c)), undefined);
        assert.equal(JSON.parse(r2.engine.serve(`/proofs/${c.body.share.id}`).body).status, "uncollected");
      }
      assert.deepEqual(invariants(r2), []);
    });
  }
});

test("C3, records from before draft 3: a share the old code answered itself (never sent, via engine) replays as queued, and is uncollected when its month closes", async () => {
  const { r } = await warm("2026-10-31T00:00:00Z");
  r.store.onAppend = (kind) => {
    if (kind === "intent") throw r.store.kill("before the share intent");
  };
  const r2 = await crashAndRestart(r);
  const c = lastCycle(r2);
  // What the draft 2 code wrote when it resumed with under a minute left on the share: an answer
  // from the engine itself, before validBefore, a lookup that found nothing, and the share
  // uncollected at once (draft 3 forbids that before validBefore has passed).
  const t = c.body.share.validBefore - 40;
  const nonce = shareNonce(c);
  r2.store.append("result", `submit:${nonce}`, t, { ok: false, error: "not submitted before validBefore", via: "engine", role: "share", cycle: c.key });
  r2.store.append("lookup", `lookup:${nonce}`, t, { found: null, window: { fromBlock: String(c.body.block), toBlock: String(BigInt(c.body.block) + 550n) } });
  const old = { status: "accepted", reason: null, period: "2026-10", amount: "1000", state: "uncollected", transaction: null };
  r2.store.append("cycle-end", c.key, t, { summary: old, error: "not submitted before validBefore" });
  await r2.store.sync();

  const r3 = await restart(r2);
  assert.equal(r3.engine.degraded, undefined, r3.engine.degraded);
  assert.equal(r3.blockedCalls, 0);
  assert.deepEqual(JSON.parse(r3.engine.serve(`/proofs/${c.body.share.id}`).body), { status: "queued" }, "replayed at its recorded clock, before validBefore: not yet uncollected");
  // Closing October looks again: its validBefore has passed and the recorded answer shows it unused.
  await runUntil(r3, at("2026-11-01T06:00:00Z"));
  assert.ok(r3.store.get("close", "2026-10"));
  assert.deepEqual(JSON.parse(r3.engine.serve(`/proofs/${c.body.share.id}`).body), { status: "uncollected" });
  assert.doesNotMatch(r3.engine.serve("/lines/2026-10").body, new RegExp(c.body.share.id));
  assert.deepEqual(r3.store.get("cycle-end", c.key)?.body.summary, old, "the record is never rewritten");
  assert.equal(r3.world.executions.get(nonce), undefined);
  assert.deepEqual(invariants(r3), []);
  // Replayed again, the same records give the same published bodies.
  const r4 = await restart(r3);
  assert.equal(r4.engine.degraded, undefined, r4.engine.degraded);
  assert.deepEqual(published(r4), published(r3));
});

test("C4: dies after the share's intent, before its POST left", async (t) => {
  for (const [name, wait] of [["unused and valid: resubmitted", 90], ["unused and expired: uncollected", 700]] as const) {
    await t.test(name, async () => {
      const { r, hooks } = await warm();
      settleNth(hooks, "beforeSettle", 2, () => r.store.kill("before the share POST"));
      const r2 = await crashAndRestart(r);
      const c = lastCycle(r2);
      assert.ok(r2.store.get("intent", `submit:${shareNonce(c)}`));
      // The log had accepted the share: after the restart it is still queued, never "not found".
      const proof = r2.engine.serve(`/proofs/${c.body.share.id}`);
      assert.equal(`${proof.status} ${proof.contentType} ${proof.body}`, '200 application/json {"status":"queued"}');
      r2.io.advance(wait);
      await r2.engine.maintain();
      const sum = endOf(r2, c);
      if (wait === 90) {
        assert.equal(sum.state, "collected");
        assert.equal(r2.world.executions.get(shareNonce(c)), 1);
      } else {
        assert.equal(sum.state, "uncollected");
        assert.equal(r2.world.executions.get(shareNonce(c)), undefined);
      }
      assert.deepEqual(invariants(r2), []);
    });
  }
});

test("C4b: the share executed, the facilitator said 502, and the log search lags: never recorded uncollected", async () => {
  const { r, hooks } = await warm();
  let settles = 0;
  hooks.answer = (_n, _i, real) => (++settles === 2 && real.ok ? { ok: false, error: "facilitator /settle (502): bad gateway", transport: false } : real);
  // A load-balanced RPC: authorizationState already says used, but the next two log searches miss the block.
  const find = r.io.findTransfer.bind(r.io);
  let lag = 2;
  r.io.findTransfer = async (a, p, w) => (lag-- > 0 ? undefined : find(a, p, w));
  const failuresBefore = r.store.status("failures");
  await assert.rejects(tickAfter(r, 6 * HOUR), (e: unknown) => e instanceof NotYet && /not found yet/.test((e as Error).message));
  const c = lastCycle(r);
  assert.equal(r.world.executions.get(shareNonce(c)), 1, "the share's transfer ran");
  assert.equal(r.store.get("result", `submit:${shareNonce(c)}`), undefined, "no answer recorded");
  assert.equal(r.store.get("lookup", `lookup:${shareNonce(c)}`), undefined);
  assert.equal(r.store.get("cycle-end", c.key), undefined);
  assert.equal(r.engine.degraded, undefined);
  assert.equal(r.engine.snapshot().unfinished, c.body.n);
  assert.equal(JSON.parse(r.engine.serve(`/proofs/${c.body.share.id}`).body).status, "queued");
  assert.equal(r.store.status("failures"), failuresBefore, "a transfer not readable yet is not a failed purchase");
  // The alarm looks again: still lagging, still nothing recorded.
  r.io.advance(900);
  await assert.rejects(r.engine.maintain(), NotYet);
  assert.equal(r.store.get("cycle-end", c.key), undefined);
  // And again: found, collected with the transaction that ran.
  r.io.advance(900);
  assert.deepEqual(await r.engine.maintain(), [`finished cycle ${c.body.n}`]);
  const sum = endOf(r, c);
  assert.equal(sum.state, "collected");
  const t = await r.world.chain.findExactTransfer(c.body.share.info.payment.accepted, c.body.share.info.payment.payload);
  assert.equal(sum.transaction, t?.transaction);
  assert.equal(r.store.get("result", `submit:${shareNonce(c)}`)?.body.via, "chain");
  assert.equal(r.store.status("backoffUntil"), undefined);
  assert.deepEqual(invariants(r), []);
  // And the restart after it replays to the same decision.
  const r2 = await restart(r);
  assert.equal(r2.engine.degraded, undefined, r2.engine.degraded);
  assert.equal(r2.engine.log?.inspect(c.body.share.id)?.state, "collected");
});

test("C5: the share executed but its answer was lost: found on chain, collected with that transaction", async () => {
  const { r, hooks } = await warm();
  settleNth(hooks, "afterExecuted", 2, () => r.store.kill("after the share executed"));
  const r2 = await crashAndRestart(r);
  const c = lastCycle(r2);
  assert.equal(r2.world.executions.get(shareNonce(c)), 1);
  r2.io.advance(60);
  await r2.engine.maintain();
  const sum = endOf(r2, c);
  assert.equal(sum.state, "collected");
  const t = await r2.world.chain.findExactTransfer(c.body.share.info.payment.accepted, c.body.share.info.payment.payload);
  assert.equal(sum.transaction, t?.transaction);
  assert.equal(r2.store.get("result", `submit:${shareNonce(c)}`)?.body.via, "chain");
  assert.equal(r2.world.executions.get(shareNonce(c)), 1, "never executed twice");
  assert.deepEqual(invariants(r2), []);
});

test("C6: dies after the results, before cycle-end: the records answer everything, nothing is sent again", async () => {
  const { r } = await warm();
  r.store.onAppend = (kind) => {
    if (kind === "cycle-end") {
      r.store.gate(); // the results were confirmed
      throw r.store.kill("before cycle-end");
    }
  };
  const r2 = await crashAndRestart(r);
  const c = lastCycle(r2);
  await r2.engine.maintain();
  assert.equal(endOf(r2, c).state, "collected");
  assert.deepEqual(r2.io.calls, [], "no chain call: both answers were recorded");
  assert.deepEqual(invariants(r2), []);
});

/** A log with two cycles on 2026-10-31, about to close October at the next tick. */
async function beforeClose(): Promise<Rig> {
  const r = await rig({ start: at("2026-10-31T06:00:00Z") });
  await tickAfter(r, 6 * HOUR);
  await tickAfter(r, 6 * HOUR);
  return r;
}

test("C7: dies after the close intent, before the statement is recorded: the same statement, byte for byte", async () => {
  const r = await beforeClose();
  let lost: string | undefined;
  r.store.onAppend = (kind, _key, body) => {
    if (kind === "close") {
      lost = (body as { jws: string }).jws;
      throw r.store.kill("before the close row");
    }
  };
  const r2 = await crashAndRestart(r);
  assert.ok(r2.store.get("close-intent", "2026-10"));
  assert.equal(r2.engine.serve("/statements/2026-10").status, 404, "never published");
  r2.io.advance(HOUR);
  await r2.engine.maintain();
  const close = r2.store.get("close", "2026-10")?.body;
  assert.equal(close.jws, lost, "same issuedAt, same payload, and Ed25519 signs deterministically");
  assert.equal(close.issuedAt, r2.store.get("close-intent", "2026-10")?.body.issuedAt);
  const pub = JSON.parse(r2.engine.serve("/statements/2026-10").body) as PublishedStatement;
  assert.equal(pub.cosignatures.length, 2);
});

test("C8 and C9: dies before the witness's or the fund's cosignature: added on resume, after the stored ones", async (t) => {
  for (const role of ["witness", "fund"] as const) {
    await t.test(role, async () => {
      const r = await beforeClose();
      r.store.onAppend = (kind, key) => {
        if (kind === "cosign" && key === `2026-10:${role}`) {
          r.store.gate();
          throw r.store.kill(`before the ${role} cosignature`);
        }
      };
      const r2 = await crashAndRestart(r);
      const before = JSON.parse(r2.engine.serve("/statements/2026-10").body) as PublishedStatement;
      assert.equal(before.cosignatures.length, role === "witness" ? 0 : 1);
      await r2.engine.maintain();
      const after = JSON.parse(r2.engine.serve("/statements/2026-10").body) as PublishedStatement;
      assert.equal(after.statement.signature, before.statement.signature);
      assert.equal(after.cosignatures.length, 2);
      const k = r2.engine.keys as NonNullable<typeof r2.engine.keys>;
      assert.deepEqual(after.cosignatures.map((x) => S.jwsDecode(x.signature).header.kid), [k.witness.kid, k.fund.kid]);
      const resolveKey = S.staticResolver({ [k.log.kid]: k.log.publicKey, [k.witness.kid]: k.witness.publicKey, [k.fund.kid]: k.fund.publicKey });
      assert.equal(S.verifyStatement(after, { resolveKey, descriptor: r2.engine.descriptor, requireCosigners: [k.witness.kid, k.fund.kid] }).ok, true);
    });
  }
});

test("C8b: dies before October's witness cosignature and wakes after November ended: the witness cosigns both, in order", async () => {
  const r = await beforeClose();
  r.store.onAppend = (kind, key) => {
    if (kind === "cosign" && key === "2026-10:witness") {
      r.store.gate();
      throw r.store.kill("before the witness cosignature");
    }
  };
  const r2 = await crashAndRestart(r);
  r2.io.advance(30 * 86400); // 2026-12-01T00:00Z: November is due before October's cosignatures are made
  const t = await r2.engine.tick();
  assert.equal(r2.engine.degraded, undefined, r2.engine.degraded);
  assert.ok(t.maintained.includes("closed 2026-11"));
  const witness = r2.store.events().filter((e) => e.kind === "cosign" && e.body.role === "witness").map((e) => e.key);
  assert.deepEqual(witness, ["2026-10:witness", "2026-11:witness"], "October first, then November");
  assert.equal(r2.store.get("witness-refused", "2026-11"), undefined);
  const pubs = ["2026-10", "2026-11"].map((p) => JSON.parse(r2.engine.serve(`/statements/${p}`).body) as PublishedStatement);
  assert.ok(pubs.every((p) => p.cosignatures.length === 2));
  assert.equal(S.verifyChain(pubs).ok, true);
  assert.equal(S.decodeStatement(pubs[1].statement).payload.previous, r2.store.get("cosign", "2026-10:witness")?.body.payloadHash);
});

test("C10: a storage write fails mid-cycle: the engine rebuilds itself and the alarm finishes the cycle", async () => {
  const { r } = await warm();
  let fail = true;
  r.store.onAppend = (kind) => {
    if (fail && kind === "result") {
      fail = false;
      throw new Error("SQLITE_FULL: database or disk is full");
    }
  };
  await assert.rejects(tickAfter(r, 6 * HOUR), /SQLITE_FULL/);
  assert.equal(r.engine.degraded, undefined);
  const c = lastCycle(r);
  assert.equal(r.store.get("cycle-end", c.key), undefined);
  assert.equal(r.world.executions.get(purchaseNonce(c)), 1, "the purchase executed; its result was not recorded");
  r.io.advance(60);
  assert.deepEqual(await r.engine.maintain(), ["finished cycle 2"]);
  assert.equal(endOf(r, c).state, "collected");
  assert.equal(r.store.get("result", `submit:${purchaseNonce(c)}`)?.body.via, "chain");
  assert.ok(collected((await tickAfter(r, 6 * HOUR)).cycle), "and the next tick's cycle runs");
  assert.deepEqual(invariants(r), []);
});

test("a failed answer is never final: an error after the transfer ran, and a lost connection", async (t) => {
  await t.test("the facilitator says 502 but the purchase executed: found on chain after it is final", async () => {
    const { r, hooks } = await warm();
    let first = true;
    hooks.answer = (_n, _i, real) => {
      if (!first) return real;
      first = false;
      return { ok: false, error: "facilitator /settle (502): bad gateway", transport: false };
    };
    const tk = await tickAfter(r, 6 * HOUR);
    assert.ok(collected(tk.cycle));
    const c = lastCycle(r);
    assert.equal(r.store.get("result", `submit:${purchaseNonce(c)}`)?.body.via, "chain");
    assert.equal(r.world.executions.get(purchaseNonce(c)), 1);
  });

  await t.test("no answer at all: checked on chain, then sent again a minute later", async () => {
    const { r, hooks } = await warm();
    let refused = 0;
    hooks.refuse = () => (refused++ === 0 ? { ok: false, error: "facilitator /settle: fetch failed", transport: true } : undefined);
    const tk = await tickAfter(r, 6 * HOUR);
    assert.ok(collected(tk.cycle));
    const c = lastCycle(r);
    assert.equal(r.store.get("result", `submit:${purchaseNonce(c)}`)?.body.via, "facilitator");
    assert.ok(r.io.calls.filter((x) => x === "settle").length >= 3, "purchase twice, share once");
    assert.deepEqual(invariants(r), []);
  });
});
