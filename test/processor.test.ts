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
