/**
 * Network and contract constants used by the reference implementation.
 *
 * Every value here is copied from the x402 repository (coinbase/x402), commit
 * 0e6e8c55d86b4f14234fb6e49a4052074fb93e57, and cross-checked against a second
 * place in the same repository where one exists. Nothing here names a fund:
 * no fund exists, and the fund address used in examples is a placeholder.
 */

/** CAIP-2 id of Base Sepolia (chain id 84532). A testnet. */
export const BASE_SEPOLIA = "eip155:84532";

/**
 * USDC on Base Sepolia, with the EIP-712 domain its EIP-3009
 * `transferWithAuthorization` signatures use.
 *
 * Sources in coinbase/x402 at the commit above:
 * - typescript/packages/mechanisms/evm/src/defaultAssets.ts, DEFAULT_ASSETS["eip155:84532"]:
 *   asset 0x036CbD53842c5426634e7929541eC2318f3dCF7e, name "USDC", version "2", decimals 6.
 * - typescript/packages/legacy/x402/src/types/shared/evm/config.ts, config["84532"]:
 *   usdcAddress 0x036CbD53842c5426634e7929541eC2318f3dCF7e, usdcName "USDC".
 * - specs/extensions/solidarity.md and the x402 v2 examples use extra {name: "USDC", version: "2"}.
 *
 * Note that the domain name differs between networks: Base mainnet USDC signs
 * as "USD Coin". Always take name and version from the payment requirements'
 * `extra`, as the exact scheme does; these constants are defaults for examples.
 */
export const USDC_BASE_SEPOLIA = {
  network: BASE_SEPOLIA,
  chainId: 84532,
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  name: "USDC",
  version: "2",
  decimals: 6,
} as const;

/**
 * EIP-3009 TransferWithAuthorization typed-data types, identical to
 * `authorizationTypes` in typescript/packages/mechanisms/evm/src/constants.ts.
 */
export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * batch-settlement (EVM binding) constants, from
 * typescript/packages/mechanisms/evm/src/batch-settlement/constants.ts.
 * The spec (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Optional share kind:
 * `batch-settlement`") says using this binding with a fund as receiver needs
 * review by the binding's maintainers; this code follows the binding as written.
 */
export const BATCH_SETTLEMENT_ADDRESS = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003";
export const BATCH_SETTLEMENT_DOMAIN = { name: "x402 Batch Settlement", version: "1" } as const;
export const MIN_WITHDRAW_DELAY = 900;
export const MAX_WITHDRAW_DELAY = 2_592_000;

export const channelConfigTypes = {
  ChannelConfig: [
    { name: "payer", type: "address" },
    { name: "payerAuthorizer", type: "address" },
    { name: "receiver", type: "address" },
    { name: "receiverAuthorizer", type: "address" },
    { name: "token", type: "address" },
    { name: "withdrawDelay", type: "uint40" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export const voucherTypes = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "maxClaimableAmount", type: "uint128" },
  ],
} as const;

/** The exact EVM facilitator's clock allowance: validBefore must be at least now + 6 s. */
export const VALID_BEFORE_BUFFER_SECONDS = 6;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
