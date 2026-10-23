/**
 * The buyer's extension inside a real x402Client with @x402/evm's ExactEvmScheme.
 * SIMULATED: throwaway keys, a placeholder fund, nothing sent.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { CapCounter, declareSolidarityExtension, generateSigningKey, openClientChannel, shareNonce } from "../../../src/solidarity/index.ts";
import type { ExactEip3009Payload, LogDescriptor, OwnerPolicy, ShareDecision, SolidarityInfo, TypedDataSigner } from "../../../src/solidarity/index.ts";
import { solidarityClientExtension } from "../src/client.ts";
import type { SolidarityClientOptions } from "../src/client.ts";
import { createDescriptorCache } from "../src/descriptors.ts";
import { AUTHORIZER, FUND_ADDR, LOG, makeDescriptor, makePolicy, NET, resetTime, T0, USDC, useSimulatedTime } from "./harness.ts";

beforeEach(() => useSimulatedTime());
afterEach(() => resetTime());

const SELLER = "0x2222222222222222222222222222222222222222";
const descriptor: LogDescriptor = makeDescriptor(generateSigningKey("EdDSA", "did:web:facilitator.example#solidarity-1").kid);

function paymentRequired(extensions?: Record<string, unknown>): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "https://books.example/report", description: "", mimeType: "" },
    accepts: [{ scheme: "exact", network: NET, amount: "500000", asset: USDC, payTo: SELLER, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
    ...(extensions ? { extensions } : {}),
  } as PaymentRequired;
}
const declared = () => ({ solidarity: declareSolidarityExtension([{ network: NET, scheme: "exact", log: LOG }]) });

function setup(over: Partial<SolidarityClientOptions> = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const policy = makePolicy();
  const counter = new CapCounter(policy);
  const decisions: ShareDecision[] = [];
  const errors: unknown[] = [];
  const opts: SolidarityClientOptions = {
    policy,
    counter,
    signer: account,
    descriptors: createDescriptorCache({ preload: [descriptor] }),
    onDecision: (d) => decisions.push(d),
    onError: (e) => errors.push(e),
    ...over,
  };
  const ext = solidarityClientExtension(opts);
  const client = new x402Client();
  client.register(NET, new ExactEvmClient(account));
  client.registerExtension(ext);
  return { account, policy, counter, decisions, errors, ext, client };
}

const infoOf = (pp: PaymentPayload) => (pp.extensions?.solidarity as { info: SolidarityInfo } | undefined)?.info;

test("the share is added after the purchase is signed, with the purchase's window, and the declaration is left alone", async () => {
  const { client, counter, account } = setup();
  const pr = paymentRequired(declared());
  const pp = await client.createPaymentPayload(pr);

  const info = infoOf(pp);
  assert.ok(info?.payment);
  assert.deepEqual(Object.keys(info).sort(), ["fund", "id", "log", "logs", "payment", "rate", "version"]);
  assert.equal(info.log, LOG);
  assert.equal(info.rate, "0.001");
  const share = info.payment.payload as unknown as ExactEip3009Payload;
  const purchase = pp.payload as unknown as ExactEip3009Payload;
  assert.equal(share.authorization.validAfter, purchase.authorization.validAfter);
  assert.equal(share.authorization.validAfter, "0", "the SDK's purchase window starts at 0");
  assert.equal(BigInt(share.authorization.validBefore), BigInt(purchase.authorization.validBefore) + 60n);
  assert.equal(BigInt(purchase.authorization.validBefore), BigInt(T0 / 1000 + 60));
  assert.equal(share.authorization.to.toLowerCase(), FUND_ADDR);
  assert.equal(share.authorization.from, account.address);
  assert.equal(share.authorization.value, "500");
  assert.equal(share.authorization.nonce, shareNonce(info.id as string));
  assert.equal(info.payment.accepted.payTo.toLowerCase(), FUND_ADDR);
  // The seller's declaration is untouched (the SDK hands the payload that very object).
  assert.deepEqual(Object.keys((pr.extensions?.solidarity as { info: object }).info), ["version", "logs"]);

  // The same PaymentRequired again (as @x402/fetch does on its recovery path): a new share.
  const again = await client.createPaymentPayload(pr);
  const info2 = infoOf(again);
  assert.ok(info2?.payment);
  assert.notEqual(info2.id, info.id);
  assert.equal(counter.committed("2026-10"), 1000n);
});

test("no declaration and no fallback: the payload is exactly what plain x402 builds", async () => {
  const { client, decisions } = setup();
  const pp = await client.createPaymentPayload(paymentRequired());
  assert.equal(pp.extensions, undefined);
  assert.deepEqual(decisions, []);
});

test("fallback: only a batch-settlement share on a channel, never exact", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const config = {
    payer: account.address,
    payerAuthorizer: account.address,
    receiver: FUND_ADDR as `0x${string}`,
    receiverAuthorizer: AUTHORIZER as `0x${string}`,
    token: USDC,
    withdrawDelay: 86400,
    salt: `0x${"02".padStart(64, "0")}` as `0x${string}`,
  };
  // No channel: the exact kind is never used in the fallback, so no share.
  const noChannel = setup({ signer: account, fallbackLog: () => LOG });
  const a = await noChannel.client.createPaymentPayload(paymentRequired());
  assert.equal(a.extensions, undefined);
  assert.equal(noChannel.decisions[0]?.attached, false);

  const channel = openClientChannel(NET, config);
  const withChannel = setup({ signer: account, fallbackLog: () => LOG, channelFor: () => channel });
  const b = await withChannel.client.createPaymentPayload(paymentRequired());
  const info = infoOf(b);
  assert.equal(info?.payment?.accepted.scheme, "batch-settlement");
  assert.equal(info?.logs, undefined, "nothing was declared, so there are no logs to echo");
  assert.equal(channel.busy, true, "the channel waits for this share's outcome");
});

test("a seller info with any field beyond version and logs gets no share", async () => {
  const { client, decisions } = setup();
  const ext = declareSolidarityExtension([{ network: NET, scheme: "exact", log: LOG }]);
  (ext.info as unknown as Record<string, unknown>).rate = "0.01";
  const pp = await client.createPaymentPayload(paymentRequired({ solidarity: ext }));
  assert.equal(infoOf(pp)?.payment, undefined);
  assert.equal(decisions[0]?.attached, false);
});

test("a missing descriptor: no share, the purchase goes ahead, and a refresh starts without being awaited", async () => {
  let started = 0;
  const { client, decisions, counter } = setup({
    descriptors: {
      get: () => undefined,
      refresh: () => {
        started += 1;
        return new Promise<void>(() => undefined); // never settles: the purchase must not wait for it
      },
    },
  });
  const pp = await client.createPaymentPayload(paymentRequired(declared()));
  assert.ok(pp.payload, "the purchase was signed");
  assert.equal(infoOf(pp)?.payment, undefined);
  assert.equal(started, 1);
  assert.equal(decisions[0]?.attached, false);
  assert.equal(counter.committed("2026-10"), 0n);
});

test("a throwing descriptor source or share signer still gives a good purchase, without a share", async () => {
  const boom = setup({ descriptors: { get: () => { throw new Error("cache exploded"); } } });
  const a = await boom.client.createPaymentPayload(paymentRequired(declared()));
  assert.ok(a.payload);
  assert.equal(infoOf(a)?.payment, undefined);
  assert.equal(boom.errors.length, 1);

  const badSigner: TypedDataSigner = { address: privateKeyToAccount(generatePrivateKey()).address, signTypedData: async () => { throw new Error("hardware key unplugged"); } };
  const s = setup({ signer: badSigner });
  const b = await s.client.createPaymentPayload(paymentRequired(declared()));
  assert.ok(b.payload);
  assert.equal(infoOf(b)?.payment, undefined);
  assert.match((s.decisions[0] as { why: string }).why, /signing failed/);
  assert.equal(s.counter.committed("2026-10"), 0n, "nothing was signed, so nothing is counted");
});

test("the owner's rules: untrusted log, a mandate held by another party, policy off", async () => {
  const untrusted = setup({ policy: makePolicy({ logs: ["https://someone-else.example/solidarity"] }) });
  const a = await untrusted.client.createPaymentPayload(paymentRequired(declared()));
  assert.equal(infoOf(a)?.payment, undefined);

  const mandated = setup({ self: "https://agent.example", mandateHolder: "https://processor.example" });
  const b = await mandated.client.createPaymentPayload(paymentRequired(declared()));
  assert.equal(infoOf(b)?.payment, undefined);

  const off = setup();
  off.counter.turnOff();
  const c = await off.client.createPaymentPayload(paymentRequired(declared()));
  assert.equal(infoOf(c)?.payment, undefined);
  assert.equal(off.counter.committed("2026-10"), 0n);
});

const outcomeFor = (id: string) => ({ success: true, transaction: "0x01", network: NET, extensions: { solidarity: { info: { status: "accepted", id, log: LOG, period: "2026-10", amount: "500" } } } });
type ResponseHook = (d: unknown, ctx: never) => Promise<unknown>;
const responseHook = (ext: ReturnType<typeof setup>["ext"]) => ext.hooks?.onPaymentResponse as unknown as ResponseHook;

test("onPaymentResponse reports the outcome and never asks the transport to retry", async () => {
  const outcomes: unknown[] = [];
  const { client, ext } = setup({ onOutcome: (o) => outcomes.push(o) });
  const hook = responseHook(ext);
  const pp = await client.createPaymentPayload(paymentRequired(declared()));
  const settleResponse = outcomeFor(infoOf(pp)?.id as string);
  assert.equal(await hook(undefined, { paymentPayload: pp, requirements: pp.accepted, settleResponse } as never), undefined);
  // An outcome for some other id is ignored: the entry is unsigned and relayed by the seller.
  const pp2 = await client.createPaymentPayload(paymentRequired(declared()));
  const forged = outcomeFor("x".repeat(22));
  assert.equal(await hook(undefined, { paymentPayload: pp2, requirements: pp2.accepted, settleResponse: forged } as never), undefined);
  // A second response for a share already answered is not reported again.
  assert.equal(await hook(undefined, { paymentPayload: pp, requirements: pp.accepted, settleResponse } as never), undefined);
  assert.deepEqual(outcomes, [settleResponse.extensions.solidarity.info, undefined]);
});

test("a seller that pre-fills a share in its declaration: no share is added, and its outcome is never reported as the owner's", async () => {
  // The seller's "declaration" is a complete share, signed by a key of its own.
  const sellerSide = setup();
  const sellers = await sellerSide.client.createPaymentPayload(paymentRequired(declared()));
  const prefilled = sellers.extensions?.solidarity as { info: SolidarityInfo; schema: unknown };
  assert.ok(prefilled.info.payment);

  const outcomes: unknown[] = [];
  const buyer = setup({ onOutcome: (o) => outcomes.push(o) });
  const pp = await buyer.client.createPaymentPayload(paymentRequired({ solidarity: structuredClone(prefilled) }));
  assert.equal(buyer.decisions[0]?.attached, false, "the extension refused");
  // x402Client keeps the seller's fields, so the payload still carries the seller's share...
  assert.equal(infoOf(pp)?.id, prefilled.info.id);
  // ...but the owner is never told its outcome.
  const settleResponse = outcomeFor(prefilled.info.id as string);
  assert.equal(await responseHook(buyer.ext)(undefined, { paymentPayload: pp, requirements: pp.accepted, settleResponse } as never), undefined);
  assert.deepEqual(outcomes, []);
  assert.equal(buyer.counter.committed("2026-10"), 0n);
});

test("an onError that throws changes nothing: the purchase is still signed, without a share", async () => {
  const s = setup({
    descriptors: { get: () => { throw new Error("cache exploded"); } },
    onError: () => { throw new Error("the reporter exploded too"); },
  });
  const pp = await s.client.createPaymentPayload(paymentRequired(declared()));
  assert.ok(pp.payload, "the purchase was signed");
  assert.equal(infoOf(pp)?.payment, undefined);
});

test("the HTTP 402 hook warms the descriptor cache and returns at once", async () => {
  const fetched: string[] = [];
  const cache = createDescriptorCache({
    fetch: async (url) => {
      fetched.push(url);
      return new Response(JSON.stringify(descriptor), { headers: { "content-type": "application/json" } });
    },
  });
  const { ext } = setup({ descriptors: cache });
  const hook = (ext.transportHooks?.http as { onPaymentRequired: (d: unknown, c: unknown) => Promise<unknown> }).onPaymentRequired;
  assert.equal(await hook(declared().solidarity, { paymentRequired: paymentRequired(declared()), requestUrl: "https://books.example/report" }), undefined);
  assert.deepEqual(fetched, [LOG], "the fetch started");
  await new Promise((r) => setTimeout(r, 20)); // real timers: only Date is mocked
  assert.equal(cache.get(LOG)?.log, LOG, "and finished in the background");
  assert.deepEqual(fetched, [LOG]);
});

type RequiredHook = (d: unknown, c: unknown) => Promise<unknown>;
const requiredHook = (ext: ReturnType<typeof setup>["ext"]) => (ext.transportHooks?.http as { onPaymentRequired: RequiredHook }).onPaymentRequired;

test("the 402 hook never fetches a log the owner does not trust", async () => {
  const fetched: string[] = [];
  const cache = createDescriptorCache({ fetch: async (url) => (fetched.push(url), new Response(JSON.stringify({ ...descriptor, log: url }))) });
  const { ext } = setup({ descriptors: cache }); // the policy lists LOG only
  const other = declareSolidarityExtension([{ network: NET, scheme: "exact", log: "https://untrusted.example/solidarity" }]);
  await requiredHook(ext)(other, { paymentRequired: paymentRequired({ solidarity: other }), requestUrl: "https://books.example/report" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fetched, []);
});

/** A declaration as a hostile seller would send it: any number of logs, even several per (network, scheme). */
const rawDeclaration = (logs: Array<{ network: string; scheme: string; log: string }>) => ({ info: { version: 2, logs }, schema: declareSolidarityExtension([]).schema });

