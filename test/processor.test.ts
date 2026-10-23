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

// ---- AP2: a Solidarity Mandate ------------------------------------------------------------------

const HOLDER = "https://processor.example";
const IAT = Date.UTC(2026, 9, 1) / 1000;
const mandate = (over: Record<string, unknown> = {}, iat = IAT) => ({
  ...S.solidarityMandate({ ...policy("keep"), logs: [descriptor.log] }, { holder: HOLDER, iat }),
  ...over,
});
const enroll = (p: S.ProcessorHolder, m: unknown, owner = "o", self = HOLDER) => p.enrollAp2({ self, owner, mandate: m });
const status = (r: ReturnType<typeof enroll>) => (r.receipt?.status === "refused" ? r.receipt.reason : r.receipt?.status);

test("AP2 mandate: AP2's own shapes and a collision-resistant vct", () => {
  const m = mandate();
  assert.deepEqual(m, { vct: "com.craigmerry.solidarity.1", holder: HOLDER, rate: "0.01", cap: { amount: 100000, currency: "USD" }, fund: FUND, logs: [descriptor.log], refunds: "keep", iat: IAT });
  assert.deepEqual(S.validateSchema(S.ap2MandateSchema, m), []);
  assert.deepEqual(S.validateSchema(S.ap2MandateSchema, { ...m, iss: "https://ts.example", _sd_alg: "sha-256" }), [], "other SD-JWT VC claims may appear");
  assert.deepEqual(S.mandatePolicy(m), { ...policy("keep"), logs: [descriptor.log] }, "round trip, with since from iat");
});

test("AP2 enrollment: the holder enrolls and says so in its Mandate Receipt; anyone else ignores the mandate", () => {
  const { p } = setup("keep");
  assert.deepEqual(enroll(p, mandate(), "o", "https://network.example"), {}, "not the holder: no receipt property, nothing done");
  const r = enroll(p, mandate(), "owner-2");
  assert.deepEqual(r, { receipt: { status: "enrolled", log: descriptor.log } });
  assert.deepEqual(S.validateSchema(S.ap2EnrollmentSchema, r.receipt), []);
  const id = p.recordPurchase({ owner: "owner-2", purchaseId: "p-ap2", amount: "20000", asset: "USD" });
  assert.equal(p.shareAmount(id as string), 200n, "processor mode applies it to the finalized payment");
  assert.throws(() => p.enrollAp2({ self: "https://Processor.example", owner: "x", mandate: mandate() }), /lowercase/);
});

test("AP2 enrollment: every refusal reason", () => {
  const { p } = setup("keep");
  const seen: string[] = [];
  const reason = (r: ReturnType<typeof enroll>) => {
    if (r.receipt?.status === "refused") seen.push(r.receipt.reason);
    return status(r);
  };
  assert.equal(reason(enroll(p, mandate({ rate: "0.02" }))), "bad-policy");
  assert.equal(reason(enroll(p, mandate({ cap: { amount: 0, currency: "USD" } }))), "bad-policy");
  assert.equal(reason(enroll(p, mandate({ cap: { amount: 2 ** 60, currency: "USD" } }))), "bad-policy", "an unsafe integer cap");
  assert.equal(reason(enroll(p, mandate({ iat: undefined }))), "bad-policy", "iat is required in this mandate type");
  assert.equal(reason(enroll(p, mandate({ iat: 1e20 }))), "bad-policy");
  assert.equal(reason(enroll(p, mandate({ exp: IAT - 1 }))), "bad-policy", "exp before iat");
  assert.equal(reason(enroll(p, mandate({ exp: Date.UTC(2026, 9, 5) / 1000 }))), "bad-policy", "already expired");
  assert.equal(reason(enroll(p, mandate({ holder: "https://Processor.example" }))), "bad-policy", "a mixed-case holder is refused, not silently ignored");
  assert.equal(reason(enroll(p, mandate({ holder: "https://processor.example/" }))), "bad-policy", "so is a trailing slash");
  assert.equal(reason(enroll(p, mandate({ holder: "https://processor.example:443" }))), "bad-policy", "and an explicit default port");
  assert.equal(reason(enroll(p, mandate({ iat: Date.UTC(2027, 0, 1) / 1000 }))), "bad-policy", "an iat in the future");
  assert.equal(reason(enroll(p, mandate({ iat: Number.MAX_SAFE_INTEGER }))), "bad-policy", "an iat past any date");
  assert.equal(reason(enroll(p, mandate({ logs: ["https://other.example/solidarity"] }))), "wrong-log");
  assert.equal(reason(enroll(p, mandate({ fund: "https://elsewhere.example/fund" }))), "fund-not-allowed");
  assert.equal(status(enroll(p, mandate(), "owner-7")), "enrolled");
  assert.equal(reason(enroll(p, mandate({}, IAT - 60), "owner-7")), "superseded", "an older mandate never replaces a newer one");
  assert.equal(status(enroll(p, mandate(), "owner-7")), "enrolled", "a retry of the enrolled mandate gets the same answer");
  p.onCollectionReversed("owner-7");
  assert.equal(reason(enroll(p, mandate({}, IAT + 60), "owner-7")), "suspended", "a newer mandate does not lift a suspension");
  assert.equal(reason(enroll(p, mandate(), "owner-7")), "suspended", "nor does a retry");
  assert.deepEqual([...new Set(seen)].sort(), [...S.AP2_REFUSAL_REASONS].sort(), "every reason exercised");
  assert.deepEqual([...S.ap2EnrollmentSchema.properties.reason.enum], [...S.AP2_REFUSAL_REASONS]);
});

