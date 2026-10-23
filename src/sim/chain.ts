/**
 * An in-memory stand-in for Base Sepolia, for tests and the offline example.
 * SIMULATED: no network, no real tokens, nothing moves anywhere.
 *
 * It models just enough of two contracts to check the protocol end to end:
 * - a USDC-like token with EIP-3009 transferWithAuthorization (signature,
 *   validity window, nonce reuse, balance), and
 * - a batch-settlement escrow: deposits into a channel, cumulative voucher
 *   claims that raise totalClaimed, a permissionless sweep to the receiver,
 *   and a withdrawal that returns unclaimed funds to the payer.
 * Transaction hashes are deterministic (keccak256 of a counter), so runs repeat.
 */

import { getAddress, keccak256, toHex } from "viem";
import type { BatchVoucherPayload, ExactEip3009Payload, VoucherFields } from "../solidarity/evm.ts";
import { computeChannelId, verifyEip3009Signature, verifyVoucherSignature } from "../solidarity/evm.ts";
import type { LogChain } from "../solidarity/facilitator.ts";
import type { FundView } from "../solidarity/ledger.ts";
import type { PaymentRequirements } from "../solidarity/types.ts";

type Addr = string;
const lc = (a: string) => a.toLowerCase();

interface Channel {
  config: BatchVoucherPayload["channelConfig"];
  balance: bigint;
  totalClaimed: bigint;
  swept: bigint;
  withdrawRequestedAt: number;
  refundNonce: bigint;
}

export class SimulatedChain implements LogChain {
  readonly network: string;
  now: number;
  private n = 0;
  private readonly balances = new Map<string, bigint>(); // token|holder
  private readonly usedNonces = new Set<string>(); // token|from|nonce
  private readonly nonceTx = new Map<string, string>(); // token|from|nonce -> the transfer that used it
  private readonly canceled = new Set<string>(); // token|from|nonce, cancelled before use
  private readonly transfers = new Map<string, { token: Addr; from: Addr; to: Addr; value: bigint }>();
  private readonly channels = new Map<string, Channel>();
  private readonly claims = new Map<string, { channelId: string; increase: bigint }>(); // tx|channelId
  /** Every simulated transaction, in order. */
  readonly log: Array<{ tx: string; kind: string; detail: Record<string, string> }> = [];

  constructor(opts: { network?: string; now: number }) {
    this.network = opts.network ?? "eip155:84532";
    this.now = opts.now;
  }

  private txHash(kind: string): string {
    this.n += 1;
    return keccak256(toHex(`simulated-${this.network}-${kind}-${this.n}`));
  }

  balanceOf(token: Addr, holder: Addr): bigint {
    return this.balances.get(`${lc(token)}|${lc(holder)}`) ?? 0n;
  }

  private add(token: Addr, holder: Addr, delta: bigint): void {
    const k = `${lc(token)}|${lc(holder)}`;
    const v = (this.balances.get(k) ?? 0n) + delta;
    if (v < 0n) throw new Error("insufficient balance");
    this.balances.set(k, v);
  }

  /** Test faucet. Simulated tokens only. */
  mint(token: Addr, to: Addr, amount: bigint): void {
    this.add(token, to, amount);
  }

  /** A plain transfer the sender makes itself (for example, a seller's refund). */
  transfer(token: Addr, from: Addr, to: Addr, amount: bigint): string {
    this.add(token, from, -amount);
    this.add(token, to, amount);
    const tx = this.txHash("transfer");
    this.transfers.set(tx, { token, from, to, value: amount });
    this.log.push({ tx, kind: "transfer", detail: { from, to, value: amount.toString() } });
    return tx;
  }

  authorizationState(token: Addr, from: Addr, nonce: string): boolean {
    return this.usedNonces.has(`${lc(token)}|${lc(from)}|${lc(nonce)}`);
  }

  /** EIP-3009 transferWithAuthorization (the purchase or an exact share). */
  async transferWithAuthorization(requirements: PaymentRequirements, payload: ExactEip3009Payload): Promise<{ ok: true; transaction: string } | { ok: false; error: string }> {
    const a = payload.authorization;
    const token = requirements.asset;
    if (!(await verifyEip3009Signature(requirements, payload))) return { ok: false, error: "invalid signature" };
    if (!(BigInt(this.now) > BigInt(a.validAfter))) return { ok: false, error: "authorization is not yet valid" };
    if (!(BigInt(this.now) < BigInt(a.validBefore))) return { ok: false, error: "authorization is expired" };
    if (this.authorizationState(token, a.from, a.nonce)) return { ok: false, error: "authorization is used or canceled" };
    const value = BigInt(a.value);
    if (this.balanceOf(token, a.from) < value) return { ok: false, error: "transfer amount exceeds balance" };
    this.usedNonces.add(`${lc(token)}|${lc(a.from)}|${lc(a.nonce)}`);
    this.add(token, a.from, -value);
    this.add(token, a.to, value);
    const tx = this.txHash("transfer");
    this.transfers.set(tx, { token, from: a.from, to: a.to, value });
    this.nonceTx.set(`${lc(token)}|${lc(a.from)}|${lc(a.nonce)}`, tx);
    this.log.push({ tx, kind: "transferWithAuthorization", detail: { from: a.from, to: a.to, value: a.value } });
    return { ok: true, transaction: tx };
  }

  /** EIP-3009 cancelAuthorization (the signature is not modelled here). Like USDC, it refuses a used authorization. */
  cancelAuthorization(token: Addr, from: Addr, nonce: string): void {
    const k = `${lc(token)}|${lc(from)}|${lc(nonce)}`;
    if (this.usedNonces.has(k)) throw new Error("authorization is used or canceled");
    this.usedNonces.add(k);
    this.canceled.add(k);
  }

