/**
 * A LogChain backed by a JSON-RPC endpoint, for the Base Sepolia example.
 * Only `exact` shares are supported here: it submits the share's EIP-3009
 * transferWithAuthorization to the USDC contract, the same call the x402
 * exact facilitator makes (the v, r, s variant of the function, from
 * eip3009ABI in typescript/packages/mechanisms/evm/src/constants.ts).
 * batch-settlement channels and claims are not wired up in this example. The
 * optional findExactTransfer is added by withExactLookup (findTransfer.ts).
 *
 * Not yet run against a live chain (the live run on 2026-10-22 used
 * FacilitatorLogChain). SIMULATE=1 in index.ts checks the same
 * transferWithAuthorization call against the deployed contract with eth_call.
 */

import type { WalletClient } from "viem";
import { getAddress, parseSignature } from "viem";
import type { ExactEip3009Payload, LogChain, PaymentRequirements, VoucherFields } from "../../src/solidarity/index.ts";

const transferWithAuthorizationAbi = [
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
] as const;

/** The one read this example needs; any viem PublicClient has it. */
export interface ReceiptWaiter {
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ status: "success" | "reverted" }>;
}

export class RpcLogChain implements LogChain {
  private readonly publicClient: ReceiptWaiter;
  private readonly walletClient: WalletClient;

  constructor(publicClient: ReceiptWaiter, walletClient: WalletClient) {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
  }

  async submitExact(accepted: PaymentRequirements, payload: ExactEip3009Payload) {
    try {
      const a = payload.authorization;
      const sig = parseSignature(payload.signature);
      const v = Number(sig.v ?? BigInt(sig.yParity + 27));
      const account = this.walletClient.account;
      if (!account) throw new Error("wallet client has no account");
      const hash = await this.walletClient.writeContract({
        account,
        chain: this.walletClient.chain,
        address: getAddress(accepted.asset),
        abi: transferWithAuthorizationAbi,
        functionName: "transferWithAuthorization",
        args: [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, v, sig.r, sig.s],
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      return receipt.status === "success" ? { ok: true as const, transaction: hash } : { ok: false as const, error: `reverted in ${hash}` };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }

  channelState(_channelId: string) {
    return undefined;
  }

  async claim(_channelId: string, _voucher: VoucherFields, _totalClaimed: bigint) {
    return { ok: false as const, error: "batch-settlement is not wired up in this example" };
  }
}