test("AP2 enrollment never throws on the mandate's content", () => {
  const { p } = setup("keep");
  const junk: unknown[] = [null, undefined, 0, "x", [], {}, { holder: HOLDER }, { ...mandate(), cap: "100" }, { ...mandate(), logs: "nope" }, { ...mandate(), vct: "solidarity" },
    { ...mandate(), iat: Number.NaN }, { ...mandate(), exp: "soon" }, JSON.parse('{"__proto__":{"holder":"https://processor.example"}}')];
  for (const m of junk) {
    const r = enroll(p, m, "owner-5");
    if (r.receipt) assert.deepEqual(S.validateSchema(S.ap2EnrollmentSchema, r.receipt), [], JSON.stringify(r.receipt));
  }
});

test("AP2: a newer mandate replaces the policy for its currency, keeps the month's commitments, and never rewrites earlier shares", () => {
  const { p, clock } = setup("net");
  assert.equal(status(enroll(p, mandate({ cap: { amount: 60, currency: "USD" }, refunds: "net" }), "owner-6")), "enrolled");
  const a = p.recordPurchase({ owner: "owner-6", purchaseId: "m1", amount: "5000", asset: "USD" }) as string;
  assert.equal(p.shareAmount(a), 50n);
  assert.equal(status(enroll(p, mandate({ cap: { amount: 60, currency: "USD" }, rate: "0.005", refunds: "keep" }, IAT + 86400), "owner-6")), "enrolled");
  const b = p.recordPurchase({ owner: "owner-6", purchaseId: "m2", amount: "5000", asset: "USD" }) as string;
  assert.equal(p.shareAmount(b), 10n, "25 cents at the new rate, but only 10 left under the 60 cent cap after the first 50");
  assert.ok(p.refund({ purchaseId: "m1", refunded: "5000" }).credit > 0n, "the first share keeps its own net rule and 1% rate");
  assert.equal(p.refund({ purchaseId: "m2", refunded: "5000" }).credit, 0n, "the second keeps its own keep rule");
  void clock;
});

test("AP2: one policy per currency; a policy ends at its exp", () => {
  const { p, clock } = setup("keep");
  assert.equal(status(enroll(p, mandate({ cap: { amount: 90, currency: "USD" } }), "owner-8")), "enrolled");
  assert.equal(status(enroll(p, mandate({ cap: { amount: 10, currency: "JPY" } }, IAT + 1), "owner-8")), "enrolled", "a JPY mandate is a separate policy");
  assert.equal(p.shareAmount(p.recordPurchase({ owner: "owner-8", purchaseId: "u1", amount: "9000", asset: "USD" }) as string), 90n);
  assert.equal(p.shareAmount(p.recordPurchase({ owner: "owner-8", purchaseId: "j1", amount: "1000", asset: "JPY" }) as string), 10n, "the USD shares never count against the JPY cap");
  assert.equal(p.recordPurchase({ owner: "owner-8", purchaseId: "e1", amount: "1000", asset: "EUR" }), undefined, "no policy for EUR");
  assert.equal(status(enroll(p, mandate({ exp: Date.UTC(2026, 9, 20) / 1000 }), "owner-9")), "enrolled");
  clock.now = Date.UTC(2026, 9, 21) / 1000;
  assert.equal(p.recordPurchase({ owner: "owner-9", purchaseId: "x1", amount: "9000", asset: "USD" }), undefined, "past exp: no share");
});

test("AP2: the owner can stop a policy at once, and a newer mandate starts it again", () => {
  const { p } = setup("keep");
  assert.equal(status(enroll(p, mandate(), "owner-10")), "enrolled");
  assert.ok(p.recordPurchase({ owner: "owner-10", purchaseId: "s1", amount: "5000", asset: "USD" }));
  assert.equal(p.stop("owner-10", "USD"), true);
  assert.equal(p.stop("owner-10", "EUR"), false, "no EUR policy to stop");
  assert.equal(p.recordPurchase({ owner: "owner-10", purchaseId: "s2", amount: "5000", asset: "USD" }), undefined, "stopped: no share");
  assert.equal(status(enroll(p, mandate(), "owner-10")), "enrolled", "a retry of the old mandate is answered, but does not restart it");
  assert.equal(p.recordPurchase({ owner: "owner-10", purchaseId: "s3", amount: "5000", asset: "USD" }), undefined);
  assert.equal(status(enroll(p, mandate({}, IAT + 60), "owner-10")), "enrolled");
  assert.ok(p.recordPurchase({ owner: "owner-10", purchaseId: "s4", amount: "5000", asset: "USD" }), "a newer mandate is a new consent");
});
