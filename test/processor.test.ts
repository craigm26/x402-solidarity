import assert from "node:assert/strict";
import { test } from "node:test";
import * as S from "../src/solidarity/index.ts";
import type { LogDescriptor, OwnerPolicy } from "../src/solidarity/index.ts";

const FUND = "https://fund.example/solidarity";
const descriptor: LogDescriptor = {
  version: 2,
  log: "https://processor.example/solidarity",
  funds: [FUND],
  minCollection: "100",
  keys: [{ kid: "did:web:processor.example#1", from: "2026-10", until: null }],
};
const policy = (refunds: "keep" | "net"): OwnerPolicy => ({ version: 2, rate: "0.01", cap: { amount: "100000", asset: "USD" }, fund: FUND, refunds, since: "2026-10-01T00:00:00Z" });

function setup(refunds: "keep" | "net") {
  const clock = { now: Date.UTC(2026, 9, 10) / 1000 };
  const key = S.generateSigningKey("EdDSA", descriptor.keys[0].kid);
  const p = new S.ProcessorHolder({ descriptor, key, clock: () => clock.now });
  p.addOwner("owner-1", policy(refunds));
  return { p, clock, key };
}

test("processor mode: a descriptor with accepts is refused", () => {
  assert.throws(() => new S.ProcessorHolder({ descriptor: { ...descriptor, accepts: [] }, key: S.generateSigningKey("EdDSA", "k") }), /omits/);
});

test("processor mode: one line per finalized purchase, collected in aggregate; small totals carry forward", () => {
  const { p, clock } = setup("keep");
  const a = p.recordPurchase({ owner: "owner-1", purchaseId: "p1", amount: "4000", asset: "USD" }); // $40.00 -> 40 cents
  assert.equal(p.shareAmount(a as string), 40n);
  const r1 = p.collect();
  assert.deepEqual(r1.collected, []);
  assert.deepEqual(r1.carried, [a]);
  clock.now = Date.UTC(2026, 10, 10) / 1000;
  const b = p.recordPurchase({ owner: "owner-1", purchaseId: "p2", amount: "7000", asset: "USD" }); // 70 cents
  const r2 = p.collect();
  assert.deepEqual(r2.collected.sort(), [a, b].sort());
  assert.equal(r2.period, "2026-11", "a line's period is the month the processor collected it");
  clock.now = Date.UTC(2026, 11, 2) / 1000;
  const oct = p.closePeriod("2026-10");
  const nov = p.closePeriod("2026-11");
  assert.equal(S.decodeStatement(oct.statement).payload.size, 0);
  const np = S.decodeStatement(nov.statement).payload;
  assert.equal(np.size, 2);
  assert.deepEqual(np.totals, [{ fund: FUND, asset: "USD", lines: 2, amount: "110" }]);
  assert.match(p.handle("/settlements/2026-11").body, /\|payout:processor\.example\/2026-11\/1\|110\n$/, "payout references start with the log's host");
  assert.deepEqual(S.verifyChain([oct, nov]), { ok: true, problems: [] });
});

test("processor mode: keep means a refund changes nothing", () => {
  const { p } = setup("keep");
  p.recordPurchase({ owner: "owner-1", purchaseId: "p1", amount: "20000", asset: "USD" });
  assert.deepEqual(p.refund({ purchaseId: "p1", refunded: "20000" }), { credit: 0n });
  const next = p.recordPurchase({ owner: "owner-1", purchaseId: "p2", amount: "20000", asset: "USD" });
  assert.equal(p.shareAmount(next as string), 200n);
});

test("processor mode: net credits lower later shares, never make a zero line, and lapse after the next period", () => {
  const { p, clock } = setup("net");
  p.recordPurchase({ owner: "owner-1", purchaseId: "p1", amount: "20000", asset: "USD" }); // share 200
  assert.deepEqual(p.refund({ purchaseId: "p1", refunded: "5000" }), { credit: 50n, lapsesAfter: "2026-11" }, "partial refund nets in proportion");
  assert.equal(p.refund({ purchaseId: "p1", refunded: "99999999" }).credit, 150n, "never more than the original share in total");
  assert.equal(p.refund({ purchaseId: "p1", refunded: "1" }).credit, 0n);
  // Credits: 200. A 150-cent share is absorbed entirely (no zero line); the next share takes the last 50.
  assert.equal(p.recordPurchase({ owner: "owner-1", purchaseId: "p2", amount: "15000", asset: "USD" }), undefined);
  const s3 = p.recordPurchase({ owner: "owner-1", purchaseId: "p3", amount: "30000", asset: "USD" });
  assert.equal(p.shareAmount(s3 as string), 250n);
  // A credit made in October lapses at the end of November.
  p.recordPurchase({ owner: "owner-1", purchaseId: "p4", amount: "50000", asset: "USD" }); // 500
  assert.equal(p.refund({ purchaseId: "p4", refunded: "50000" }).credit, 500n);
  clock.now = Date.UTC(2026, 11, 5) / 1000; // December
  const s5 = p.recordPurchase({ owner: "owner-1", purchaseId: "p5", amount: "10000", asset: "USD" });
  assert.equal(p.shareAmount(s5 as string), 100n, "the credit lapsed");
  // Two partial refunds credit what one refund of the same total would.
  const { p: q } = setup("net");
  q.recordPurchase({ owner: "owner-1", purchaseId: "a", amount: "99999", asset: "USD" }); // 999
  const c1 = q.refund({ purchaseId: "a", refunded: "150" }).credit; // floor(1.5) = 1
  const c2 = q.refund({ purchaseId: "a", refunded: "150" }).credit; // floor(3.0) - 1 = 2
  assert.equal(c1 + c2, 3n);
});

