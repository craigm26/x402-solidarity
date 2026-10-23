/**
 * Everything the demo log reads from or sends to a chain, behind one
 * interface, ChainIO:
 *
 * - LiveIO: Base Sepolia. Settles through an x402 facilitator's POST /settle
 *   (FacilitatorLogChain from the Base Sepolia example; the public
 *   x402.org facilitator pays the gas) and reads the chain with viem over
 *   RPC_URL. Test USDC only, which has no value.
 * - SimIO: the repository's simulated chain (src/sim/chain.ts), for the
 *   offline tests and for `MODE=sim` under wrangler dev. Nothing real moves.
 *
 * The engine never hands an IO object to the log: the log only ever sees
 * JournalChain (journal.ts).
 */

import { createPublicClient, getAddress, http, keccak256, pad, toHex } from "viem";
import type { ExactEip3009Payload, PaymentRequirements } from "../../src/solidarity/index.ts";
import { USDC_BASE_SEPOLIA } from "../../src/solidarity/index.ts";
import { SimulatedChain } from "../../src/sim/chain.ts";
import { FacilitatorLogChain } from "../live-base-sepolia/facilitatorChain.ts";
import type { Fetch } from "../live-base-sepolia/facilitatorChain.ts";
import { findExactTransferOnChain } from "../live-base-sepolia/findTransfer.ts";
import type { LookupClient } from "../live-base-sepolia/findTransfer.ts";

export const USDC = USDC_BASE_SEPOLIA.address;
export const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

export type SettleAnswer = { ok: true; transaction: string } | { ok: false; error: string; transport: boolean };

export interface TransferFound {
  transaction: string;
  token: string;
  to: string;
  value: bigint;
}

export interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface ReceiptFacts {
  status: "success" | "reverted";
  blockNumber: bigint;
  logs: readonly ReceiptLog[];
}

export interface ChainIO {
  readonly kind: "live" | "sim";
  /** Real time in unix seconds (virtual in the simulation). */
  now(): number;
  sleep(seconds: number): Promise<void>;
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  /** USDC balance. */
  balanceOf(holder: string): Promise<bigint>;
  /** USDC authorizationState(from, nonce): true once the authorization was used. */
  authorizationState(from: string, nonce: string): Promise<boolean>;
  /** Submit an exact payment. `transport` is true when no HTTP answer came back. */
  settle(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<SettleAnswer>;
  /** The transfer that executed this authorization, searched only inside the block window. */
  findTransfer(accepted: PaymentRequirements, payload: ExactEip3009Payload, window: { fromBlock: bigint; toBlock: bigint }): Promise<TransferFound | undefined>;
  /** A transaction's receipt, or undefined if the chain does not know it (yet). */
  receipt(tx: string): Promise<ReceiptFacts | undefined>;
  /** Simulation only: give an address test tokens. */
  faucet?(to: string, amount: bigint): Promise<void>;
}

const balanceOfAbi = [{ inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" }] as const;
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

/** An HTTP answer from the facilitator, as FacilitatorLogChain words it, as opposed to no answer at all. */
const HTTP_ANSWER = /^facilitator \/settle \([0-9]{3}\)/;

export class LiveIO implements ChainIO {
  readonly kind = "live" as const;
  private readonly facilitator: FacilitatorLogChain;
  /** A viem PublicClient over RPC_URL. */
  private readonly client: ReturnType<typeof createPublicClient>;

  constructor(opts: { rpcUrl: string; facilitatorUrl: string; fetch?: Fetch }) {
    // FacilitatorLogChain calls its fetch as a method; workerd refuses a bare globalThis.fetch
    // called that way ("Illegal invocation"), so it gets a wrapper.
    const f: Fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init) as unknown as ReturnType<Fetch>);
    this.facilitator = new FacilitatorLogChain(opts.facilitatorUrl, f);
    this.client = createPublicClient({ transport: http(opts.rpcUrl, { retryCount: 3, timeout: 15_000 }) });
  }

  now(): number {
    return Math.floor(Date.now() / 1000);
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.max(0, seconds) * 1000));
  }

  chainId(): Promise<number> {
    return this.client.getChainId();
  }

  blockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  async balanceOf(holder: string): Promise<bigint> {
    return (await this.client.readContract({ address: getAddress(USDC), abi: balanceOfAbi, functionName: "balanceOf", args: [getAddress(holder)] })) as bigint;
  }

  async authorizationState(from: string, nonce: string): Promise<boolean> {
    return (await this.client.readContract({ address: getAddress(USDC), abi: authorizationStateAbi, functionName: "authorizationState", args: [getAddress(from), nonce as `0x${string}`] })) as boolean;
  }

  async settle(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<SettleAnswer> {
    const r = await this.facilitator.submitExact(accepted, payload);
    return r.ok ? r : { ok: false, error: r.error, transport: !HTTP_ANSWER.test(r.error) };
  }

  async findTransfer(accepted: PaymentRequirements, payload: ExactEip3009Payload, window: { fromBlock: bigint; toBlock: bigint }): Promise<TransferFound | undefined> {
    const latest = await this.client.getBlockNumber();
    const toBlock = window.toBlock < latest ? window.toBlock : latest;
    if (toBlock < window.fromBlock) return undefined;
    return findExactTransferOnChain(this.client as unknown as LookupClient, accepted, payload, { fromBlock: window.fromBlock, toBlock, chunkBlocks: 200n });
  }

  async receipt(tx: string): Promise<ReceiptFacts | undefined> {
    try {
      const r = await this.client.getTransactionReceipt({ hash: tx as `0x${string}` });
      return { status: r.status, blockNumber: r.blockNumber, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) };
    } catch (e) {
      if ((e as Error)?.name === "TransactionReceiptNotFoundError") return undefined;
      throw e;
    }
  }
}

