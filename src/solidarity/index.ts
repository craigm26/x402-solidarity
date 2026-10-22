/**
 * Solidarity extension for x402 v2, draft 2: reference implementation.
 *
 * A proposal, not part of x402, and not reviewed or endorsed by its
 * maintainers. The owner of an AI agent gives a small, fixed share of what the
 * agent spends to a humanitarian fund, at a rate and monthly cap set in
 * advance. The seller is paid in full and never pays the share. Each share is
 * a line in a public log; each month the log publishes a signed, witnessed
 * statement over its lines (an RFC 6962 Merkle tree).
 *
 * ## Usage
 *
 * ### Resource servers (sellers)
 *
 * ```ts
 * import { declareSolidarityExtension, SOLIDARITY } from "./solidarity/index.ts";
 *
 * const paymentRequired = {
 *   x402Version: 2,
 *   resource: { ... },
 *   accepts: [ ... ],
 *   extensions: {
 *     [SOLIDARITY]: declareSolidarityExtension([
 *       { network: "eip155:84532", scheme: "exact", log: "https://facilitator.example/solidarity" },
 *     ]),
 *   },
 * };
 * ```
 *
 * ### Clients (the policy holder in separate mode)
 *
 * ```ts
 * import { appendSolidarityToExtensions, CapCounter } from "./solidarity/index.ts";
 *
 * const extensions = structuredClone(paymentRequired.extensions);
 * await appendSolidarityToExtensions(extensions, { policy, counter, signer, descriptor }, { accepted });
 * const paymentPayload = { x402Version: 2, accepted, payload, extensions };
 * ```
 *
 * ### Facilitators (the log)
 *
 * ```ts
 * import { SolidarityLog } from "./solidarity/index.ts";
 *
 * const log = new SolidarityLog({ descriptor, key, chain });
 * const verifyResponse = log.onVerify(paymentPayload, await verifyPurchase());   // unchanged
 * const settled = await settlePurchase();
 * const { settleResponse, extensionResponses, followUp } = await log.onSettled(paymentPayload, requirements, settled);
 * // send settleResponse; set EXTENSION-RESPONSES for the seller if you like; then:
 * await followUp;
 * ```
 */

export type {
  ChannelSnapshot,
  DescriptorAccept,
  DescriptorKey,
  JwsEnvelope,
  LogDescriptor,
  LogEntry,
  Mode,
  OwnerPolicy,
  PaymentPayload,
  PaymentRequirements,
  PublishedStatement,
  Receipt,
  RefundRule,
  SettleResponse,
  ShareKind,
  SharePayment,
  ShareStatus,
  SkipReason,
  SolidarityExtension,
  SolidarityInfo,
  SolidarityOutcome,
  StatementPayload,
  TotalsRow,
} from "./types.ts";

export {
  SOLIDARITY,
  SOLIDARITY_VERSION,
  LINE_PREFIX,
  RATE_PATTERN,
  SHARE_ID_PATTERN,
  CAIP10_PATTERN,
  AMOUNT_PATTERN,
  PERIOD_PATTERN,
  SKIP_REASONS,
} from "./types.ts";

export { USDC_BASE_SEPOLIA, BASE_SEPOLIA, BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_DOMAIN } from "./constants.ts";

export { solidaritySchema, solidarityOutcomeSchema, validateSchema } from "./schema.ts";

export { canonicalize, canonicalizeStrict, canonicalBytes, isCanonical } from "./jcs.ts";

export { buildTree, merkleRoot, verifyInclusion, leafHash, nodeHash, EMPTY_ROOT_HEX } from "./merkle.ts";

export {
  generateShareId,
  shareNonce,
  isValidShareId,
  isValidRate,
  applyRate,
  shareMax,
  recordedShare,
  netCredit,
  parseCaip10,
  canonicalAccount,
  periodOf,
  nextPeriod,
} from "./utils.ts";

export { policyProblems, assertPolicy, policyHash, consentSummary, CapCounter } from "./policy.ts";

export type { TypedDataSigner, ExactEip3009Payload, ChannelConfig, VoucherFields, BatchVoucherPayload } from "./evm.ts";
export { signEip3009, verifyEip3009Signature, computeChannelId, signVoucher, verifyVoucherSignature, createNonce } from "./evm.ts";

export type { ShareContext, BuildShareInput, ShareDecision, ClientChannel } from "./client.ts";
export {
  buildShare,
  appendSolidarityToExtensions,
  readOutcome,
  resolveFlow,
  shareKindsFor,
  openClientChannel,
  applyOutcomeToChannel,
  resyncChannel,
  processorConstraint,
  mayAttachShare,
} from "./client.ts";

export { declareSolidarityExtension, solidarityResourceServerExtension, conventionalLogUrl } from "./resourceServer.ts";

export { isSolidarityExtension, validateSolidarity, validateOutcome, extractSolidarity, hasShare } from "./validation.ts";

export type { LogChain, SettledResult, SolidarityLogOptions } from "./facilitator.ts";
export { SolidarityLog, purchaseBasis, withOutcome, decodeExtensionResponses } from "./facilitator.ts";

export type { SigningKey, KeyResolver, VerifyOptions, FundView, StatementCheck, ReceiptCheck, Batch } from "./ledger.ts";
export {
  formatLine,
  parseLine,
  buildBatch,
  fileBody,
  parseFileBody,
  formatSettlement,
  parseSettlement,
  canonicalRef,
  settlementsMatchTotals,
  statementPayload,
  statementBytes,
  statementHash,
  signStatement,
  decodeStatement,
  statementProblems,
  verifyStatement,
  verifyChain,
  buildReceipt,
  verifyReceipt,
  jwsSign,
  jwsVerify,
  jwsDecode,
  ed25519FromSeed,
  ed25519PublicKey,
  ed25519PublicKeyHex,
  generateSigningKey,
  staticResolver,
  keyCoversPeriod,
  didWebHost,
  kidOnLogHost,
  sha256Hex,
  Witness,
  FundCosigner,
} from "./ledger.ts";

export { LogBook } from "./book.ts";
export { ProcessorHolder } from "./processor.ts";
