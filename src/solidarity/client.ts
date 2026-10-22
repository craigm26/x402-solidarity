/**
 * Client-side (policy holder) utilities for the solidarity extension.
 *
 * Separate mode: the client holds the owner's policy, signs its own payment
 * for the share and carries it in `extensions.solidarity` next to the
 * purchase payment ("x402 binding (separate mode)").
 *
 * Processor mode puts nothing on the x402 wire. The only client-side pieces
 * are the mandate constraint that carries the policy to a processor and the
 * rule that a client acting under such a mandate adds no share of its own.
 */

import { getAddress } from "viem";
import type { CapCounter } from "./policy.ts";
import { assertPolicy } from "./policy.ts";
import type {
  ChannelSnapshot,
  DescriptorAccept,
  LogDescriptor,
  LogEntry,
  OwnerPolicy,
  PaymentRequirements,
  ShareKind,
  SolidarityExtension,
  SolidarityInfo,
  SolidarityOutcome,
} from "./types.ts";
import { SOLIDARITY, SOLIDARITY_VERSION } from "./types.ts";
import { solidaritySchema } from "./schema.ts";
import type { ChannelConfig, Hex, TypedDataSigner } from "./evm.ts";
import { computeChannelId, signEip3009, signVoucher } from "./evm.ts";
import { generateShareId, parseCaip10, periodOf, sameAccount, shareMax } from "./utils.ts";
import { isSolidarityExtension } from "./validation.ts";

/** Payment flow of an `accepts` entry (x402 v2 section 6.1), with each scheme's default. */
export function resolveFlow(req: PaymentRequirements): string {
  const declared = req.extra?.paymentFlow;
  if (typeof declared === "string") return declared;
  switch (req.scheme) {
    case "exact":
      return "authorization";
    case "upto":
      return req.network.startsWith("solana:") ? "escrow" : "authorization";
    case "auth-capture":
      return "escrow";
    case "batch-settlement":
      return "voucher";
    default:
      return "unknown";
  }
}

/**
 * Share kinds a purchase can carry ("Purchases that can carry a share"):
 * exact shares only with exact purchases; never on `escrow` flows; nothing for
 * other schemes.
 */
export function shareKindsFor(req: PaymentRequirements): ShareKind[] {
  const flow = resolveFlow(req);
  if (flow === "escrow") return [];
  switch (req.scheme) {
    case "exact":
      return flow === "authorization" || flow === "upfront" ? ["exact", "batch-settlement"] : [];
    case "upto":
      return flow === "authorization" ? ["batch-settlement"] : [];
    case "batch-settlement":
      return ["batch-settlement"];
    case "auth-capture":
      return flow === "authorization" ? ["batch-settlement"] : [];
    default:
      return [];
  }
}

/** The descriptor entry for a network, asset and kind, if the log lists one. */
export function descriptorEntry(descriptor: LogDescriptor, network: string, asset: string, kind: ShareKind): DescriptorAccept | undefined {
  return descriptor.accepts?.find((a) => a.network === network && sameAccount(a.asset, asset) && a.scheme === kind);
}

/** A batch-settlement channel as the client tracks it. Shares on one channel are serialized. */
export interface ClientChannel {
  network: string;
  config: ChannelConfig;
  channelId: Hex;
  chargedCumulativeAmount: string;
  snapshot?: ChannelSnapshot;
  busy: boolean;
}

export function openClientChannel(network: string, config: ChannelConfig): ClientChannel {
  return { network, config, channelId: computeChannelId(config, network), chargedCumulativeAmount: "0", busy: false };
}

/** Apply the snapshot from a solidarity outcome; frees the channel for the next share. */
export function applyOutcomeToChannel(channel: ClientChannel, outcome: SolidarityOutcome | undefined): void {
  channel.busy = false;
  const snap = outcome?.channel;
  if (snap && snap.channelId.toLowerCase() === channel.channelId.toLowerCase()) {
    channel.chargedCumulativeAmount = snap.chargedCumulativeAmount;
    channel.snapshot = snap;
  }
}

export interface ShareContext {
  policy: OwnerPolicy;
  counter: CapCounter;
  signer: TypedDataSigner;
  /** The chosen log's descriptor (GET <log>), fetched by the caller. */
  descriptor: LogDescriptor;
  /** Unix seconds; defaults to the clock. */
  now?: number;
}

