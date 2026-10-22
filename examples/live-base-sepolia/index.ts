/**
 * Settles one exact share on Base Sepolia (testnet), end to end through the
 * same client and log code as the offline example.
 *
 * UNTESTED against a live chain. Testnet only. No fund exists: unless you set
 * FUND_ADDRESS, the share goes to the placeholder 0x...f00d, which nobody
 * controls, so the testnet USDC sent there is gone.
 *
 *   PRIVATE_KEY=0x... RPC_URL=https://... node examples/live-base-sepolia/index.ts
 *   DRY_RUN=1 ...  signs and checks the share, sends nothing
 *
 * The one key plays every part: the agent signs the share, and the same
 * account submits it as the log (and pays the gas). There is no purchase: the
 * share is computed on a notional 10 USDC purchase, which is enough to show
 * the share path. A real log would only process a share after a real settle.
 */

import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import * as S from "../../src/solidarity/index.ts";
import type { LogDescriptor, OwnerPolicy, PaymentPayload, PaymentRequirements } from "../../src/solidarity/index.ts";
import { checkEnv } from "./env.ts";
import { RpcLogChain } from "./rpcChain.ts";

const env = checkEnv(process.env);
if (!env.ok) {
  console.error(env.message);
  process.exit(2);
}

const USDC = S.USDC_BASE_SEPOLIA;
const LOG = "https://local.invalid/solidarity";
const account = privateKeyToAccount(env.privateKey);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(env.rpcUrl) });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(env.rpcUrl) });

const chainId = await publicClient.getChainId();
if (chainId !== USDC.chainId) {
  console.error(`Refusing to run: RPC_URL reports chain ${chainId}, not Base Sepolia (${USDC.chainId}).`);
  process.exit(2);
}
if (env.placeholderFund) console.warn("FUND_ADDRESS is not set: the share goes to the placeholder 0x...f00d, which nobody controls.");

const fund = `${USDC.network}:${env.fundAddress.toLowerCase()}`;
const policy: OwnerPolicy = { version: 2, rate: "0.001", cap: { amount: "5000000", asset: USDC.address.toLowerCase() }, fund, logs: [LOG], refunds: "keep", since: new Date().toISOString() };
const descriptor: LogDescriptor = {
  version: 2,
  log: LOG,
  funds: [fund],
  accepts: [{ network: USDC.network, asset: USDC.address.toLowerCase(), scheme: "exact", maxTimeoutSeconds: 120, minAmount: "10000", extra: { name: USDC.name, version: USDC.version } }],
  keys: [{ kid: "did:web:local.invalid#throwaway", from: "2026-01", until: null }],
};

// A notional 10 USDC exact purchase (never made).
const purchase: PaymentRequirements = { scheme: "exact", network: USDC.network, amount: "10000000", asset: USDC.address, payTo: account.address, maxTimeoutSeconds: 120, extra: { name: USDC.name, version: USDC.version } };
const now = Math.floor(Date.now() / 1000);
const counter = new S.CapCounter(policy);
const decision = await S.buildShare(
  { policy, counter, signer: account, descriptor, now },
  { declared: { version: 2, logs: [{ network: USDC.network, scheme: "exact", log: LOG }] }, accepted: purchase, purchaseWindow: { validAfter: String(now - 60), validBefore: String(now + 120) } },
);
if (!decision.attached) {
  console.error(`No share: ${decision.why}`);
  process.exit(1);
}
console.log(`Signed an exact share of ${decision.amount} atomic units (id ${decision.info.id}).`);

const chain = new RpcLogChain(publicClient, walletClient);
const log = new S.SolidarityLog({ descriptor, key: S.generateSigningKey("EdDSA", "did:web:local.invalid#throwaway"), chain });
const paymentPayload: PaymentPayload = { x402Version: 2, accepted: purchase, payload: {}, extensions: { solidarity: { info: decision.info, schema: S.solidaritySchema } } };
const notionalSettle = { success: true, transaction: "0x-notional-purchase", network: USDC.network, payer: account.address };

if (env.dryRun) {
  console.log("DRY_RUN=1: share signed; not checking it against a log or sending anything.");
  process.exit(0);
}
const settled = await log.onSettled(paymentPayload, purchase, notionalSettle);
console.log("Log outcome:", settled.outcome);
await settled.followUp;
console.log("Share record:", log.inspect(decision.info.id as string));