test("one 402 starts few descriptor fetches: only logs for what it offers, at most four, and eight in flight", async () => {
  const fetched: string[] = [];
  const cache = createDescriptorCache({ fetch: async (url) => (fetched.push(url), new Response(JSON.stringify({ ...descriptor, log: url }))) });
  const { logs: _drop, ...noLogs } = makePolicy(); // a policy that trusts any log
  const { ext } = setup({ policy: noLogs as OwnerPolicy, descriptors: cache });
  const hook = requiredHook(ext);
  const many = rawDeclaration(Array.from({ length: 50 }, (_, i) => ({ network: NET, scheme: "exact", log: `https://log-${i}.example/solidarity` })));
  await hook(many, { paymentRequired: paymentRequired({ solidarity: many }), requestUrl: "https://books.example/report" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetched.length, 4);
  // A log for a (network, scheme) this 402 does not offer is never fetched.
  fetched.length = 0;
  const elsewhere = declareSolidarityExtension([{ network: "eip155:1", scheme: "exact", log: "https://elsewhere.example/solidarity" }]);
  await hook(elsewhere, { paymentRequired: paymentRequired({ solidarity: elsewhere }), requestUrl: "https://books.example/report" });
  assert.deepEqual(fetched, []);

  // Fetches that never finish: two 402s fill the eight slots, and a third starts none.
  let started = 0;
  const stuck = setup({ policy: noLogs as OwnerPolicy, descriptors: { get: () => undefined, refresh: () => ((started += 1), new Promise<void>(() => undefined)) } });
  for (let round = 0; round < 3; round++) {
    const decl = rawDeclaration(Array.from({ length: 10 }, (_, i) => ({ network: NET, scheme: "exact", log: `https://r${round}-${i}.example/solidarity` })));
    await requiredHook(stuck.ext)(decl, { paymentRequired: paymentRequired({ solidarity: decl }), requestUrl: "https://books.example/report" });
  }
  assert.equal(started, 8);
});

test("the descriptor cache serves a stale entry at once and refreshes it behind; it keeps at most maxEntries fetched ones", async () => {
  let t = 1_000;
  const fetched: string[] = [];
  const pinned = { ...descriptor, log: "https://pinned.example/solidarity" };
  const cache = createDescriptorCache({
    ttlSeconds: 10,
    now: () => t,
    maxEntries: 2,
    preload: [pinned],
    fetch: async (url) => (fetched.push(url), new Response(JSON.stringify({ ...descriptor, log: url }))),
  });
  await cache.refresh(LOG);
  t += 11;
  assert.equal(cache.get(LOG)?.log, LOG, "past its time to live, still served");
  assert.deepEqual(fetched, [LOG, LOG], "and a refresh started");
  await cache.refresh(LOG); // the one in flight
  await cache.refresh("https://a.example/solidarity");
  await cache.refresh("https://b.example/solidarity");
  assert.equal(cache.get(LOG), undefined, "the least recently used fetched entry went");
  assert.ok(cache.get("https://a.example/solidarity") && cache.get("https://b.example/solidarity"));
  assert.equal(cache.get(pinned.log)?.log, pinned.log, "a preloaded entry is never evicted");
});

test("the descriptor cache never fetches a log URL that is not https", async () => {
  const fetched: string[] = [];
  const cache = createDescriptorCache({ fetch: async (url) => (fetched.push(url), new Response(JSON.stringify({ ...descriptor, log: url }))) });
  await assert.rejects(cache.refresh("http://plain.example/solidarity"), /not https/);
  assert.deepEqual(fetched, []);
});

test("the descriptor cache refuses a descriptor for another log or another version", async () => {
  const cache = createDescriptorCache({ fetch: async () => new Response(JSON.stringify({ ...descriptor, log: "https://other.example/solidarity" })) });
  await assert.rejects(cache.refresh(LOG), /did not return a version 2 descriptor/);
  assert.equal(cache.get(LOG), undefined);
  const v1 = createDescriptorCache({ fetch: async () => new Response(JSON.stringify({ ...descriptor, version: 1 })) });
  await assert.rejects(v1.refresh(LOG));
  await v1.prefetch([LOG, "http://plain.example/solidarity"]); // never rejects
  assert.equal(v1.get(LOG), undefined);
});
