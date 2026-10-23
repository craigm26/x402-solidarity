import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getAddress, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as S from "../src/solidarity/index.ts";
import { transferWithAuthorizationTypes } from "../src/solidarity/constants.ts";
import type { LogDescriptor, OwnerPolicy, PaymentRequirements, SolidarityInfo } from "../src/solidarity/index.ts";
import { conformance, x402File } from "./helpers.ts";

const USDC = S.USDC_BASE_SEPOLIA.address;
const NET = "eip155:84532";
const LOG = "https://log.example/solidarity";
const DESCRIPTOR: LogDescriptor = conformance("payloads.json").descriptor;
const POLICY: OwnerPolicy = conformance("payloads.json").policy;
const NOW = Date.UTC(2026, 11, 10, 12) / 1000;
const declared: SolidarityInfo = { version: 2, logs: [{ network: NET, scheme: "exact", log: LOG }] };
const req = (amount: string, scheme = "exact", extra: Record<string, unknown> = {}): PaymentRequirements => ({
  scheme,
  network: NET,
  amount,
  asset: USDC,
  payTo: "0x2222222222222222222222222222222222222222",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2", ...extra },
});

function ctx(policy: OwnerPolicy = POLICY) {
  const signer = privateKeyToAccount(generatePrivateKey());
  return { policy, counter: new S.CapCounter(policy), signer, descriptor: DESCRIPTOR, now: NOW };
}

test("USDC on Base Sepolia: address and EIP-712 domain as the x402 repo lists them", { skip: !x402File("typescript/packages/mechanisms/evm/src/defaultAssets.ts") && "x402 repository not found: set X402_DIR (README, \"Run it\")" }, () => {
  const src = readFileSync(x402File("typescript/packages/mechanisms/evm/src/defaultAssets.ts") as string, "utf8");
  const block = src.slice(src.indexOf('"eip155:84532"'), src.indexOf("// Base Sepolia USDC"));
  assert.match(block, new RegExp(`asset: "${S.USDC_BASE_SEPOLIA.address}"`));
  assert.match(block, /name: "USDC"/);
  assert.match(block, /version: "2"/);
  assert.match(block, /decimals: 6/);
  const legacy = readFileSync(x402File("typescript/packages/legacy/x402/src/types/shared/evm/config.ts") as string, "utf8");
  assert.match(legacy, new RegExp(`"84532": \\{\\s*usdcAddress: "${S.USDC_BASE_SEPOLIA.address}",\\s*usdcName: "USDC"`));
  const bs = readFileSync(x402File("typescript/packages/mechanisms/evm/src/batch-settlement/constants.ts") as string, "utf8");
  assert.match(bs, new RegExp(`BATCH_SETTLEMENT_ADDRESS = "${S.BATCH_SETTLEMENT_ADDRESS}"`));
  assert.match(bs, /name: "x402 Batch Settlement",\s*version: "1"/);
});

test("an exact share's validBefore: after the purchase's, within the bound the log checks; no share when none fits", async () => {
  const c = ctx();
  const ok = await S.buildShare(c, { declared, accepted: req("48000000"), purchaseWindow: { validAfter: String(NOW - 60), validBefore: String(NOW + 60) } });
  assert.ok(ok.attached);
  if (ok.attached) {
    const vb = Number((ok.info.payment as { payload: { authorization: { validBefore: string } } }).payload.authorization.validBefore);
    const shareMax = DESCRIPTOR.accepts?.[0].maxTimeoutSeconds as number;
    assert.ok(vb >= NOW + 60 + shareMax, "at least the share's timeout after the purchase's validBefore");
    assert.ok(vb <= NOW + 60 + shareMax, "at most the purchase's timeout plus the share's after signing");
  }
  const long = await S.buildShare(ctx(), { declared, accepted: req("48000000"), purchaseWindow: { validAfter: String(NOW - 60), validBefore: String(NOW + 3600) } });
  assert.equal(long.attached, false, "a purchase window longer than its own maxTimeoutSeconds leaves no valid share window");
  if (!long.attached) assert.match(long.why, /maxTimeoutSeconds/);
});