test("processor mode: a reversed collection suspends the policy and never touches a published batch", () => {
  const { p, clock } = setup("keep");
  p.recordPurchase({ owner: "owner-1", purchaseId: "p1", amount: "20000", asset: "USD" });
  p.collect();
  clock.now = Date.UTC(2026, 10, 2) / 1000;
  const oct = p.closePeriod("2026-10");
  p.onCollectionReversed("owner-1");
  assert.equal(p.recordPurchase({ owner: "owner-1", purchaseId: "p2", amount: "20000", asset: "USD" }), undefined);
  assert.equal(JSON.parse(p.handle("/statements/2026-10").body).statement.signature, oct.statement.signature);
});

test("processor mode: the fund attests its payouts", () => {
  const { p, clock, key } = setup("keep");
  const id = p.recordPurchase({ owner: "owner-1", purchaseId: "p1", amount: "20000", asset: "USD" }) as string;
  p.collect();
  clock.now = Date.UTC(2026, 10, 2) / 1000;
  const st = p.closePeriod("2026-10");
  const fundKey = S.generateSigningKey("EdDSA", "did:web:fund.example#1");
  const resolveKey = S.staticResolver({ [key.kid]: key.publicKey, [fundKey.kid]: fundKey.publicKey });
  const view: S.FundView = { exactTransfer: () => undefined, claimIncrease: () => undefined, payout: (ref) => p.payoutRecord(ref) };
  const fund = new S.FundCosigner({ fund: FUND, key: fundKey, view });
  p.book.addCosignature("2026-10", fund.cosign(st, p.handle("/settlements/2026-10").body, { resolveKey, descriptor }));
  const receipt = p.receipt(id) as S.Receipt;
  assert.equal(S.verifyReceipt(receipt, { resolveKey, descriptor, requireCosigners: [fundKey.kid] }).ok, true);
  assert.equal(JSON.parse(p.handle(`/proofs/${id}`).body).status, "included");
});

// ---- AP2: a Payment Mandate Constraint ---------------------------------------------------------

const HOLDER = "https://processor.example";
const IAT = Date.UTC(2026, 9, 1) / 1000;
const ap2Constraint = (over: Record<string, unknown> = {}) => ({
  ...S.processorConstraint({ ...policy("keep"), logs: [descriptor.log] }, { holder: HOLDER }),
  ...over,
});
const usd = (amount: number) => ({ amount, currency: "USD" });

test("AP2 constraint: AP2's own shapes, a collision-resistant type, and the schema accepts it", () => {
  const c = ap2Constraint();
  assert.deepEqual(c, { type: "com.craigmerry.solidarity", holder: HOLDER, rate: "0.01", cap: { amount: 100000, currency: "USD" }, fund: FUND, logs: [descriptor.log], refunds: "keep" });
  assert.deepEqual(S.validateSchema(S.ap2ConstraintSchema, c), []);
  assert.deepEqual(S.constraintPolicy(c as S.Ap2SolidarityConstraint, IAT), { ...policy("keep"), logs: [descriptor.log] }, "round trip, with since from iat");
  assert.throws(() => S.processorConstraint({ ...policy("keep"), logs: [descriptor.log], cap: { amount: "100", asset: "usd" } }, { holder: HOLDER }), /ISO 4217/);
  assert.throws(() => S.processorConstraint({ ...policy("keep"), logs: [descriptor.log], cap: { amount: "9007199254740993", asset: "USD" } }, { holder: HOLDER }), /safe integer/);
});

test("AP2 evaluation always passes; the holder alone gets a receipt property, and the line uses its id", () => {
  const { p, clock } = setup("keep");
  const other = p.evaluateAp2({ self: "https://network.example", owner: "o", constraint: ap2Constraint(), iat: IAT, payment: usd(4000) });
  assert.deepEqual(other, { pass: true }, "a verifier that is not the holder does nothing");

  const r = p.evaluateAp2({ self: HOLDER, owner: "owner-2", constraint: ap2Constraint(), iat: IAT, payment: usd(20000) });
  assert.equal(r.pass, true);
  assert.equal(r.receipt?.status, "pending");
  assert.deepEqual(S.validateSchema(S.ap2ReceiptSchema, r.receipt), []);
  const id = (r.receipt as { id: string }).id;
  assert.throws(() => p.recordPurchase({ owner: "owner-1", purchaseId: "x", amount: "4000", asset: "USD", id }), /reserved/, "an id belongs to its owner");
  assert.equal(p.recordPurchase({ owner: "owner-2", purchaseId: "p-ap2", amount: "20000", asset: "USD", id }), id, "the line is recorded under the promised id");
  assert.equal(p.shareAmount(id), 200n);
  assert.throws(() => p.recordPurchase({ owner: "owner-2", purchaseId: "p-again", amount: "4000", asset: "USD", id }), /reserved/, "an id is used once");
  clock.now = Date.UTC(2026, 10, 3) / 1000;
  assert.deepEqual(p.collect().collected, [id]);
  clock.now = Date.UTC(2026, 11, 2) / 1000;
  const closed = p.closePeriod("2026-11");
  assert.ok(closed, "the AP2 share's line is in the batch for the month it was collected");
  assert.ok(p.receipt(id)?.line.includes(id), "the owner fetches the receipt with the id from the Payment Receipt");
});

