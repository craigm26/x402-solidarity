/**
 * EVM signing and verification for share payments, with viem.
 *
 * - `exact` shares: an EIP-3009 transferWithAuthorization signed under the
 *   token's EIP-712 domain (name and version from `accepted.extra`, chainId
 *   from the network, verifyingContract = the asset), exactly as the x402
 *   exact EVM client builds it (mechanisms/evm/src/exact/client/eip3009.ts).
 * - `batch-settlement` shares: a cumulative Voucher(channelId,
 *   maxClaimableAmount) under the batch-settlement domain, and the channel id
 *   as the EIP-712 hash of the ChannelConfig (batch-settlement/utils.ts).
 *
 * Verification here is offline (ecrecover through viem's verifyTypedData).
 * It does not check balances, nonce state or smart-wallet signatures
 * (ERC-1271, ERC-6492); a facilitator adds those with its chain reads.
 */

import { getAddress, hashTypedData, toHex, verifyTypedData } from "viem";
import { randomBytes } from "node:crypto";
import {
  BATCH_SETTLEMENT_ADDRESS,
  BATCH_SETTLEMENT_DOMAIN,
  channelConfigTypes,
  transferWithAuthorizationTypes,
  voucherTypes,
  ZERO_ADDRESS,
} from "./constants.ts";
import type { PaymentRequirements } from "./types.ts";
import { evmChainId } from "./utils.ts";

export type Hex = `0x${string}`;

/** Anything that can sign EIP-712 typed data: a viem LocalAccount or WalletClient account. */
export interface TypedDataSigner {
  address: Hex;
  signTypedData(params: {
    domain: Record<string, unknown>;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

export interface Eip3009Authorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface ExactEip3009Payload {
  signature: Hex;
  authorization: Eip3009Authorization;
}

/** A random bytes32 nonce, as the x402 EVM client makes it. */
export const createNonce = (): Hex => toHex(randomBytes(32));

export function eip3009Domain(requirements: PaymentRequirements) {
  const name = requirements.extra?.name;
  const version = requirements.extra?.version;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`EIP-712 domain parameters (name, version) are required in extra for asset ${requirements.asset}`);
  }
  return {
    name,
    version,
    chainId: evmChainId(requirements.network),
    verifyingContract: getAddress(requirements.asset),
  };
}

function eip3009Message(a: Eip3009Authorization) {
  return {
    from: getAddress(a.from),
    to: getAddress(a.to),
    value: BigInt(a.value),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    nonce: a.nonce,
  };
}

/** Sign an EIP-3009 transferWithAuthorization for `requirements` (payTo, amount, asset, network, extra). */
export async function signEip3009(
  signer: TypedDataSigner,
  requirements: PaymentRequirements,
  window: { validAfter: string; validBefore: string; nonce?: Hex },
): Promise<ExactEip3009Payload> {
  const authorization: Eip3009Authorization = {
    from: getAddress(signer.address),
    to: getAddress(requirements.payTo),
    value: requirements.amount,
    validAfter: window.validAfter,
    validBefore: window.validBefore,
    nonce: window.nonce ?? createNonce(),
  };
  const signature = await signer.signTypedData({
    domain: eip3009Domain(requirements),
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: eip3009Message(authorization),
  });
  return { signature, authorization };
}

/** Typed-data signature check for an EIP-3009 payload (EOA signers). */
export async function verifyEip3009Signature(requirements: PaymentRequirements, payload: ExactEip3009Payload): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: getAddress(payload.authorization.from),
      domain: eip3009Domain(requirements),
      types: transferWithAuthorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: eip3009Message(payload.authorization),
      signature: payload.signature,
    });
  } catch {
    return false;
  }
}

/** A base-10 integer string that fits in `bits` unsigned bits. */
const uintString = (v: unknown, bits: number): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << BigInt(bits);