test("separate mode: an exact share for a 48 USDC purchase, signed with EIP-3009", async () => {
  const c = ctx();
  const window = { validAfter: String(NOW - 60), validBefore: String(NOW + 30) };
  const d = await S.buildShare(c, { declared, accepted: req("48000000"), purchaseWindow: window });
  assert.ok(d.attached);
  if (!d.attached) return;
  assert.equal(d.kind, "exact");
  assert.equal(d.amount, 48000n);
  const info = d.info;
  assert.deepEqual(info.logs, declared.logs, "logs echoed unchanged");
  assert.equal(info.log, LOG);
  assert.equal(info.rate, "0.001");
  assert.equal(info.fund, POLICY.fund);
  assert.ok(S.isValidShareId(info.id));
  const pay = info.payment as NonNullable<SolidarityInfo["payment"]>;
  assert.equal(pay.accepted.payTo, "0x000000000000000000000000000000000000f00d");
  assert.equal(pay.accepted.amount, "48000");
  assert.deepEqual(pay.accepted.extra, { name: "USDC", version: "2" });
  const p = pay.payload as unknown as S.ExactEip3009Payload;
  assert.equal(p.authorization.from, c.signer.address);
  assert.equal(getAddress(p.authorization.to), getAddress("0x000000000000000000000000000000000000f00d"));
  assert.equal(p.authorization.value, "48000");
  assert.equal(p.authorization.validBefore, String(NOW + 30 + 60), "maxTimeoutSeconds after the purchase's validBefore");
  assert.equal(p.authorization.nonce, S.shareNonce(info.id as string), "the nonce binds the id");
  // Independent check with viem directly, domain spelled out.
  const ok = await verifyTypedData({
    address: c.signer.address,
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: getAddress(USDC) },
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: { from: p.authorization.from, to: p.authorization.to, value: 48000n, validAfter: BigInt(p.authorization.validAfter), validBefore: BigInt(p.authorization.validBefore), nonce: p.authorization.nonce },
    signature: p.signature,
  });
  assert.ok(ok);
  assert.deepEqual(S.validateSolidarity({ info, schema: S.solidaritySchema }), { valid: true });
  assert.equal(c.counter.left("2026-12"), 5000000n - 48000n, "counted when signed");
});

test("below the exact minimum with no channel: no share; with a channel: a batch-settlement voucher", async () => {
  const c = ctx();
  const none = await S.buildShare(c, { declared, accepted: req("2000000") });
  assert.equal(none.attached, false);
  const account = c.signer;
  const config = { payer: account.address, payerAuthorizer: account.address, receiver: "0x000000000000000000000000000000000000f00d" as const, receiverAuthorizer: "0x3333333333333333333333333333333333333333" as const, token: USDC as `0x${string}`, withdrawDelay: 86400, salt: `0x${"0".repeat(63)}7` as `0x${string}` };
  const ch = S.openClientChannel(NET, config);
  ch.chargedCumulativeAmount = "1500";
  const d = await S.buildShare(c, { declared, accepted: req("2000000"), channel: ch });
  assert.ok(d.attached && d.kind === "batch-settlement");
  if (!d.attached) return;
  const p = (d.info.payment as NonNullable<SolidarityInfo["payment"]>).payload as unknown as S.BatchVoucherPayload;
  assert.equal(p.voucher.maxClaimableAmount, "3500", "chargedCumulativeAmount + amount");
  assert.equal(p.voucher.channelId, S.computeChannelId(config, NET));
  assert.ok(await S.verifyVoucherSignature(config, p.voucher, NET));
  assert.equal(ch.busy, true, "serialized per channel");
  const again = await S.buildShare(c, { declared, accepted: req("2000000"), channel: ch });
  assert.equal(again.attached, false);
  S.applyOutcomeToChannel(ch, { status: "accepted", id: d.info.id as string, log: LOG, period: "2026-12", amount: "2000", channel: { channelId: ch.channelId, chargedCumulativeAmount: "3500" } });
  assert.equal(ch.busy, false);
  assert.equal(ch.chargedCumulativeAmount, "3500");
});

test("the cap: a share is lowered when the cap is nearly used, and stops at zero", async () => {
  const c = ctx({ ...POLICY, cap: { ...POLICY.cap, amount: "60000" } });
  const a = await S.buildShare(c, { declared, accepted: req("48000000") });
  assert.ok(a.attached && a.amount === 48000n);
  const b = await S.buildShare(c, { declared, accepted: req("48000000") });
  assert.ok(b.attached && b.amount === 12000n, "lowered to what is left");
  const z = await S.buildShare(c, { declared, accepted: req("48000000") });
  assert.equal(z.attached, false);
});

