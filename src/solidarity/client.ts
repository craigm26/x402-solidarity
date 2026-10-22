/**
 * Client-side (policy holder) utilities for the solidarity extension.
 *
 * Separate mode: the client holds the owner's policy, signs its own payment
 * for the share and carries it in `extensions.solidarity` next to the
 * purchase payment ("Advertisement", "`PaymentRequired` and `PaymentPayload`").
 *
 * Processor mode puts nothing on the x402 wire. The only client-side pieces
 * are the mandate constraint that carries the policy to a processor and the
 * rule that a client acting under such a mandate adds no share of its own.
 */

import { getAddress } from "viem";
import type { CapCounter } from "./policy.ts";
import { assertPolicy, policyProblems } from "./policy.ts";
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
import { AP2_CONSTRAINT_TYPE, SOLIDARITY, SOLIDARITY_VERSION } from "./types.ts";
import type { Ap2SolidarityConstraint } from "./types.ts";
import { solidaritySchema } from "./schema.ts";
import type { ChannelConfig, Hex, TypedDataSigner } from "./evm.ts";
import { computeChannelId, signEip3009, signVoucher, verifyVoucherSignature } from "./evm.ts";
import { generateShareId, isPositiveAmount, parseCaip10, periodOf, sameAccount, shareMax, shareNonce } from "./utils.ts";
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
 * exact shares only with exact purchases; never on `escrow` flows or
 * `batch-settlement` purchases (whose charge the log never sees); nothing for
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
  /** The client's own charged cumulative amount: never copied from a snapshot except by resyncChannel. */
  chargedCumulativeAmount: string;
  /** The last snapshot seen, for display only. Untrusted (it passes through the seller). */
  snapshot?: ChannelSnapshot;
  busy: boolean;
  /** The share signed on this channel and not yet applied. */
  inFlight?: { id: string; amount: string };
}

export function openClientChannel(network: string, config: ChannelConfig): ClientChannel {
  return { network, config, channelId: computeChannelId(config, network), chargedCumulativeAmount: "0", busy: false };
}

const isUint = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);

/**
 * Apply a solidarity outcome to the channel and free it for the next share
 * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Optional share kind: `batch-settlement`";
 * the binding's client verification rules).
 * The snapshot is untrusted: when the share was accepted with a reported
 * amount at most what it signed, the new state is the previous one plus the
 * amount this share signed (the log advances chargedCumulativeAmount by the
 * signed amount even when it records less, so no voucher leaves headroom
 * another share could spend); when it was skipped, or the entry is missing,
 * the state stays as it was. If a snapshot is present, its
 * chargedCumulativeAmount must agree. Returns false when the state is left
 * unchanged; after a cumulative-mismatch, call resyncChannel.
 */
export function applyOutcomeToChannel(channel: ClientChannel, outcome: SolidarityOutcome | undefined): boolean {
  const f = channel.inFlight;
  channel.busy = false;
  channel.inFlight = undefined;
  const snap = outcome?.channel;
  const sameChannel = !!snap && typeof snap.channelId === "string" && snap.channelId.toLowerCase() === channel.channelId.toLowerCase();
  if (sameChannel) channel.snapshot = snap;
  if (!f) return false;
  if (outcome && outcome.id !== f.id) return false;
  let advance = 0n;
  if (outcome?.status === "accepted") {
    if (!isPositiveAmount(outcome.amount) || BigInt(outcome.amount) > BigInt(f.amount)) return false;
    advance = BigInt(f.amount);
  }
  const next = BigInt(channel.chargedCumulativeAmount) + advance;
  if (snap && (!sameChannel || !isUint(snap.chargedCumulativeAmount) || BigInt(snap.chargedCumulativeAmount) !== next)) return false;
  channel.chargedCumulativeAmount = next.toString();
  return true;
}

/**
 * Recover after a cumulative-mismatch: adopt the log's chargedCumulativeAmount
 * only when the snapshot carries a voucher this client signed (`signature`
 * over `signedMaxClaimable`) and the amount is at most that ceiling, as with
 * the binding's Corrective 402. Returns true when the state was adopted.
 */