test("AP2 evaluation: every skip reason, each still a pass", () => {
  const { p } = setup("keep");
  const ev = (constraint: unknown, payment = usd(4000), owner = "owner-3") => p.evaluateAp2({ self: HOLDER, owner, constraint, iat: IAT, payment });
  const seen: string[] = [];
  const reason = (r: ReturnType<typeof ev>) => {
    const why = r.pass === true && r.receipt?.status === "skipped" ? r.receipt.reason : r.receipt?.status;
    if (r.receipt?.status === "skipped") seen.push(r.receipt.reason);
    return why;
  };
  assert.equal(reason(ev(ap2Constraint({ rate: "0.02" }))), "bad-policy");
  assert.equal(reason(ev(ap2Constraint({ cap: { amount: 0, currency: "USD" } }))), "bad-policy");
  assert.equal(reason(ev(ap2Constraint({ extra: 1 }))), "bad-policy");
  assert.equal(reason(ev(ap2Constraint({ logs: ["https://other.example/solidarity"] }))), "wrong-log");
  assert.equal(reason(ev(ap2Constraint({ fund: "https://elsewhere.example/fund" }))), "fund-not-allowed");
  assert.equal(reason(ev(ap2Constraint(), { amount: 4000, currency: "EUR" })), "purchase-not-supported");
  assert.equal(reason(ev(ap2Constraint(), usd(99))), "below-minimum", "1% of 99 cents floors to zero");
  const small = ap2Constraint({ cap: { amount: 50, currency: "USD" } });
  const first = ev(small, usd(4000), "owner-4");
  assert.equal(first.receipt?.status, "pending");
  p.recordPurchase({ owner: "owner-4", purchaseId: "c1", amount: "5000", asset: "USD", id: (first.receipt as { id: string }).id });
  assert.equal(reason(ev(small, usd(4000), "owner-4")), "cap-reached");
  assert.deepEqual([...new Set(seen)].sort(), [...S.AP2_SKIP_REASONS].sort(), "every reason exercised");
  assert.deepEqual([...S.ap2ReceiptSchema.properties.reason.enum], [...S.AP2_SKIP_REASONS], "the receipt schema lists exactly these");
});

test("AP2 evaluation never fails a payment, whatever it is handed", () => {
  const { p } = setup("keep");
  const junk: unknown[] = [null, undefined, 0, "x", [], {}, { holder: HOLDER }, { ...ap2Constraint(), cap: "100" }, { ...ap2Constraint(), logs: "nope" }, { ...ap2Constraint(), type: "solidarity" }, JSON.parse('{"__proto__":{"holder":"https://processor.example"}}')];
  for (const constraint of junk) {
    for (const payment of [usd(4000), { amount: -1, currency: "USD" }, { amount: 1.5, currency: "USD" }, { amount: Number.NaN, currency: "USD" }]) {
      const r = p.evaluateAp2({ self: HOLDER, owner: "owner-5", constraint, iat: IAT, payment });
      assert.equal(r.pass, true, JSON.stringify(constraint));
      if (r.receipt) assert.deepEqual(S.validateSchema(S.ap2ReceiptSchema, r.receipt), [], JSON.stringify(r.receipt));
    }
  }
});

test("AP2: a new open Payment Mandate keeps what the owner already committed this month", () => {
  const { p } = setup("keep");
  const a = ap2Constraint({ cap: { amount: 60, currency: "USD" } });
  const r1 = p.evaluateAp2({ self: HOLDER, owner: "owner-6", constraint: a, iat: IAT, payment: usd(5000) });
  p.recordPurchase({ owner: "owner-6", purchaseId: "m1", amount: "5000", asset: "USD", id: (r1.receipt as { id: string }).id });
  const b = ap2Constraint({ cap: { amount: 60, currency: "USD" }, rate: "0.005" });
  const r2 = p.evaluateAp2({ self: HOLDER, owner: "owner-6", constraint: b, iat: IAT + 86400, payment: usd(5000) });
  const id2 = (r2.receipt as { id: string }).id;
  assert.equal(p.recordPurchase({ owner: "owner-6", purchaseId: "m2", amount: "5000", asset: "USD", id: id2 }), id2);
  assert.equal(p.shareAmount(id2), 10n, "25 cents at the new rate, but only 10 left under the 60 cent cap after the first 50");
});
