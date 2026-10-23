/**
 * One purchase and its exact share on Base Sepolia (testnet), through the
 * same client and log code as the offline example.
 *
 * Testnet only. No fund exists: unless you set FUND_ADDRESS, the share goes
 * to the placeholder 0x...f00d, which nobody controls, so the testnet USDC
 * sent there is gone.
 *
 *   SIMULATE=1 RPC_URL=https://sepolia.base.org node examples/live-base-sepolia/index.ts
 *       signs a purchase and its share with a throwaway key and runs both
 *       against the deployed USDC contract with eth_call (see simulate.ts);
 *       needs no funds and sends nothing
 *   DRY_RUN=1 PRIVATE_KEY=0x... RPC_URL=https://...  signs both, sends nothing
 *   PRIVATE_KEY=0x... RPC_URL=https://... FACILITATOR_URL=https://x402.org/facilitator ...
 *       settles both through that x402 facilitator, which pays the gas
 *   PRIVATE_KEY=0x... RPC_URL=https://... ...
 *       submits both from the key's own account, which pays the gas
 *
 * The purchase is 1 USDC to SELLER_ADDRESS (by default the key's own
 * address, so it comes back). The log handles the share only after the
 * purchase settles, as a real log would, and the share is 0.1% of it.
 */

import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import * as S from "../../src/solidarity/index.ts";
import type { LogChain, LogDescriptor, OwnerPolicy, PaymentPayload, PaymentRequirements } from "../../src/solidarity/index.ts";
import { checkEnv } from "./env.ts";
import { FacilitatorLogChain } from "./facilitatorChain.ts";
import { withExactLookup } from "./findTransfer.ts";
import { RpcLogChain } from "./rpcChain.ts";
import { simulateExactTransfer } from "./simulate.ts";

const env = checkEnv(process.env);
if (!env.ok) {
  console.error(env.message);
  process.exit(2);
}

const USDC = S.USDC_BASE_SEPOLIA;
const LOG = "https://local.invalid/solidarity";
const tx = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;
const account = privateKeyToAccount(env.privateKey ?? generatePrivateKey());
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(env.rpcUrl) });

const chainId = await publicClient.getChainId();
if (chainId !== USDC.chainId) {
  console.error(`Refusing to run: RPC_URL reports chain ${chainId}, not Base Sepolia (${USDC.chainId}).`);
  process.exit(2);
}
if (env.placeholderFund) console.warn("FUND_ADDRESS is not set: the share goes to the placeholder 0x...f00d, which nobody controls.");
console.log(`Payer ${account.address}${env.privateKey ? "" : " (throwaway key, SIMULATE=1)"}`);

const fund = `${USDC.network}:${env.fundAddress.toLowerCase()}`;
const policy: OwnerPolicy = { version: 2, rate: "0.001", cap: { amount: "5000000", asset: USDC.address.toLowerCase() }, fund, logs: [LOG], refunds: "keep", since: new Date().toISOString() };
const descriptor: LogDescriptor = {
  version: 2,
  log: LOG,
  funds: [fund],
  accepts: [{ network: USDC.network, asset: USDC.address.toLowerCase(), scheme: "exact", maxTimeoutSeconds: 300, minAmount: "1000", extra: { name: USDC.name, version: USDC.version } }],
  keys: [{ kid: "did:web:local.invalid#throwaway", from: "2026-01", until: null }],
};

// A 1 USDC exact purchase, signed the way any x402 client signs one.
const purchase: PaymentRequirements = { scheme: "exact", network: USDC.network, amount: "1000000", asset: USDC.address, payTo: env.sellerAddress ?? account.address, maxTimeoutSeconds: 300, extra: { name: USDC.name, version: USDC.version } };
const now = Math.floor(Date.now() / 1000);
const window = { validAfter: String(now - 60), validBefore: String(now + 300) };
const purchasePayload = await S.signEip3009(account, purchase, window);

const counter = new S.CapCounter(policy);
const decision = await S.buildShare(
  { policy, counter, signer: account, descriptor, now },
  { declared: { version: 2, logs: [{ network: USDC.network, scheme: "exact", log: LOG }] }, accepted: purchase, purchaseWindow: window },
);
if (!decision.attached) {
  console.error(`No share: ${decision.why}`);
  process.exit(1);
}
const share = decision.info.payment as { accepted: PaymentRequirements; payload: S.ExactEip3009Payload };
console.log(`Signed a 1 USDC purchase and an exact share of ${decision.amount} atomic units (id ${decision.info.id}).`);

if (env.dryRun) {
  console.log("DRY_RUN=1: both signed; nothing checked against the chain or sent.");
  process.exit(0);
}

if (env.simulate) {
  let failed = 0;
  for (const [name, accepted, payload] of [["purchase", purchase, purchasePayload], ["share", share.accepted, share.payload]] as const) {
    const r = await simulateExactTransfer(publicClient as unknown as Parameters<typeof simulateExactTransfer>[0], accepted, payload);
    console.log(r.ok ? `ok   ${name}: transferWithAuthorization succeeds against USDC ${USDC.address} (eth_call, balance override ${r.balanceUnderOverride})` : `FAIL ${name}: ${r.error}`);
    if (!r.ok) failed++;
  }
  console.log(failed ? `${failed} failed` : "SIMULATE=1: both would execute on Base Sepolia; nothing was sent.");
  process.exit(failed ? 1 : 0);
}

// Either way, the log can find a share someone else submitted first (findTransfer.ts).
const chain: LogChain = withExactLookup(
  env.facilitatorUrl ? new FacilitatorLogChain(env.facilitatorUrl) : new RpcLogChain(publicClient, createWalletClient({ account, chain: baseSepolia, transport: http(env.rpcUrl) })),
  publicClient as unknown as Parameters<typeof withExactLookup>[1],
);
console.log(env.facilitatorUrl ? `Settling through ${env.facilitatorUrl} (it pays the gas).` : "Submitting from the key's own account (it pays the gas).");

// The purchase settles first, exactly as it would without the extension.
const bought = await chain.submitExact(purchase, purchasePayload);
console.log(bought.ok ? `Purchase settled: ${tx(bought.transaction)}` : `Purchase failed: ${bought.error}`);
const settle = bought.ok
  ? { success: true, transaction: bought.transaction, network: USDC.network, payer: account.address }
  : { success: false, errorReason: bought.error, transaction: "", network: USDC.network, payer: account.address };

// Only then does the log handle the share.
const log = new S.SolidarityLog({ descriptor, key: S.generateSigningKey("EdDSA", "did:web:local.invalid#throwaway"), chain });
const paymentPayload: PaymentPayload = { x402Version: 2, accepted: purchase, payload: purchasePayload, extensions: { solidarity: { info: decision.info, schema: S.solidaritySchema } } };
const settled = await log.onSettled(paymentPayload, purchase, settle);
console.log("Log outcome:", settled.outcome);
await settled.followUp;
const record = log.inspect(decision.info.id as string) as { state?: string; exact?: { transaction?: string } } | undefined;
console.log("Share record:", record);
if (record?.exact?.transaction) console.log(`Share transfer: ${tx(record.exact.transaction)}`);
process.exit(bought.ok && record?.state === "collected" ? 0 : 1);
