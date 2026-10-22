/**
 * The whole flow, offline, with throwaway keys and a simulated chain.
 * SIMULATED: no network, no real tokens, no fund. Nothing moves anywhere.
 *
 *   node examples/e2e-offline.ts
 *
 * 1. The owner sets a policy (rate 0.1%, cap 5 USDC a month, a placeholder fund).
 * 2. A seller declares the extension; the agent buys a 48 USDC report.
 *    The agent signs the purchase and an exact share of 0.048 USDC.
 * 3. The facilitator verifies and settles the purchase (the share does not
 *    touch /verify), then checks the share and records a line.
 * 4. Two small purchases carry batch-settlement shares on the owner's channel.
 * 5. One purchase fails: no purchase, no share. The agent later releases the
 *    unexecuted share from its cap counter.
 * 6. The 48 USDC purchase is refunded by the seller: the share stays (keep).
 * 7. Month close: claims, the batch, a signed statement; a witness and the
 *    fund cosign it (the fund checks the money arrived in the simulation).
 * 8. The owner fetches /proofs/<id> and the statement and verifies inclusion.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SimulatedChain } from "../src/sim/chain.ts";
import * as S from "../src/solidarity/index.ts";
import type { LogDescriptor, OwnerPolicy, PaymentPayload, PaymentRequirements, SettleResponse } from "../src/solidarity/index.ts";

const USDC = S.USDC_BASE_SEPOLIA.address;
const NET = S.BASE_SEPOLIA;
const LOG = "https://facilitator.example/solidarity";
const FUND_ADDR = "0x000000000000000000000000000000000000f00d"; // placeholder: no fund exists
const FUND = `${NET}:${FUND_ADDR}`;
const START = Date.UTC(2026, 11, 10, 12) / 1000; // simulated clock: 2026-12-10T12:00:00Z

export interface DemoResult {
  ids: Record<string, string>;
  outcomes: Record<string, S.SolidarityOutcome | undefined>;
  statement: S.PublishedStatement;
  receiptCheck: S.ReceiptCheck;
  proofs: Record<string, unknown>;
  fundBalance: bigint;
  released: boolean;
  lines: string[];
}

export async function runOfflineDemo(opts: { quiet?: boolean } = {}): Promise<DemoResult> {
  const say = (...a: unknown[]) => {
    if (!opts.quiet) console.log(...a);
  };
  const chain = new SimulatedChain({ now: START });
  const clock = () => chain.now;

  // Throwaway keys.
  const agent = privateKeyToAccount(generatePrivateKey());
  const seller = privateKeyToAccount(generatePrivateKey());
  const authorizer = privateKeyToAccount(generatePrivateKey());
  const logKey = S.generateSigningKey("EdDSA", "did:web:facilitator.example#solidarity-1");
  const witnessKey = S.generateSigningKey("EdDSA", "did:web:witness.example#1");
  const fundKey = S.generateSigningKey("ES256", "did:web:fund.example#1");
  const resolveKey = S.staticResolver({ [logKey.kid]: logKey.publicKey, [witnessKey.kid]: witnessKey.publicKey, [fundKey.kid]: fundKey.publicKey });
  chain.mint(USDC, agent.address, 200_000_000n);

  // 1. The owner's policy, held by the agent.
  const policy: OwnerPolicy = { version: 2, rate: "0.001", cap: { amount: "5000000", asset: USDC.toLowerCase() }, fund: FUND, logs: [LOG], refunds: "keep", since: new Date(START * 1000).toISOString() };
  const counter = new S.CapCounter(policy);
  say("1. Owner consents:", S.consentSummary(policy));

  // The log's descriptor (the agent would GET <log>).
  const descriptor: LogDescriptor = {
    version: 2,
    log: LOG,
    funds: [FUND],
    accepts: [
      { network: NET, asset: USDC.toLowerCase(), scheme: "batch-settlement", maxTimeoutSeconds: 60, extra: { receiverAuthorizer: authorizer.address, withdrawDelay: 86400, name: "USDC", version: "2" } },
      { network: NET, asset: USDC.toLowerCase(), scheme: "exact", maxTimeoutSeconds: 60, minAmount: "10000", extra: { name: "USDC", version: "2" } },
    ],
    minWithdrawDelay: 86400,
    keys: [{ kid: logKey.kid, from: "2026-12", until: null }],
    witnesses: ["did:web:witness.example"],
  };
  const log = new S.SolidarityLog({ descriptor, key: logKey, chain, clock });
  const ctx = { policy, counter, signer: agent, descriptor, now: chain.now };

  // The seller's PaymentRequired.
  const priced = (amount: string): PaymentRequirements => ({ scheme: "exact", network: NET, amount, asset: USDC, payTo: seller.address, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } });
  const paymentRequired = (amount: string) => ({
    x402Version: 2,
    resource: { url: "https://books.example/api/orders" },
    accepts: [priced(amount)],
    extensions: { [S.SOLIDARITY]: S.declareSolidarityExtension([{ network: NET, scheme: "exact", log: LOG }]) },
  });

  const ids: Record<string, string> = {};
  const outcomes: Record<string, S.SolidarityOutcome | undefined> = {};
  const followUps: Promise<void>[] = [];

  async function buy(label: string, amount: string, shareOpts: Partial<S.BuildShareInput> = {}, failPurchase = false) {
    ctx.now = chain.now;
    const pr = paymentRequired(amount);
    const accepted = pr.accepts[0];
    const window = { validAfter: String(chain.now - 60), validBefore: String(chain.now + 60) };
    const purchase = await S.signEip3009(agent, accepted, window);
    const extensions = structuredClone(pr.extensions) as Record<string, unknown>;
    const d = await S.appendSolidarityToExtensions(extensions, ctx, { accepted, purchaseWindow: window, ...shareOpts });
    if (d.attached) ids[label] = d.info.id as string;
    const paymentPayload: PaymentPayload = { x402Version: 2, accepted, payload: purchase as unknown as Record<string, unknown>, extensions };

    // Facilitator /verify: the purchase only.
    const verifyResponse = { isValid: await S.verifyEip3009Signature(accepted, purchase), payer: agent.address };
    const v = log.onVerify(paymentPayload, verifyResponse);
    // Facilitator /settle: the purchase, then the share.
    let settle: SettleResponse;
    if (failPurchase) settle = { success: false, errorReason: "insufficient_funds", transaction: "", network: NET, payer: agent.address };
    else {
      const r = await chain.transferWithAuthorization(accepted, purchase);
      settle = r.ok ? { success: true, transaction: r.transaction, network: NET, payer: agent.address, amount } : { success: false, errorReason: r.error, transaction: "", network: NET };
    }
    const settled = await log.onSettled(paymentPayload, accepted, settle);
    followUps.push(settled.followUp);
    const outcome = S.readOutcome(settled.settleResponse);
    outcomes[label] = outcome;
    say(`   ${label}: verify ${v.isValid ? "valid" : "invalid"}, purchase ${settle.success ? "settled" : "failed"}, share ${d.attached ? `${d.kind} ${d.amount}` : `not added (${d.why})`} -> ${outcome ? `${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}${outcome.amount ? ` ${outcome.amount}` : ""}` : "no entry"}`);
    return { outcome, settled, purchase, decision: d };
  }

  // 2 and 3. A 48 USDC purchase with an exact share.
  say("2-3. Purchases:");
  await buy("report", "48000000");

  // 4. Small purchases with batch-settlement shares on a channel the owner funded.
  const channelConfig = { payer: agent.address, payerAuthorizer: agent.address, receiver: FUND_ADDR as `0x${string}`, receiverAuthorizer: authorizer.address, token: USDC as `0x${string}`, withdrawDelay: 86400, salt: `0x${"01".padStart(64, "0")}` as `0x${string}` };
  chain.deposit(channelConfig, 100_000n);
  const channel = S.openClientChannel(NET, channelConfig);
  for (const [label, amount] of [["search-1", "2000000"], ["search-2", "3500000"]] as const) {
    const r = await buy(label, amount, { kind: "batch-settlement", channel });
    S.applyOutcomeToChannel(channel, r.outcome);
  }

  // 5. A failed purchase: no purchase, no share. The exact share it carried was counted when signed.
  chain.now += 10;
  const failed = await buy("failed", "20000000", {}, true);
  chain.now += 120; // past the share's validBefore
  const failedNonce = (failed.decision.attached ? ((failed.decision.info.payment?.payload as unknown as S.ExactEip3009Payload).authorization.nonce) : "0x") as string;
  const released = counter.release(ids.failed, { now: chain.now, executed: chain.authorizationState(USDC, agent.address, failedNonce) });
  say(`5. Failed purchase share released from the cap counter: ${released}`);

  // 6. The seller refunds the 48 USDC purchase. The share stays: keep.
  const refundTx = chain.transfer(USDC, seller.address, agent.address, 48_000_000n);
  const refundRule = log.onPurchaseRefund({ transaction: refundTx, amount: "48000000" });
  say(`6. The seller refunds the report (${refundTx.slice(0, 10)}...): share adjusted? ${refundRule.adjusted} (rule: ${refundRule.rule}); the line stays`);

  await Promise.all(followUps);

  // 7. Month close.
  chain.now = Date.UTC(2027, 0, 5) / 1000;
  const statement = await log.closePeriod("2026-12");
  const closed = log.book.get("2026-12") as NonNullable<ReturnType<typeof log.book.get>>;
  chain.sweep(FUND_ADDR, USDC); // permissionless; claims already attest the totals
  const witness = new S.Witness(witnessKey);
  log.addCosignature("2026-12", witness.cosign(statement, { resolveKey, descriptor, files: { lines: closed.lines, settlements: closed.settlements } }));
  const fund = new S.FundCosigner({ fund: FUND, key: fundKey, view: chain.fundView(), logAuthorizers: { [LOG]: authorizer.address } });
  log.addCosignature("2026-12", fund.cosign(statement, closed.settlements, { resolveKey, descriptor }));
  const payload = S.decodeStatement(statement.statement).payload;
  say(`7. Statement 2026-12: ${payload.size} lines, root ${payload.root}, totals ${JSON.stringify(payload.totals)}; cosigned by witness and fund`);

  // 8. The owner checks a share.
  const proofs: Record<string, unknown> = {};
  for (const [label, id] of Object.entries(ids)) proofs[label] = JSON.parse(log.handle(`/proofs/${id}`).body);
  const got = proofs.report as { status: string; line: string; index: number; proof: string[]; period: string };
  const pub = JSON.parse(log.handle(`/statements/${got.period}`).body) as S.PublishedStatement;
  const receipt: S.Receipt = { version: 2, line: got.line, index: got.index, proof: got.proof, statement: pub.statement, cosignatures: pub.cosignatures };
  const receiptCheck = S.verifyReceipt(receipt, { resolveKey, descriptor, requireCosigners: [witnessKey.kid, fundKey.kid] });
  say(`8. Owner's receipt for the report share: ${receiptCheck.ok ? "verified" : `FAILED ${receiptCheck.problems.join("; ")}`} (included, log signature, witness and fund cosignatures)`);
  for (const [label, p] of Object.entries(proofs)) say(`   /proofs for ${label}: ${(p as { status?: string }).status ?? "404"}`);
  const fundBalance = chain.balanceOf(USDC, FUND_ADDR);
  say(`   Simulated fund balance: ${fundBalance} atomic units (${Number(fundBalance) / 1e6} simulated USDC). Nothing real moved.`);

  return { ids, outcomes, statement, receiptCheck, proofs, fundBalance, released, lines: closed.batch.lines };
}

if (import.meta.main) {
  const r = await runOfflineDemo();
  if (!r.receiptCheck.ok) process.exit(1);
}