// ---- the simulation ----------------------------------------------------------------------

/** Simulated block numbers follow the clock: one block every 2 seconds, as on Base. */
export const simBlockAt = (t: number): bigint => BigInt(Math.floor((t - 1_700_000_000) / 2));

const topicOf = (address: string): string => pad(getAddress(address).toLowerCase() as `0x${string}`, { size: 32 });

/**
 * The simulated chain plus what a real chain would also show: a block for
 * each transaction and its receipt with a Transfer log. Every operation that
 * changes it is an op, so the same world can be rebuilt from the ops alone
 * (the sim_ops table under wrangler dev). SIMULATED: no network, no tokens.
 */
export class SimWorld {
  readonly chain: SimulatedChain;
  readonly receipts = new Map<string, ReceiptFacts>();
  /** How often each authorization nonce executed (it must never pass 1). */
  readonly executions = new Map<string, number>();
  readonly ops: Array<{ at: number; op: string; body: unknown }> = [];
  onOp: ((at: number, op: string, body: unknown) => void) | undefined;

  constructor(now: number) {
    this.chain = new SimulatedChain({ now });
  }

  get now(): number {
    return this.chain.now;
  }

  set now(t: number) {
    this.chain.now = t;
  }

  private record(op: string, body: unknown): void {
    this.ops.push({ at: this.now, op, body });
    this.onOp?.(this.now, op, body);
  }

  mint(to: string, amount: bigint): void {
    this.chain.mint(USDC, to, amount);
    this.record("mint", { to, amount: amount.toString() });
  }

  async transferWithAuthorization(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<{ ok: true; transaction: string } | { ok: false; error: string }> {
    const r = await this.chain.transferWithAuthorization(accepted, payload);
    if (!r.ok) return r;
    const a = payload.authorization;
    const nonce = a.nonce.toLowerCase();
    this.executions.set(nonce, (this.executions.get(nonce) ?? 0) + 1);
    this.receipts.set(r.transaction, {
      status: "success",
      blockNumber: simBlockAt(this.now),
      logs: [{ address: getAddress(accepted.asset), topics: [TRANSFER_TOPIC, topicOf(a.from), topicOf(a.to)], data: pad(toHex(BigInt(a.value)), { size: 32 }) }],
    });
    this.record("twa", { accepted, payload });
    return r;
  }

  /** The same world, rebuilt from its ops (deterministic transaction hashes included). */
  static async fromOps(ops: ReadonlyArray<{ at: number; op: string; body: { to?: string; amount?: string; accepted?: PaymentRequirements; payload?: ExactEip3009Payload } }>, now: number): Promise<SimWorld> {
    const w = new SimWorld(ops[0]?.at ?? now);
    for (const o of ops) {
      w.now = o.at;
      if (o.op === "mint") w.mint(o.body.to as string, BigInt(o.body.amount as string));
      else if (o.op === "twa") {
        const r = await w.transferWithAuthorization(o.body.accepted as PaymentRequirements, o.body.payload as ExactEip3009Payload);
        if (!r.ok) throw new Error(`simulated world: op ${o.op} no longer applies (${r.error})`);
      } else throw new Error(`simulated world: unknown op ${o.op}`);
    }
    if (now > w.now) w.now = now;
    return w;
  }
}

export interface SimHooks {
  /** Before a settle reaches the simulated facilitator. Throw to stop there. */
  beforeSettle?(nonce: string, n: number): void;
  /** After the transfer executed, before the answer returns. Throw to lose the answer. */
  afterExecuted?(nonce: string, n: number): void;
  /** Replace the facilitator's answer (the transfer has executed or not, as it did). */
  answer?(nonce: string, n: number, real: SettleAnswer): SettleAnswer;
  /** Settle without executing: the facilitator refuses with this answer. */
  refuse?(nonce: string, n: number): SettleAnswer | undefined;
  /** Throw from every read (an RPC endpoint that is down). */
  rpcDown?(): boolean;
}

/** ChainIO over a SimWorld. `gate` runs on every call (the output gate in the tests). */
export class SimIO implements ChainIO {
  readonly kind = "sim" as const;
  readonly world: SimWorld;
  hooks: SimHooks;
  chainIdValue = 84532;
  /** Every call, by name, for tests that count them. */
  readonly calls: string[] = [];
  private settles = 0;
  private readonly gate: () => void;
  private readonly onClock: (t: number) => void;