export interface BuildShareInput {
  /** `PaymentRequired.extensions.solidarity.info` as the seller declared it; absent in the fallback. */
  declared?: SolidarityInfo;
  /** The purchase's chosen `accepts` entry. */
  accepted: PaymentRequirements;
  /** The purchase's EIP-3009 window, when there is one; the share's validBefore is no later. */
  purchaseWindow?: { validAfter: string; validBefore: string };
  /** Fallback only: a log the client knows out of band runs at the purchase's facilitator. */
  fallbackLog?: string;
  /** Preferred share kind. Default: exact when allowed and at or above minAmount, else batch-settlement. */
  kind?: ShareKind;
  /** Required for batch-settlement shares. */
  channel?: ClientChannel;
  /** Holder named by a mandate this purchase is made under; if it is not this client, no share is added. */
  mandateHolder?: string;
  /** This client's own holder id, compared with mandateHolder. */
  self?: string;
  /** Test hook: a fixed id or nonce for reproducible vectors. Never set in production. */
  fixedId?: string;
  fixedNonce?: Hex;
}

export type ShareDecision =
  | { attached: true; info: SolidarityInfo; kind: ShareKind; amount: bigint; period: string }
  | { attached: false; why: string };

/**
 * Decide whether to add a share and, if so, build and sign the full
 * `extensions.solidarity.info`. Counts the share against the cap when it signs.
 */
export async function buildShare(ctx: ShareContext, input: BuildShareInput): Promise<ShareDecision> {
  const { policy, counter, signer, descriptor } = ctx;
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  assertPolicy(policy, "separate");
  const req = input.accepted;

  if (input.mandateHolder !== undefined && input.mandateHolder !== input.self) {
    return { attached: false, why: "a mandate names another holder for this policy" };
  }
  if (counter.isOff) return { attached: false, why: "policy is off" };

  // Which log: the declared entry for (network, scheme), or the fallback log.
  let log: string | undefined;
  const fallback = !input.declared;
  if (input.declared) {
    log = input.declared.logs?.find((l: LogEntry) => l.network === req.network && l.scheme === req.scheme)?.log;
    if (!log) return { attached: false, why: "the seller declared no log for this network and scheme" };
  } else {
    log = input.fallbackLog;
    if (!log) return { attached: false, why: "no declaration and no fallback log" };
  }
  if (policy.logs && !policy.logs.includes(log)) return { attached: false, why: "the owner does not trust this log" };
  if (descriptor.log !== log) return { attached: false, why: "descriptor is for another log" };

  // Fund, network and asset.
  const fund = parseCaip10(policy.fund);
  if (fund.chain !== req.network) return { attached: false, why: "the fund is on another network" };
  if (!descriptor.funds.some((f) => sameAccount(f, policy.fund))) return { attached: false, why: "the log does not list this fund" };
  // Spec choice: the cap is {amount, asset} with no exchange rate, so only purchases in the
  // cap's asset can carry a share. An owner paying in two assets holds two policies.
  if (!counter.counts(req.asset)) return { attached: false, why: "the cap is counted in another asset" };

  // Kind.
  let kinds = shareKindsFor(req);
  if (fallback) kinds = kinds.filter((k) => k === "batch-settlement"); // never exact in the fallback
  if (input.kind) kinds = kinds.filter((k) => k === input.kind);
  kinds = kinds.filter((k) => descriptorEntry(descriptor, req.network, req.asset, k));
  if (kinds.length === 0) return { attached: false, why: "no share kind fits this purchase and log" };

  // Amount.
  const period = periodOf(now);
  const amount = shareMax(req.amount, policy.rate, counter.left(period));
  if (amount <= 0n) return { attached: false, why: "share is zero (rate floor or cap reached)" };

  let kind: ShareKind | undefined;
  for (const k of kinds) {
    if (k === "exact") {
      const min = BigInt(descriptorEntry(descriptor, req.network, req.asset, "exact")?.minAmount ?? "1");
      if (amount >= min) {
        kind = "exact";
        break;
      }
    } else if (input.channel) {
      kind = "batch-settlement";
      break;
    }
  }
  if (!kind) return { attached: false, why: "below the exact minimum and no batch-settlement channel" };

  const entry = descriptorEntry(descriptor, req.network, req.asset, kind) as DescriptorAccept;
  const accepted: PaymentRequirements = {
    scheme: kind,
    network: req.network,
    amount: amount.toString(),
    asset: req.asset,
    payTo: fund.address,
    maxTimeoutSeconds: entry.maxTimeoutSeconds,
    ...(entry.extra ? { extra: { ...entry.extra } } : {}),
  };

  const id = input.fixedId ?? generateShareId();
  let payload: Record<string, unknown>;
  let validBefore: number | undefined;
  if (kind === "exact") {
    validBefore = now + entry.maxTimeoutSeconds;
    if (input.purchaseWindow) validBefore = Math.min(validBefore, Number(input.purchaseWindow.validBefore));
    const validAfter = input.purchaseWindow?.validAfter ?? "0";
    const signed = await signEip3009(signer, accepted, { validAfter, validBefore: String(validBefore), nonce: input.fixedNonce });
    payload = signed as unknown as Record<string, unknown>;
  } else {
    const ch = input.channel as ClientChannel;
    if (ch.busy) return { attached: false, why: "a share is in flight on this channel (serialize, or use another salt)" };
    if (!sameAccount(ch.config.receiver, fund.address)) return { attached: false, why: "channel receiver is not the fund" };
    if (!sameAccount(ch.config.receiverAuthorizer, String(entry.extra?.receiverAuthorizer ?? ""))) {
      return { attached: false, why: "channel receiverAuthorizer is not the log's" };
    }
    if (ch.config.withdrawDelay < (descriptor.minWithdrawDelay ?? 0)) return { attached: false, why: "channel withdrawDelay below the log's minimum" };
    const max = (BigInt(ch.chargedCumulativeAmount) + amount).toString();
    const voucher = await signVoucher(signer, ch.channelId, max, req.network);
    payload = { type: "voucher", channelConfig: ch.config, voucher };
    ch.busy = true;
  }

  // Counted when signed, at the signed amount ("whatever status is reported later"). For an
  // upto purchase that settles for less, the log records less but the cap keeps the signed amount.
  counter.commit({ id, amount, period, kind, validBefore });

  const info: SolidarityInfo = {
    version: SOLIDARITY_VERSION,
    ...(input.declared?.logs ? { logs: input.declared.logs } : {}),
    log,
    id,
    rate: policy.rate,
    fund: policy.fund,
    payment: { accepted, payload },
  };
  return { attached: true, info, kind, amount, period };
}