test("which purchases can carry a share", () => {
  assert.deepEqual(S.shareKindsFor(req("1")), ["exact", "batch-settlement"]);
  assert.deepEqual(S.shareKindsFor(req("1", "exact", { paymentFlow: "upfront" })), ["exact", "batch-settlement"]);
  assert.deepEqual(S.shareKindsFor(req("1", "upto")), ["batch-settlement"]);
  assert.deepEqual(S.shareKindsFor({ ...req("1", "upto"), network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }), [], "SVM upto defaults to escrow");
  assert.deepEqual(S.shareKindsFor(req("1", "auth-capture")), [], "auth-capture defaults to escrow");
  assert.deepEqual(S.shareKindsFor(req("1", "auth-capture", { paymentFlow: "authorization" })), ["batch-settlement"]);
  assert.deepEqual(S.shareKindsFor(req("1", "batch-settlement")), [], "the log never sees a batch-settlement purchase's charge");
  assert.deepEqual(S.shareKindsFor(req("1", "something-else")), []);
});

test("advertisement: appended to the seller's declaration, never overwriting it", async () => {
  const c = ctx();
  const extensions: Record<string, unknown> = { [S.SOLIDARITY]: S.declareSolidarityExtension([{ network: NET, scheme: "exact", log: LOG }]), other: { info: { x: 1 } } };
  const before = structuredClone(extensions);
  const d = await S.appendSolidarityToExtensions(extensions, c, { accepted: req("48000000") });
  assert.ok(d.attached);
  const ext = extensions[S.SOLIDARITY] as S.SolidarityExtension;
  assert.deepEqual(ext.schema, (before[S.SOLIDARITY] as S.SolidarityExtension).schema);
  assert.deepEqual(ext.info.logs, (before[S.SOLIDARITY] as S.SolidarityExtension).info.logs);
  assert.deepEqual(extensions.other, before.other);
  // No declaration and no fallback: nothing added.
  const empty: Record<string, unknown> = {};
  assert.equal((await S.appendSolidarityToExtensions(empty, c, { accepted: req("48000000") })).attached, false);
  assert.deepEqual(empty, {});
});

test("fallback: only batch-settlement, never exact; adds the extension with its schema", async () => {
  const c = ctx();
  const ext: Record<string, unknown> = {};
  const noChannel = await S.appendSolidarityToExtensions(ext, c, { accepted: req("48000000"), fallbackLog: LOG });
  assert.equal(noChannel.attached, false, "exact is never used in the fallback");
  const config = { payer: c.signer.address, payerAuthorizer: c.signer.address, receiver: "0x000000000000000000000000000000000000f00d" as const, receiverAuthorizer: "0x3333333333333333333333333333333333333333" as const, token: USDC as `0x${string}`, withdrawDelay: 86400, salt: `0x${"0".repeat(63)}1` as `0x${string}` };
  const d = await S.appendSolidarityToExtensions(ext, c, { accepted: req("48000000"), fallbackLog: LOG, channel: S.openClientChannel(NET, config) });
  assert.ok(d.attached && d.kind === "batch-settlement");
  const e = ext[S.SOLIDARITY] as S.SolidarityExtension;
  assert.equal(e.info.logs, undefined);
  assert.deepEqual(e.schema, S.solidaritySchema);
});

test("the owner's logs, the fund's network and the log's allow-list are respected", async () => {
  const c = ctx({ ...POLICY, logs: ["https://someone-else.example/solidarity"] });
  assert.equal((await S.buildShare(c, { declared, accepted: req("48000000") })).attached, false);
  const c2 = ctx({ ...POLICY, fund: "eip155:8453:0x000000000000000000000000000000000000f00d" });
  assert.equal((await S.buildShare(c2, { declared, accepted: req("48000000") })).attached, false);
  const c3 = ctx({ ...POLICY, fund: "eip155:84532:0x000000000000000000000000000000000000dead" });
  assert.equal((await S.buildShare(c3, { declared, accepted: req("48000000") })).attached, false);
  const c4 = ctx({ ...POLICY, refunds: "net" });
  const net = await S.buildShare(c4, { declared, accepted: req("48000000") });
  assert.ok(!net.attached && /keep only/.test(net.why), "never rejects: no share, and the purchase goes ahead");
});

