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
 *
 * The same file gives the log what it reads before it reports an exact share
 * uncollected under draft 3 (solidarity.md, "Share kinds"):
 * `authorizationState` (true once used or cancelled) and, since USDC's
 * authorizationState cannot tell a cancellation from a use, its
 * AuthorizationCanceled(authorizer, nonce) event, searched the same way. A
 * cancellation older than the window is not found, and the share then stays
 * queued rather than being reported uncollected. It also gives the latest
 * block's timestamp (`blockTime`): block time, not the log's clock, decides
 * that a share's validBefore has passed, and the log reads the state only
 * after it, so at that block or a later one.
 */

import { getAddress, keccak256, toHex } from "viem";
import type { ExactEip3009Payload, LogChain, PaymentRequirements } from "../../src/solidarity/index.ts";

const AUTHORIZATION_USED = keccak256(toHex("AuthorizationUsed(address,bytes32)"));
const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const AUTHORIZATION_CANCELED = keccak256(toHex("AuthorizationCanceled(address,bytes32)"));
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
  getBlock(): Promise<{ timestamp: bigint }>;
  request(args: { method: "eth_getLogs"; params: [Record<string, unknown>] }): Promise<unknown>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: "success" | "reverted"; logs: readonly RawLog[] }>;
}

const topicOf = (address: string): Hex => `0x${getAddress(address).slice(2).toLowerCase().padStart(64, "0")}`;
const addressOf = (topic: Hex): string => getAddress(`0x${topic.slice(-40)}`);

type SearchOptions = { lookbackBlocks?: bigint; chunkBlocks?: bigint; fromBlock?: bigint; toBlock?: bigint };

/** EIP-3009 authorizationState(from, nonce) on the share's token: true once the authorization was used or cancelled. */
export async function authorizationUsedOnChain(client: LookupClient, accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<boolean> {
  const used = await client.readContract({ address: getAddress(accepted.asset), abi: authorizationStateAbi, functionName: "authorizationState", args: [getAddress(payload.authorization.from), payload.authorization.nonce] });
  if (typeof used !== "boolean") throw new Error("authorizationState did not return a bool");
  return used;
}

/** The latest block's timestamp, in Unix seconds. */
export async function blockTimeOnChain(client: LookupClient): Promise<number> {
  const b = await client.getBlock();
  if (typeof b?.timestamp !== "bigint") throw new Error("the latest block has no timestamp");
  return Number(b.timestamp);
}

/** The token's logs of one event for this payer and nonce, walking back from the latest block in chunks, stopping at the first chunk with any. */
async function searchLogs(client: LookupClient, accepted: PaymentRequirements, payload: ExactEip3009Payload, event: Hex, opts: SearchOptions): Promise<Array<{ transactionHash: Hex; logIndex: Hex }>> {
  const asset = getAddress(accepted.asset);
  const from = getAddress(payload.authorization.from);
  const toBlock = opts.toBlock ?? (await client.getBlockNumber());
  const lookback = opts.lookbackBlocks ?? 2000n;
  const fromBlock = opts.fromBlock ?? (toBlock > lookback ? toBlock - lookback : 0n);
  const chunk = opts.chunkBlocks ?? 200n;
  let logs: Array<{ transactionHash: Hex; logIndex: Hex }> = [];
  for (let hi = toBlock; hi >= fromBlock && logs.length === 0; hi -= chunk) {
    const lo = hi - chunk + 1n > fromBlock ? hi - chunk + 1n : fromBlock;
    logs = (await client.request({
      method: "eth_getLogs",
      params: [{ address: asset, topics: [event, topicOf(from), payload.authorization.nonce.toLowerCase()], fromBlock: toHex(lo), toBlock: toHex(hi) }],
    })) as Array<{ transactionHash: Hex; logIndex: Hex }>;
    if (lo === fromBlock) break;
  }
  return logs;
}

/**
 * Whether the token emitted AuthorizationCanceled for this payer and nonce in the searched
 * window. Asked only for an authorization whose state already reads used (so it was used or
 * cancelled, never both).
 */
export async function authorizationCanceledOnChain(client: LookupClient, accepted: PaymentRequirements, payload: ExactEip3009Payload, opts: SearchOptions = {}): Promise<boolean> {
  if (!(await authorizationUsedOnChain(client, accepted, payload))) return false;
  return (await searchLogs(client, accepted, payload, AUTHORIZATION_CANCELED, opts)).length > 0;
}

export async function findExactTransferOnChain(
  client: LookupClient,
  accepted: PaymentRequirements,
  payload: ExactEip3009Payload,
  opts: SearchOptions = {},
): Promise<{ transaction: string; token: string; to: string; value: bigint } | undefined> {
  const asset = getAddress(accepted.asset);
  const from = getAddress(payload.authorization.from);
  if (!(await authorizationUsedOnChain(client, accepted, payload))) return undefined;
  const logs = await searchLogs(client, accepted, payload, AUTHORIZATION_USED, opts);
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

/**
 * Give a chain the lookups, so the log can count a share someone else submitted first, and can
 * show a share uncollected once the chain, read at a block at or after its validBefore, shows
 * its authorization unused or cancelled.
 */
export function withExactLookup<T extends LogChain>(chain: T, client: LookupClient, opts: { lookbackBlocks?: bigint; chunkBlocks?: bigint } = {}): T {
  chain.blockTime = () => blockTimeOnChain(client);
  chain.findExactTransfer = (accepted, payload) => findExactTransferOnChain(client, accepted, payload, opts);
  chain.authorizationUsed = (accepted, payload) => authorizationUsedOnChain(client, accepted, payload);
  chain.authorizationCanceled = (accepted, payload) => authorizationCanceledOnChain(client, accepted, payload, opts);
  return chain;
}
