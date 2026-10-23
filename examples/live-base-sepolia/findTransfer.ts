/**
 * findExactTransfer for a live chain: the transaction that executed an
 * EIP-3009 authorization, whoever submitted it, and what it moved. The log
 * uses it when its own submission of a share fails, because anyone holding
 * the signed authorization (the relaying seller among them) may have
 * submitted it first; if that transaction paid the fund the share's amount,
 * the share is collected all the same.
 *
 * FiatToken's _transferWithAuthorization marks the nonce used, which emits
 * AuthorizationUsed(authorizer, nonce), and then transfers, which emits
 * Transfer(from, to, value): the Transfer is the log right after it in the
 * same transaction. Public RPC endpoints limit eth_getLogs ranges (Base
 * Sepolia's public endpoint allows 200 blocks per request), so the search
 * walks back from the latest block in chunks of `chunkBlocks`, over at most
 * `lookbackBlocks`. That is enough for a log that looks right after its own
 * submission failed.
 */

import { getAddress, keccak256, toHex } from "viem";
import type { ExactEip3009Payload, LogChain, PaymentRequirements } from "../../src/solidarity/index.ts";

const AUTHORIZATION_USED = keccak256(toHex("AuthorizationUsed(address,bytes32)"));
const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const authorizationStateAbi = [
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

type Hex = `0x${string}`;
interface RawLog {
  address: string;
  topics: readonly Hex[];
  data: Hex;
  logIndex: number | null;
  transactionHash: Hex | null;
}

/** The reads this needs; any viem PublicClient has them. */
export interface LookupClient {
  readContract(args: Record<string, unknown>): Promise<unknown>;
  getBlockNumber(): Promise<bigint>;
  request(args: { method: "eth_getLogs"; params: [Record<string, unknown>] }): Promise<unknown>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: "success" | "reverted"; logs: readonly RawLog[] }>;
}

const topicOf = (address: string): Hex => `0x${getAddress(address).slice(2).toLowerCase().padStart(64, "0")}`;
const addressOf = (topic: Hex): string => getAddress(`0x${topic.slice(-40)}`);

export async function findExactTransferOnChain(
  client: LookupClient,
  accepted: PaymentRequirements,
  payload: ExactEip3009Payload,
  opts: { lookbackBlocks?: bigint; chunkBlocks?: bigint; fromBlock?: bigint; toBlock?: bigint } = {},
): Promise<{ transaction: string; token: string; to: string; value: bigint } | undefined> {
  const asset = getAddress(accepted.asset);
  const from = getAddress(payload.authorization.from);
  const nonce = payload.authorization.nonce;
  const used = (await client.readContract({ address: asset, abi: authorizationStateAbi, functionName: "authorizationState", args: [from, nonce] })) as boolean;
  if (!used) return undefined;
  const toBlock = opts.toBlock ?? (await client.getBlockNumber());
  const lookback = opts.lookbackBlocks ?? 2000n;
  const fromBlock = opts.fromBlock ?? (toBlock > lookback ? toBlock - lookback : 0n);
  const chunk = opts.chunkBlocks ?? 200n;
  let logs: Array<{ transactionHash: Hex; logIndex: Hex }> = [];
  for (let hi = toBlock; hi >= fromBlock && logs.length === 0; hi -= chunk) {
    const lo = hi - chunk + 1n > fromBlock ? hi - chunk + 1n : fromBlock;
    logs = (await client.request({
      method: "eth_getLogs",
      params: [{ address: asset, topics: [AUTHORIZATION_USED, topicOf(from), nonce.toLowerCase()], fromBlock: toHex(lo), toBlock: toHex(hi) }],
    })) as Array<{ transactionHash: Hex; logIndex: Hex }>;
    if (lo === fromBlock) break;
  }
  if (logs.length !== 1) return undefined; // a nonce is used once; none in range means it executed outside the window
  const hash = logs[0].transactionHash;
  const usedAt = Number(BigInt(logs[0].logIndex));
  const receipt = await client.getTransactionReceipt({ hash });
  if (receipt.status !== "success") return undefined;
  const t = receipt.logs.find(
    (l) => l.logIndex === usedAt + 1 && getAddress(l.address) === asset && l.topics[0] === TRANSFER && l.topics[1] !== undefined && addressOf(l.topics[1]) === from,
  );
  if (!t || t.topics[2] === undefined) return undefined;
  return { transaction: hash, token: asset, to: addressOf(t.topics[2]), value: BigInt(t.data) };
}

/** Give a chain the lookup, so the log can count a share someone else submitted first. */
export function withExactLookup<T extends LogChain>(chain: T, client: LookupClient, opts: { lookbackBlocks?: bigint; chunkBlocks?: bigint } = {}): T {
  chain.findExactTransfer = (accepted, payload) => findExactTransferOnChain(client, accepted, payload, opts);
  return chain;
}