test("exactly one policy holder: no share under a mandate whose holder is someone else", async () => {
  const c = ctx();
  const d = await S.buildShare(c, { declared, accepted: req("48000000"), mandateHolder: "https://processor.example", self: "agent-1" });
  assert.equal(d.attached, false);
  const cp = "https://processor.example";
  const mandates = [{ vct: S.AP2_MANDATE_VCT, holder: cp }];
  assert.equal(S.mayAttachShare(mandates, "agent-1", cp), false, "the holder provides this payment's credential: no second share");
  assert.equal(S.mayAttachShare(mandates, "agent-1", undefined), true, "an x402 payment the client signs itself: the holder never sees it");
  assert.equal(S.mayAttachShare(mandates, "agent-1", "https://other-cp.example"), true, "another credential provider is not the holder");
  assert.equal(S.mayAttachShare(mandates, cp, cp), true, "the holder itself");
  assert.equal(S.mayAttachShare([{ vct: "mandate.payment.open.1" }], "agent-1", cp), true, "other mandates don't name a holder");
  assert.equal(S.mayAttachShare({ vct: S.AP2_MANDATE_VCT, holder: cp }, "agent-1", cp), false, "a single mandate, not in a list");
  assert.equal(S.mayAttachShare(mandates, "agent-1", "https://Processor.example/"), false, "the provider written another way is still the holder");
  for (const junk of [undefined, null, "x", [null, 1, "x"]]) assert.equal(S.mayAttachShare(junk, "agent-1", cp), true, JSON.stringify(junk));
  assert.equal(S.mayAttachShare([], "agent-1"), true);
});

test("processor mode fields: the Solidarity Mandate carries the policy", () => {
  const iat = Date.UTC(2026, 9, 21, 9, 12) / 1000;
  const m = S.solidarityMandate({ ...POLICY, cap: { amount: "500", asset: "USD" }, fund: "https://fund.example/solidarity", refunds: "net" }, { holder: "https://processor.example", iat, logs: ["https://processor.example/solidarity"] });
  assert.deepEqual(m, { vct: "com.craigmerry.solidarity.1", holder: "https://processor.example", rate: "0.001", cap: { amount: 500, currency: "USD" }, fund: "https://fund.example/solidarity", logs: ["https://processor.example/solidarity"], refunds: "net", iat });
  assert.deepEqual(S.validateSchema(S.ap2MandateSchema, m), []);
  assert.equal(S.mandatePolicy(m).since, "2026-10-21T09:12:00Z");
  assert.deepEqual(conformance("policies.json").solidarityMandate.cap, { amount: 500, currency: "USD" }, "an AP2 Amount: integer minor units of USD");
  const opts = { holder: "https://processor.example", iat };
  assert.throws(() => S.solidarityMandate({ ...POLICY, logs: undefined }, opts), /logs/);
  assert.throws(() => S.solidarityMandate({ ...POLICY, cap: { amount: "500", asset: "usd" } }, opts), /ISO 4217/);
  assert.throws(() => S.solidarityMandate({ ...POLICY, cap: { amount: "9007199254740993", asset: "USD" } }, opts), /safe integer/);
  assert.throws(() => S.solidarityMandate({ ...POLICY, cap: { amount: "500", asset: "USD" } }, { ...opts, holder: "https://Processor.example" }), /lowercase/);
  assert.throws(() => S.solidarityMandate({ ...POLICY, cap: { amount: "500", asset: "USD" } }, { ...opts, exp: iat }), /exp after iat/);
});

test("declaration helper rejects malformed or duplicate logs entries", () => {
  assert.throws(() => S.declareSolidarityExtension([{ network: NET, scheme: "exact", log: "http://x" }]));
  assert.throws(() => S.declareSolidarityExtension([{ network: NET, scheme: "exact", log: LOG }, { network: NET, scheme: "exact", log: LOG }]));
  assert.equal(S.conventionalLogUrl("https://facilitator.example/"), "https://facilitator.example/solidarity");
});

test("the cap's asset and the fund's network decide: no share in another asset, or for a fund on another chain", async () => {
  const OTHER = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const withOther: LogDescriptor = { ...DESCRIPTOR, accepts: [...(DESCRIPTOR.accepts ?? []), { network: NET, asset: OTHER.toLowerCase(), scheme: "exact", maxTimeoutSeconds: 60, minAmount: "1", extra: { name: "USD Coin", version: "2" } }] };
  const c = { ...ctx(), descriptor: withOther };
  const other = await S.buildShare(c, { declared, accepted: { ...req("48000000"), asset: OTHER } });
  assert.ok(!other.attached && /another asset/.test(other.why), "the log lists that asset; only the cap's asset rule refuses it");
  assert.ok((await S.buildShare(c, { declared, accepted: req("48000000") })).attached, "the cap's own asset still works");
  const onBase = "eip155:8453:0x000000000000000000000000000000000000f00d";
  assert.ok(DESCRIPTOR.funds.includes(onBase), "the log lists the fund; only the network rule refuses it");
  const d = await S.buildShare(ctx({ ...POLICY, fund: onBase }), { declared, accepted: req("48000000") });
  assert.ok(!d.attached && /another network/.test(d.why));
});