/**
 * Mirror of appendPaymentIdentifierToExtensions: completes the seller's
 * declaration in place when the policy allows a share. In the fallback
 * (`input.fallbackLog`, no declaration) it adds the extension with its schema.
 */
export async function appendSolidarityToExtensions(
  extensions: Record<string, unknown>,
  ctx: ShareContext,
  input: Omit<BuildShareInput, "declared">,
): Promise<ShareDecision> {
  const existing = extensions[SOLIDARITY];
  const declared = isSolidarityExtension(existing) ? existing.info : undefined;
  if (!declared && !input.fallbackLog) return { attached: false, why: "the seller did not declare solidarity" };
  const decision = await buildShare(ctx, { ...input, declared });
  if (!decision.attached) return decision;
  if (declared) {
    // Append, never delete or overwrite (x402 v2 section 5.1.2).
    Object.assign((existing as SolidarityExtension).info, decision.info);
  } else {
    extensions[SOLIDARITY] = { info: decision.info, schema: solidaritySchema };
  }
  return decision;
}

/** Read the solidarity outcome from a SettleResponse (unsigned; keep channel state with it, never treat it as proof). */
export function readOutcome(settleResponse: { extensions?: Record<string, unknown> }): SolidarityOutcome | undefined {
  const ext = settleResponse.extensions?.[SOLIDARITY] as { info?: SolidarityOutcome } | undefined;
  return ext?.info;
}

// ---- processor mode: fields only ---------------------------------------------

/** Minor-unit exponents for the ISO 4217 codes the examples use. Extend as needed. */
export const ISO4217_EXPONENT: Record<string, number> = { USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, CHF: 2, JPY: 0, KRW: 0 };

function minorToDecimal(amount: string, exponent: number): string {
  if (exponent === 0) return amount;
  const s = amount.padStart(exponent + 1, "0");
  return `${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
}

/**
 * The AP2-style mandate constraint that carries a processor-mode policy
 * ("AP2 and ACP notes", informative). The cap is written as a decimal
 * currency amount there; the policy holds it in minor units of an ISO 4217
 * code, so `cap.asset` must be such a code.
 */
export function processorConstraint(policy: OwnerPolicy, opts: { holder: string; log: string }) {
  assertPolicy(policy, "processor");
  const exp = ISO4217_EXPONENT[policy.cap.asset];
  if (exp === undefined) throw new Error(`cap.asset ${policy.cap.asset} is not an ISO 4217 code this helper knows`);
  return {
    type: SOLIDARITY,
    holder: opts.holder,
    rate: policy.rate,
    cap: { amount: minorToDecimal(policy.cap.amount, exp), currency: policy.cap.asset },
    fund: policy.fund,
    refunds: policy.refunds ?? "keep",
    log: opts.log,
  };
}

/**
 * "Exactly one policy holder applies a share to any purchase." A client acting
 * under a mandate whose solidarity constraint names another holder must not
 * add `extensions.solidarity`.
 */
export function mayAttachShare(mandateConstraints: Array<{ type?: string; holder?: string }> | undefined, self: string): boolean {
  const c = mandateConstraints?.find((x) => x?.type === SOLIDARITY);
  return !c || c.holder === self;
}

/** Checksummed form of the account part of a CAIP-10 fund (for display). */
export const fundAddress = (fund: string): string => getAddress(parseCaip10(fund).address);