export function isExactEip3009Payload(p: unknown): p is ExactEip3009Payload {
  const x = p as ExactEip3009Payload;
  const a = x?.authorization;
  return (
    typeof x?.signature === "string" &&
    /^0x[0-9a-fA-F]+$/.test(x.signature) &&
    typeof a === "object" &&
    a !== null &&
    [a.from, a.to].every((v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) &&
    [a.value, a.validAfter, a.validBefore].every((v) => uintString(v, 256)) &&
    typeof a.nonce === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(a.nonce)
  );
}

// ---- batch-settlement ------------------------------------------------------

export interface ChannelConfig {
  payer: Hex;
  payerAuthorizer: Hex;
  receiver: Hex;
  receiverAuthorizer: Hex;
  token: Hex;
  withdrawDelay: number;
  salt: Hex;
}

export interface VoucherFields {
  channelId: Hex;
  maxClaimableAmount: string;
  signature: Hex;
}

export interface BatchVoucherPayload {
  type: "voucher";
  channelConfig: ChannelConfig;
  voucher: VoucherFields;
}

export function batchSettlementDomain(chainId: number) {
  return { ...BATCH_SETTLEMENT_DOMAIN, chainId, verifyingContract: getAddress(BATCH_SETTLEMENT_ADDRESS) };
}

/** Channel id: the EIP-712 hash of the ChannelConfig under the batch-settlement domain. */
export function computeChannelId(config: ChannelConfig, network: string): Hex {
  return hashTypedData({
    domain: batchSettlementDomain(evmChainId(network)),
    types: channelConfigTypes,
    primaryType: "ChannelConfig",
    message: {
      payer: getAddress(config.payer),
      payerAuthorizer: getAddress(config.payerAuthorizer),
      receiver: getAddress(config.receiver),
      receiverAuthorizer: getAddress(config.receiverAuthorizer),
      token: getAddress(config.token),
      withdrawDelay: config.withdrawDelay,
      salt: config.salt,
    },
  });
}

export async function signVoucher(signer: TypedDataSigner, channelId: Hex, maxClaimableAmount: string, network: string): Promise<VoucherFields> {
  const signature = await signer.signTypedData({
    domain: batchSettlementDomain(evmChainId(network)),
    types: voucherTypes,
    primaryType: "Voucher",
    message: { channelId, maxClaimableAmount: BigInt(maxClaimableAmount) },
  });
  return { channelId, maxClaimableAmount, signature };
}

/**
 * Voucher signature check: by payerAuthorizer when it is set, else by the
 * payer (EOA only here), as the binding's facilitator does.
 */
export async function verifyVoucherSignature(config: ChannelConfig, voucher: VoucherFields, network: string): Promise<boolean> {
  const signerAddress = getAddress(config.payerAuthorizer) !== ZERO_ADDRESS ? config.payerAuthorizer : config.payer;
  try {
    return await verifyTypedData({
      address: getAddress(signerAddress),
      domain: batchSettlementDomain(evmChainId(network)),
      types: voucherTypes,
      primaryType: "Voucher",
      message: { channelId: voucher.channelId, maxClaimableAmount: BigInt(voucher.maxClaimableAmount) },
      signature: voucher.signature,
    });
  } catch {
    return false;
  }
}

/**
 * Shape check for a batch-settlement voucher payload, with every number in
 * the range its EIP-712 type allows (withdrawDelay is uint40,
 * maxClaimableAmount uint128), so hashing it can never throw.
 */
export function isBatchVoucherPayload(p: unknown): p is BatchVoucherPayload {
  const x = p as BatchVoucherPayload;
  const c = x?.channelConfig;
  const v = x?.voucher;
  return (
    x?.type === "voucher" &&
    typeof c === "object" &&
    c !== null &&
    [c.payer, c.payerAuthorizer, c.receiver, c.receiverAuthorizer, c.token].every((a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) &&
    Number.isSafeInteger(c.withdrawDelay) &&
    c.withdrawDelay >= 0 &&
    c.withdrawDelay < 2 ** 40 &&
    typeof c.salt === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(c.salt) &&
    typeof v === "object" &&
    v !== null &&
    typeof v.channelId === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(v.channelId) &&
    uintString(v.maxClaimableAmount, 128) &&
    typeof v.signature === "string" &&
    /^0x[0-9a-fA-F]+$/.test(v.signature)
  );
}
