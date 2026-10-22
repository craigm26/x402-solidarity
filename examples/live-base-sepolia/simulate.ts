/**
 * Checks an EIP-3009 transfer against the deployed USDC contract without
 * sending anything: an eth_call of transferWithAuthorization with a state
 * override that gives the payer exactly the amount. The call runs the real
 * contract code (signature recovery, domain, nonce state, time window,
 * balance), so a share that passes here would execute on chain if the payer
 * held the amount. Needs no funds and no gas.
 *
 * The override writes the payer's entry in FiatToken's balance mapping
 * (balanceAndBlacklistStates in FiatTokenV2_2, storage slot 9; the high bit is
 * the blacklist flag, so the value written must stay below 2^255). The slot is
 * checked by reading balanceOf under the same override before the transfer is
 * simulated, so a wrong slot fails loudly instead of passing for the wrong
 * reason.
 */

import { encodeAbiParameters, getAddress, keccak256, pad, parseSignature, toHex } from "viem";
import type { ExactEip3009Payload, PaymentRequirements } from "../../src/solidarity/index.ts";

export const FIAT_TOKEN_BALANCE_SLOT = 9n;

const abi = [
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "transferWithAuthorization",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  {
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    name: "authorizationState",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** The storage slot of `account`'s entry in a Solidity mapping at `mappingSlot`. */
export function mappingSlot(account: string, mappingSlotIndex: bigint): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(account), mappingSlotIndex]));
}

/** The reads this check needs; any viem PublicClient has them. */
export interface CallClient {
  readContract(args: Record<string, unknown>): Promise<unknown>;
  simulateContract(args: Record<string, unknown>): Promise<unknown>;
}

export type SimulationResult = { ok: true; balanceUnderOverride: bigint } | { ok: false; error: string };

/**
 * `balance` is what the override gives the payer; it defaults to exactly the
 * amount. The tests set it one unit short to show the check can fail.
 */
export async function simulateExactTransfer(
  client: CallClient,
  accepted: PaymentRequirements,
  payload: ExactEip3009Payload,
  opts: { balance?: bigint } = {},
): Promise<SimulationResult> {
  const a = payload.authorization;
  const asset = getAddress(accepted.asset);
  const from = getAddress(a.from);
  const value = BigInt(a.value);
  const want = opts.balance ?? value;
  if (want < 0n || want >= 1n << 255n) return { ok: false, error: "balance does not fit below the blacklist bit" };
  const stateOverride = [{ address: asset, stateDiff: [{ slot: mappingSlot(from, FIAT_TOKEN_BALANCE_SLOT), value: pad(toHex(want), { size: 32 }) }] }];
  try {
    const balance = (await client.readContract({ address: asset, abi, functionName: "balanceOf", args: [from], stateOverride })) as bigint;
    if (balance !== want) return { ok: false, error: `balance override did not take (balanceOf read ${balance}, wanted ${want}): the token's storage layout is not FiatToken's` };
    const used = (await client.readContract({ address: asset, abi, functionName: "authorizationState", args: [from, a.nonce] })) as boolean;
    if (used) return { ok: false, error: "authorization nonce already used on chain" };
    const sig = parseSignature(payload.signature);
    const v = Number(sig.v ?? BigInt(sig.yParity + 27));
    await client.simulateContract({
      address: asset,
      abi,
      functionName: "transferWithAuthorization",
      args: [from, getAddress(a.to), value, BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, v, sig.r, sig.s],
      account: getAddress(a.to),
      stateOverride,
    });
    return { ok: true, balanceUnderOverride: balance };
  } catch (e) {
    return { ok: false, error: (e as Error).message.split("\n")[0] };
  }
}
