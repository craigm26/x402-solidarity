/**
 * Integration kit: the draft 2 solidarity extension on the x402 TypeScript SDK
 * (@x402/core and @x402/evm 2.28.0).
 *
 * A proposal, not part of x402, and not affiliated with or endorsed by x402,
 * Coinbase, the x402 Foundation, the UN or any fund. No fund exists; every
 * fund address in the tests and the README is a placeholder. Tested only
 * offline against a simulated chain: no money moves.
 *
 * Buyer:        client.registerExtension(solidarityClientExtension({ policy, counter, signer, descriptors }))
 * Seller:       server.registerExtension(solidarityServerExtension()) and the route's declareSolidarityExtension([...])
 * Facilitator:  attachSolidarity(facilitator, { log }) and facilitatorFetchHandler({ facilitator, solidarity })
 */

export { solidarityClientExtension, purchaseWindowOf } from "./client.ts";
export type { SolidarityClientOptions } from "./client.ts";

export { createDescriptorCache, isUsableDescriptor } from "./descriptors.ts";
export type { DescriptorCache, DescriptorCacheOptions, DescriptorSource } from "./descriptors.ts";

export { solidarityServerExtension } from "./resourceServer.ts";
export type { SolidarityServerOptions } from "./resourceServer.ts";

export { attachSolidarity, solidarityFacilitator, SETTLEMENT_PENDING } from "./facilitator.ts";
export type { ProcessResult, SolidarityFacilitator, SolidarityFacilitatorOptions } from "./facilitator.ts";

export { facilitatorLogChain } from "./logChain.ts";
export type { FacilitatorLogChainOptions, ShareSettler } from "./logChain.ts";

export { facilitatorFetchHandler, fetchRequestFromNode, nodeRequestListener } from "./http.ts";
export type { FacilitatorHandlerOptions, NodeRequestLike, NodeResponseLike } from "./http.ts";

// The reference implementation, unchanged, for the pieces each role also needs.
export {
  SOLIDARITY,
  SolidarityLog,
  CapCounter,
  declareSolidarityExtension,
  conventionalLogUrl,
  readOutcome,
  validateOutcome,
  openClientChannel,
  consentSummary,
  generateSigningKey,
  ed25519FromSeed,
  publicJwk,
  staticResolver,
  verifyReceipt,
  USDC_BASE_SEPOLIA,
  BASE_SEPOLIA,
} from "../../../src/solidarity/index.ts";
export type {
  ClientChannel,
  LogChain,
  LogDescriptor,
  LogEntry,
  OwnerPolicy,
  SigningKey,
  SolidarityOutcome,
  TypedDataSigner,
} from "../../../src/solidarity/index.ts";