  // LogChain
  submitExact(accepted: PaymentRequirements, payload: ExactEip3009Payload) {
    return this.transferWithAuthorization(accepted, payload);
  }

  /** LogChain.authorizationUsed: EIP-3009 authorizationState, true once used or cancelled. */
  async authorizationUsed(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<boolean> {
    return this.authorizationState(accepted.asset, payload.authorization.from, payload.authorization.nonce);
  }

  /** LogChain.blockTime: the simulated chain's time stands for its latest block's timestamp. */
  async blockTime(): Promise<number> {
    return this.now;
  }

  /** LogChain.authorizationCanceled: the chain shows this authorization cancelled (USDC's AuthorizationCanceled event). */
  async authorizationCanceled(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<boolean> {
    return this.canceled.has(`${lc(accepted.asset)}|${lc(payload.authorization.from)}|${lc(payload.authorization.nonce)}`);
  }

  /** The transfer that executed this authorization, whoever submitted it (a cancelled one has none). */
  async findExactTransfer(accepted: PaymentRequirements, payload: ExactEip3009Payload) {
    const a = payload.authorization;
    const tx = this.nonceTx.get(`${lc(accepted.asset)}|${lc(a.from)}|${lc(a.nonce)}`);
    const t = tx ? this.transfers.get(tx) : undefined;
    return tx && t ? { transaction: tx, token: t.token, to: t.to, value: t.value } : undefined;
  }

  /** Open or top up a channel (the payer's deposit). */
  deposit(config: BatchVoucherPayload["channelConfig"], amount: bigint): string {
    const id = computeChannelId(config, this.network).toLowerCase();
    this.add(config.token, config.payer, -amount);
    const c = this.channels.get(id) ?? { config, balance: 0n, totalClaimed: 0n, swept: 0n, withdrawRequestedAt: 0, refundNonce: 0n };
    c.balance += amount;
    this.channels.set(id, c);
    const tx = this.txHash("deposit");
    this.log.push({ tx, kind: "deposit", detail: { channelId: id, amount: amount.toString() } });
    return id;
  }

  channelState(channelId: string) {
    const c = this.channels.get(channelId.toLowerCase());
    return c ? { balance: c.balance, totalClaimed: c.totalClaimed, withdrawRequestedAt: c.withdrawRequestedAt, refundNonce: c.refundNonce } : undefined;
  }

  channelConfig(channelId: string) {
    return this.channels.get(channelId.toLowerCase())?.config;
  }

  async claim(channelId: string, voucher: VoucherFields, totalClaimed: bigint) {
    const id = channelId.toLowerCase();
    const c = this.channels.get(id);
    if (!c) return { ok: false as const, error: "no channel" };
    if (voucher.channelId.toLowerCase() !== id) return { ok: false as const, error: "voucher is for another channel" };
    if (!(await verifyVoucherSignature(c.config, voucher, this.network))) return { ok: false as const, error: "invalid voucher" };
    if (totalClaimed <= c.totalClaimed) return { ok: false as const, error: "nothing to claim" };
    if (totalClaimed > BigInt(voucher.maxClaimableAmount)) return { ok: false as const, error: "claim exceeds voucher" };
    if (totalClaimed > c.balance) return { ok: false as const, error: "claim exceeds balance" };
    const increase = totalClaimed - c.totalClaimed;
    c.totalClaimed = totalClaimed;
    const tx = this.txHash("claim");
    this.claims.set(`${tx}|${id}`, { channelId: id, increase });
    this.log.push({ tx, kind: "claim", detail: { channelId: id, totalClaimed: totalClaimed.toString() } });
    return { ok: true as const, transaction: tx };
  }

  /** Permissionless sweep of claimed funds to each channel's receiver. */
  sweep(receiver: Addr, token: Addr): bigint {
    let moved = 0n;
    for (const c of this.channels.values()) {
      if (lc(c.config.receiver) !== lc(receiver) || lc(c.config.token) !== lc(token)) continue;
      const due = c.totalClaimed - c.swept;
      c.swept += due;
      moved += due;
    }
    if (moved > 0n) this.add(token, receiver, moved);
    return moved;
  }

  initiateWithdrawal(channelId: string): void {
    const c = this.channels.get(channelId.toLowerCase());
    if (!c) throw new Error("no channel");
    c.withdrawRequestedAt = this.now;
  }

  /** After withdrawDelay: unclaimed funds go back to the payer, and the channel can pay nothing more. */
  finalizeWithdrawal(channelId: string): bigint {
    const c = this.channels.get(channelId.toLowerCase());
    if (!c || c.withdrawRequestedAt === 0) throw new Error("no withdrawal requested");
    if (this.now < c.withdrawRequestedAt + c.config.withdrawDelay) throw new Error("withdraw delay has not elapsed");
    const back = c.balance - c.totalClaimed;
    c.balance = c.totalClaimed;
    c.withdrawRequestedAt = 0;
    this.add(c.config.token, c.config.payer, back);
    return back;
  }

  /** What a fund can read of its own receipts here. */
  fundView(): FundView {
    return {
      exactTransfer: (tx) => {
        const t = this.transfers.get(tx);
        return t ? { token: t.token, to: t.to, value: t.value } : undefined;
      },
      claimIncrease: (tx, channelId) => {
        const k = this.claims.get(`${tx}|${channelId.toLowerCase()}`);
        const c = this.channels.get(channelId.toLowerCase());
        return k && c ? { receiver: getAddress(c.config.receiver), receiverAuthorizer: c.config.receiverAuthorizer, token: c.config.token, increase: k.increase } : undefined;
      },
    };
  }
}
