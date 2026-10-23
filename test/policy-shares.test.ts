import assert from "node:assert/strict";
import { test } from "node:test";
import { CapCounter, consentSummary, policyHash, policyProblems } from "../src/solidarity/policy.ts";
import { applyRate, generateShareId, isValidRate, isValidShareId, netCredit, nextPeriod, periodOf, recordedShare, shareMax } from "../src/solidarity/utils.ts";
import { canonicalizeStrict } from "../src/solidarity/jcs.ts";
import { sha256Hex } from "../src/solidarity/ledger.ts";
import type { OwnerPolicy } from "../src/solidarity/types.ts";
import { conformance } from "./helpers.ts";

const shares = conformance("shares.json");
const policies = conformance("policies.json");
const POLICY: OwnerPolicy = policies.policyHash.policy;

test("share arithmetic matches the conformance vectors", () => {
  for (const c of shares.cases) {
    if (c.fn === "shareMax") assert.equal(shareMax(c.purchase, c.rate, c.capLeft ?? undefined).toString(), c.expected, JSON.stringify(c));
    if (c.fn === "recordedShare") assert.equal(recordedShare(c.signed, c.basis, c.rate).toString(), c.expected, JSON.stringify(c));
    if (c.fn === "netCredit") assert.equal(netCredit(c.refunded, c.rate, c.share, c.alreadyCredited).toString(), c.expected, JSON.stringify(c));
  }
  for (const r of shares.rates) assert.equal(isValidRate(r.rate), r.valid, r.rate);
});

test("share = floor(amount x rate) with bigint, never rounded up", () => {
  assert.equal(applyRate("48000000", "0.001"), 48000n);
  assert.equal(applyRate("1999", "0.001"), 1n);
  assert.equal(applyRate("999", "0.001"), 0n);
  assert.equal(applyRate("123456789012345678901234567890", "0.0025"), 308641972530864197253086419n);
  assert.throws(() => applyRate("1", "0.02"));
  assert.throws(() => applyRate("1", "0.0010"));
  assert.throws(() => applyRate("-5", "0.001"));
});

test("policy checks per mode, as in the conformance vectors", () => {
  for (const c of policies.cases) {
    assert.deepEqual(policyProblems(c.policy, c.mode), c.problems, c.name);
    assert.equal(c.valid, c.problems.length === 0, c.name);
  }
  assert.ok(policyProblems({ ...POLICY, refunds: "net" }, "separate").includes("separate mode is keep only"));
});

test("policy hash is SHA-256 of the JCS bytes (holder's own records only)", () => {
  assert.equal(policyHash(POLICY), sha256Hex(canonicalizeStrict(POLICY)));
  assert.equal(policyHash(POLICY), policies.policyHash.sha256);
  assert.equal(policyHash({ ...POLICY, logs: [...(POLICY.logs ?? [])] }), policyHash(POLICY));
  assert.notEqual(policyHash({ ...POLICY, rate: "0.002" }), policyHash(POLICY));
});

test("consent summary shows rate, cap, fund and the refund rule", () => {
  const s = consentSummary(POLICY);
  assert.equal(s.rate, "0.001");
  assert.match(s.cap, /5000000/);
  assert.equal(s.fund, POLICY.fund);
  assert.equal(s.refunds, "keep");
});

test("cap counter: counts at signing, stops at the cap, per UTC month", () => {
  const c = new CapCounter({ ...POLICY, cap: { ...POLICY.cap, amount: "100" } });
  c.commit({ id: "a".repeat(22), amount: 60n, period: "2026-12", kind: "exact", validBefore: 1000 });
  assert.equal(c.left("2026-12"), 40n);
  assert.throws(() => c.commit({ id: "b".repeat(22), amount: 41n, period: "2026-12", kind: "exact" }), /cap/);
  assert.throws(() => c.commit({ id: "a".repeat(22), amount: 1n, period: "2026-12", kind: "exact" }), /already counted/);
  c.commit({ id: "c".repeat(22), amount: 40n, period: "2026-12", kind: "batch-settlement" });
  assert.equal(c.left("2026-12"), 0n);
  assert.equal(c.left("2027-01"), 100n);
  assert.equal(shareMax("48000000", "0.001", c.left("2026-12")), 0n);
  assert.ok(c.counts("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
  assert.ok(!c.counts("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"));
});

test("cap counter: release only an exact share shown unexecuted at a block at or after validBefore", () => {
  const c = new CapCounter({ ...POLICY, cap: { ...POLICY.cap, amount: "100" } });
  c.commit({ id: "a".repeat(22), amount: 60n, period: "2026-12", kind: "exact", validBefore: 1000 });
  c.commit({ id: "b".repeat(22), amount: 30n, period: "2026-12", kind: "batch-settlement" });
  assert.equal(c.release("a".repeat(22), { now: 999, executed: false }), false, "read at a block before validBefore");
  assert.equal(c.release("a".repeat(22), { now: 1000, executed: true }), false, "it was executed");
  assert.equal(c.release("b".repeat(22), { now: 9999, executed: false }), false, "batch shares are never released");
  // At a block whose timestamp is validBefore, EIP-3009 no longer executes it (it needs now < validBefore).
  assert.equal(c.release("a".repeat(22), { now: 1000, executed: false }), true);
  assert.equal(c.release("a".repeat(22), { now: 1000, executed: false }), false, "only once");
  assert.equal(c.left("2026-12"), 70n);
});

test("cap counter: turning the policy off stops shares at once", () => {
  const c = new CapCounter(POLICY);
  c.turnOff();
  assert.equal(c.left("2026-12"), 0n);
  assert.throws(() => c.commit({ id: "a".repeat(22), amount: 1n, period: "2026-12", kind: "exact" }), /off/);
});

test("share ids: 22 characters from 128 random bits, never repeated", () => {
  const ids = new Set(Array.from({ length: 200 }, generateShareId));
  assert.equal(ids.size, 200);
  for (const id of ids) {
    assert.equal(id.length, 22);
    assert.ok(isValidShareId(id));
  }
  assert.ok(!isValidShareId("short"));
  assert.ok(!isValidShareId("x".repeat(129)));
  assert.ok(!isValidShareId("has space in it 123456"));
});

test("periods are UTC calendar months", () => {
  assert.equal(periodOf(Date.UTC(2026, 9, 31, 23, 59, 59) / 1000), "2026-10");
  assert.equal(periodOf(Date.UTC(2026, 10, 1, 0, 0, 0) / 1000), "2026-11");
  assert.equal(nextPeriod("2026-12"), "2027-01");
});