  constructor(world: SimWorld, opts: { hooks?: SimHooks; gate?: () => void; onClock?: (t: number) => void } = {}) {
    this.world = world;
    this.hooks = opts.hooks ?? {};
    this.gate = opts.gate ?? (() => undefined);
    this.onClock = opts.onClock ?? (() => undefined);
  }

  private call(name: string): void {
    this.calls.push(name);
    this.gate();
  }

  private read(name: string): void {
    this.call(name);
    if (this.hooks.rpcDown?.()) throw new Error("simulated RPC endpoint is down");
  }

  now(): number {
    return this.world.now;
  }

  /** Virtual time: sleeping moves the simulated clock. */
  async sleep(seconds: number): Promise<void> {
    this.world.now += Math.max(0, Math.ceil(seconds));
    this.onClock(this.world.now);
  }

  advance(seconds: number): void {
    this.world.now += seconds;
    this.onClock(this.world.now);
  }

  async chainId(): Promise<number> {
    this.read("chainId");
    return this.chainIdValue;
  }

  async blockNumber(): Promise<bigint> {
    this.read("blockNumber");
    return simBlockAt(this.world.now);
  }

  async balanceOf(holder: string): Promise<bigint> {
    this.read("balanceOf");
    return this.world.chain.balanceOf(USDC, holder);
  }

  async authorizationState(from: string, nonce: string): Promise<boolean> {
    this.read("authorizationState");
    return this.world.chain.authorizationState(USDC, from, nonce);
  }

  async settle(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<SettleAnswer> {
    this.call("settle");
    const n = ++this.settles;
    const nonce = payload.authorization.nonce.toLowerCase();
    this.hooks.beforeSettle?.(nonce, n);
    const refused = this.hooks.refuse?.(nonce, n);
    if (refused) return refused;
    const r = await this.world.transferWithAuthorization(accepted, payload);
    this.hooks.afterExecuted?.(nonce, n);
    const real: SettleAnswer = r.ok ? r : { ok: false, error: `facilitator /settle (200): ${r.error}`, transport: false };
    return this.hooks.answer ? this.hooks.answer(nonce, n, real) : real;
  }

  async findTransfer(accepted: PaymentRequirements, payload: ExactEip3009Payload, window: { fromBlock: bigint; toBlock: bigint }): Promise<TransferFound | undefined> {
    this.read("findTransfer");
    const t = await this.world.chain.findExactTransfer(accepted, payload);
    if (!t) return undefined;
    const block = this.world.receipts.get(t.transaction)?.blockNumber;
    if (block === undefined || block < window.fromBlock || block > window.toBlock) return undefined;
    return t;
  }

  async receipt(tx: string): Promise<ReceiptFacts | undefined> {
    this.read("receipt");
    return this.world.receipts.get(tx) ?? [...this.world.receipts].find(([k]) => k.toLowerCase() === tx.toLowerCase())?.[1];
  }

  async faucet(to: string, amount: bigint): Promise<void> {
    this.call("faucet");
    this.world.mint(to, amount);
  }
}