export async function resyncChannel(channel: ClientChannel, snap: ChannelSnapshot | undefined): Promise<boolean> {
  if (channel.busy || !snap || typeof snap.channelId !== "string" || snap.channelId.toLowerCase() !== channel.channelId.toLowerCase()) return false;
  const { signedMaxClaimable: max, signature, chargedCumulativeAmount: charged } = snap;
  if (!isUint(max) || !isUint(charged) || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return false;
  if (BigInt(charged) > BigInt(max)) return false;
  const ok = await verifyVoucherSignature(channel.config, { channelId: channel.channelId, maxClaimableAmount: max, signature: signature as Hex }, channel.network);
  if (!ok) return false;
  channel.chargedCumulativeAmount = charged;
  return true;
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
  /** The purchase's EIP-3009 window, when there is one; the share's validBefore is at least maxTimeoutSeconds later. */
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
  /** Test hook: a fixed id for reproducible vectors (the nonce follows from it). Never set in production. */
  fixedId?: string;
}

export type ShareDecision =
  | { attached: true; info: SolidarityInfo; kind: ShareKind; amount: bigint; period: string }
  | { attached: false; why: string };

/**
 * Decide whether to add a share and, if so, build and sign the full
 * `extensions.solidarity.info`. Counts the share against the cap before it
 * signs. Never rejects: a share never blocks the purchase, so anything that
 * goes wrong is `{attached: false, why}` and the purchase goes ahead without one.
 */
export async function buildShare(ctx: ShareContext, input: BuildShareInput): Promise<ShareDecision> {
  try {
    return await buildShareOrThrow(ctx, input);
  } catch (e) {
    return { attached: false, why: `no share: ${(e as Error)?.message ?? String(e)}` };
  }
}

async function buildShareOrThrow(ctx: ShareContext, input: BuildShareInput): Promise<ShareDecision> {
  const { policy, counter, signer, descriptor } = ctx;
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  const problems = policyProblems(policy, "separate");
  if (problems.length) return { attached: false, why: `invalid owner policy: ${problems.join("; ")}` };
  const req = input.accepted;

  // "A server's info MUST contain only version and logs." Anything else would be the seller
  // choosing the log, rate, fund or id, and x402 lets the client append but never overwrite.
  if (input.declared && Object.keys(input.declared).some((k) => k !== "version" && k !== "logs")) {
    return { attached: false, why: "the seller's info carries more than version and logs" };
  }
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
  let validBefore: number | undefined;
  let ch: ClientChannel | undefined;
  let max = "";
  if (kind === "exact") {
    // At least maxTimeoutSeconds after the purchase's validBefore, so the log can still
    // submit the transfer after the purchase settles.
    const purchaseEnd = input.purchaseWindow ? Number(input.purchaseWindow.validBefore) : now + entry.maxTimeoutSeconds;
    validBefore = purchaseEnd + entry.maxTimeoutSeconds;
  } else {
    ch = input.channel as ClientChannel;
    if (ch.busy) return { attached: false, why: "a share is in flight on this channel (serialize, or use another salt)" };
    if (!sameAccount(ch.config.receiver, fund.address)) return { attached: false, why: "channel receiver is not the fund" };
    if (!sameAccount(ch.config.receiverAuthorizer, String(entry.extra?.receiverAuthorizer ?? ""))) {
      return { attached: false, why: "channel receiverAuthorizer is not the log's" };
    }
    if (!sameAccount(ch.config.token, req.asset)) return { attached: false, why: "channel token is not the purchase's asset" };
    if (ch.config.withdrawDelay !== entry.extra?.withdrawDelay) return { attached: false, why: "channel withdrawDelay is not the log's" };
    max = (BigInt(ch.chargedCumulativeAmount) + amount).toString();
  }

  // Reserve before the first await, so concurrent shares can neither pass the cap nor
  // sign two vouchers on one channel base. Counted at the signed amount ("whatever status is
  // reported later"): for an upto purchase that settles for less, the cap keeps the signed amount.
  counter.commit({ id, amount, period, kind, validBefore });
  if (ch) {
    ch.busy = true;
    ch.inFlight = { id, amount: amount.toString() };
  }
  let payload: Record<string, unknown>;
  try {
    if (kind === "exact") {
      const validAfter = input.purchaseWindow?.validAfter ?? "0";
      const signed = await signEip3009(signer, accepted, { validAfter, validBefore: String(validBefore), nonce: shareNonce(id) });
      payload = signed as unknown as Record<string, unknown>;
    } else {
      const c = ch as ClientChannel;
      const voucher = await signVoucher(signer, c.channelId, max, req.network);
      payload = { type: "voucher", channelConfig: c.config, voucher };
    }
  } catch (e) {
    // Nothing was signed: give the room back and free the channel.
    counter.abort(id);
    if (ch) {
      ch.busy = false;
      ch.inFlight = undefined;
    }
    return { attached: false, why: `signing failed: ${(e as Error)?.message ?? String(e)}` };
  }

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

/** Read the solidarity outcome from a SettleResponse (unsigned: never proof; see applyOutcomeToChannel for channel state). */
export function readOutcome(settleResponse: { extensions?: Record<string, unknown> }): SolidarityOutcome | undefined {
  const ext = settleResponse.extensions?.[SOLIDARITY] as { info?: SolidarityOutcome } | undefined;
  return ext?.info;
}

// ---- processor mode: fields only ---------------------------------------------

/**
 * The AP2 Payment Mandate Constraint that carries a processor-mode policy
 * (https://craigmerry.com/solidarity-levy/spec/processor-mode.md, "AP2: a Payment Mandate Constraint",
 * informative): `type`, `holder` (the one party that applies the share) and
 * the policy's `rate`, `cap`, `fund`, `logs` and `refunds`. `cap` becomes an
 * AP2 Amount, an integer in minor units of an ISO 4217 code. The open Payment
 * Mandate's `iat` stands in for the policy's `since`, so neither it nor
 * `version` is carried.
 */
export function processorConstraint(policy: OwnerPolicy, opts: { holder: string; logs?: string[] }): Ap2SolidarityConstraint {
  assertPolicy(policy, "processor");
  const logs = opts.logs ?? policy.logs;
  if (!logs || logs.length === 0) throw new Error("the constraint names the holder's log in logs");
  if (!/^[A-Z]{3}$/.test(policy.cap.asset)) throw new Error("an AP2 constraint's cap is in an ISO 4217 currency code");
  const amount = Number(policy.cap.amount);
  if (!Number.isSafeInteger(amount)) throw new Error("cap.amount does not fit an AP2 Amount (a safe integer)");
  return {
    type: AP2_CONSTRAINT_TYPE,
    holder: opts.holder,
    rate: policy.rate,
    cap: { amount, currency: policy.cap.asset },
    fund: policy.fund,
    logs: [...logs],
    refunds: policy.refunds ?? "keep",
  };
}

/** The owner policy an AP2 constraint carries, with `since` from the open Payment Mandate's `iat`. */
export function constraintPolicy(c: Ap2SolidarityConstraint, iat: number): OwnerPolicy {
  return {
    version: 2,
    rate: c.rate,
    cap: { amount: String(c.cap.amount), asset: c.cap.currency },
    fund: c.fund,
    logs: [...c.logs],
    refunds: c.refunds ?? "keep",
    since: new Date(iat * 1000).toISOString().replace(/\.000Z$/, "Z"),
  };
}

/**
 * "Exactly one policy holder applies a share to any purchase." A client acting
 * under a mandate whose solidarity constraint names another holder must not
 * add `extensions.solidarity`.
 */
export function mayAttachShare(mandateConstraints: Array<{ type?: string; holder?: string }> | undefined, self: string): boolean {
  const c = mandateConstraints?.find((x) => x?.type === AP2_CONSTRAINT_TYPE);
  return !c || c.holder === self;
}

/** Checksummed form of the account part of a CAIP-10 fund (for display). */
export const fundAddress = (fund: string): string => getAddress(parseCaip10(fund).address);
