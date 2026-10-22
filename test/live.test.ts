import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import * as S from "../src/solidarity/index.ts";
import type { PaymentRequirements } from "../src/solidarity/index.ts";
import { checkEnv } from "../examples/live-base-sepolia/env.ts";
import { FacilitatorLogChain } from "../examples/live-base-sepolia/facilitatorChain.ts";
import type { Fetch } from "../examples/live-base-sepolia/facilitatorChain.ts";
import { mappingSlot, simulateExactTransfer } from "../examples/live-base-sepolia/simulate.ts";
import type { CallClient } from "../examples/live-base-sepolia/simulate.ts";

/** A Base Sepolia RPC endpoint, for the checks against the deployed USDC contract: BASE_SEPOLIA_RPC_URL only, no default. */
const RPC = process.env.BASE_SEPOLIA_RPC_URL;
const NEEDS_RPC = !RPC && "no RPC endpoint: set BASE_SEPOLIA_RPC_URL (README, \"Run it\")";

const USDC = S.USDC_BASE_SEPOLIA;
const requirements = (payTo: string, amount: string, version = USDC.version): PaymentRequirements => ({
  scheme: "exact",
  network: USDC.network,
  amount,
  asset: USDC.address,
  payTo,
  maxTimeoutSeconds: 300,
  extra: { name: USDC.name, version },
});
const window = () => {
  const now = Math.floor(Date.now() / 1000);
  return { validAfter: String(now - 60), validBefore: String(now + 300) };
};
const FUND = "0x000000000000000000000000000000000000f00d";

test("live example: SIMULATE=1 needs only RPC_URL, and the modes don't mix", () => {
  const sim = checkEnv({ SIMULATE: "1", RPC_URL: "https://sepolia.base.example" });
  assert.ok(sim.ok && sim.simulate && sim.privateKey === undefined);
  const noRpc = checkEnv({ SIMULATE: "1" });
  assert.ok(!noRpc.ok && /set RPC_URL\./.test(noRpc.message));
  assert.equal(checkEnv({ SIMULATE: "1", DRY_RUN: "1", RPC_URL: "https://x" }).ok, false);
  assert.equal(checkEnv({ PRIVATE_KEY: `0x${"1".repeat(64)}`, RPC_URL: "https://x", FACILITATOR_URL: "x402.org" }).ok, false);
  assert.equal(checkEnv({ PRIVATE_KEY: `0x${"1".repeat(64)}`, RPC_URL: "https://x", SELLER_ADDRESS: "0x12" }).ok, false);
  const full = checkEnv({ PRIVATE_KEY: `0x${"1".repeat(64)}`, RPC_URL: "https://x", FACILITATOR_URL: "https://x402.org/facilitator", SELLER_ADDRESS: `0x${"2".repeat(40)}` });
  assert.ok(full.ok && full.facilitatorUrl === "https://x402.org/facilitator" && full.sellerAddress === `0x${"2".repeat(40)}` && !full.simulate);
});

test("FacilitatorLogChain posts an x402 v2 /settle request and reads the SettleResponse", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const accepted = requirements(FUND, "1000");
  const payload = await S.signEip3009(account, accepted, window());
  const hash = `0x${"ab".repeat(32)}`;
  const seen: { url: string; body: unknown }[] = [];
  const answer = (status: number, body: string): Fetch => async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return { ok: status < 400, status, text: async () => body };
  };

  const ok = await new FacilitatorLogChain("https://f.example/facilitator/", answer(200, JSON.stringify({ success: true, transaction: hash, network: USDC.network, payer: account.address }))).submitExact(accepted, payload);
  assert.deepEqual(ok, { ok: true, transaction: hash });
  assert.equal(seen[0].url, "https://f.example/facilitator/settle");
  assert.deepEqual(seen[0].body, { x402Version: 2, paymentPayload: { x402Version: 2, accepted, payload }, paymentRequirements: accepted });

  const refused = await new FacilitatorLogChain("https://f.example", answer(400, JSON.stringify({ success: false, errorReason: "insufficient_funds", transaction: "", network: USDC.network }))).submitExact(accepted, payload);
  assert.ok(!refused.ok && /insufficient_funds/.test(refused.error));
  const notJson = await new FacilitatorLogChain("https://f.example", answer(502, "<html>bad gateway</html>")).submitExact(accepted, payload);
  assert.ok(!notJson.ok && /not JSON/.test(notJson.error));
  const noHash = await new FacilitatorLogChain("https://f.example", answer(200, JSON.stringify({ success: true, transaction: "" }))).submitExact(accepted, payload);
  assert.equal(noHash.ok, false, "success without a transaction hash is not a settlement");
  const down = await new FacilitatorLogChain("https://f.example", async () => {
    throw new Error("ECONNREFUSED");
  }).submitExact(accepted, payload);
  assert.ok(!down.ok && /ECONNREFUSED/.test(down.error));
});

test("mappingSlot is the Solidity mapping slot keccak256(abi.encode(key, slot))", () => {
  const a = mappingSlot("0x000000000000000000000000000000000000f00d", 9n);
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(mappingSlot("0x000000000000000000000000000000000000F00D", 9n), a, "address case does not matter");
  assert.notEqual(mappingSlot("0x000000000000000000000000000000000000f00d", 10n), a);
});

test("against the deployed USDC on Base Sepolia: a signed share executes, and a broken one does not", { skip: NEEDS_RPC }, async () => {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) }) as unknown as CallClient;
  const account = privateKeyToAccount(generatePrivateKey());
  const accepted = requirements(FUND, "1000");
  const payload = await S.signEip3009(account, accepted, window());

  const good = await simulateExactTransfer(client, accepted, payload);
  assert.ok(good.ok, good.ok ? "" : good.error);

  // One unit short of the amount: the contract refuses the transfer.
  const short = await simulateExactTransfer(client, accepted, payload, { balance: 999n });
  assert.equal(short.ok, false, "a payer one unit short must fail");

  // A signature over a different message recovers a different signer.
  const tampered = { ...payload, authorization: { ...payload.authorization, value: "1001" } };
  assert.equal((await simulateExactTransfer(client, accepted, tampered)).ok, false, "tampered value must fail");

  // The wrong EIP-712 domain version gives a signature the contract does not accept.
  const v1 = requirements(FUND, "1000", "1");
  assert.equal((await simulateExactTransfer(client, v1, await S.signEip3009(account, v1, window()))).ok, false, "domain version 1 must fail");

  // An authorization whose window has closed.
  const now = Math.floor(Date.now() / 1000);
  const expired = await S.signEip3009(account, accepted, { validAfter: String(now - 600), validBefore: String(now - 300) });
  assert.equal((await simulateExactTransfer(client, accepted, expired)).ok, false, "an expired authorization must fail");
});
