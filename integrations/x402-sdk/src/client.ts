/**
 * Buyer side: the solidarity extension as an @x402/core ClientExtension.
 *
 *   client.registerExtension(solidarityClientExtension({ policy, counter, signer, descriptors }));
 *
 * The client holds the owner's policy and is the only party that adds a share
 * (solidarity.md, "Modes" and "Owner policy"). The share is built in
 * `enrichPaymentPayload`, which x402Client runs after the scheme signed the
 * purchase, so the purchase's EIP-3009 window is known and the share's
 * validBefore can be set from it ("Share kinds").
 *
 * Rules this file keeps:
 * - It is total. Any error leaves the payload exactly as the SDK built it, so a
 *   share never blocks the purchase ("Never in the way"). An exception from
 *   enrichPaymentPayload would fail the purchase in x402Client.
 * - It never mutates `paymentPayload.extensions`. When no other extension
 *   changed it, that object IS `paymentRequired.extensions`, and @x402/fetch
 *   reuses paymentRequired on its recovery path. Writing the share into it
 *   would make every later purchase see a seller declaration with extra fields
 *   and refuse to attach a share.
 * - It never delays a purchase to fetch a descriptor: a missing one means no
 *   share now, and a background refresh for later purchases.
 * - `onPaymentResponse` always returns void, never `{recovered: true}`, which
 *   would make @x402/fetch sign a second purchase (and a second share).
 */

import type { ClientExtension, PaymentResponseContext } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { applyOutcomeToChannel, buildShare, isSolidarityExtension, readOutcome, resyncChannel, SOLIDARITY, solidaritySchema } from "../../../src/solidarity/index.ts";
import type { CapCounter, ClientChannel, OwnerPolicy, ShareDecision, SolidarityInfo, SolidarityOutcome, TypedDataSigner } from "../../../src/solidarity/index.ts";
import type { DescriptorSource } from "./descriptors.ts";

export interface SolidarityClientOptions {
  /** The owner's policy (separate mode). Never sent on the wire. */
  policy: OwnerPolicy;
  /** The cap counter for that policy, shared by every client holding it. */
  counter: CapCounter;
  /** Signs the share. A viem LocalAccount serves as both this and the purchase's ClientEvmSigner. */
  signer: TypedDataSigner;
  /** Cached log descriptors (see createDescriptorCache). */
  descriptors: DescriptorSource;
  /**
   * Fallback only: a log the client knows, out of band, runs at the facilitator
   * settling this accepts entry. Only batch-settlement shares are added then.
   */
  fallbackLog?: (accepted: PaymentRequirements) => string | undefined;
  /** The owner's batch-settlement channel for this purchase, if it has one. */
  channelFor?: (accepted: PaymentRequirements) => ClientChannel | undefined;
  /** This client's holder id, and the holder a mandate names for this purchase ("Modes"). */
  self?: string;
  mandateHolder?: string;
  /** Seconds after which a channel's unanswered share is given up (default 300). */
  staleChannelSeconds?: number;
  /** Called with every decision, attached or not (for logs and tests). */
  onDecision?: (decision: ShareDecision, paymentPayload: PaymentPayload) => void;
  /** Called with the outcome from the settle response (undefined when there was none). */
  onOutcome?: (outcome: SolidarityOutcome | undefined, ctx: { id: string; paymentPayload: PaymentPayload; settleResponse?: SettleResponse }) => void;
  /** Called with errors the extension swallowed. */
  onError?: (error: unknown) => void;
}

/** The purchase's signed window: EIP-3009 `authorization`, or Permit2's witness.validAfter and deadline. */
export function purchaseWindowOf(payload: Record<string, unknown> | undefined): { validAfter: string; validBefore: string } | undefined {
  const auth = payload?.authorization as { validAfter?: unknown; validBefore?: unknown } | undefined;
  if (auth && typeof auth.validAfter === "string" && typeof auth.validBefore === "string") return { validAfter: auth.validAfter, validBefore: auth.validBefore };
  const p2 = payload?.permit2Authorization as { deadline?: unknown; witness?: { validAfter?: unknown } } | undefined;
  if (p2 && typeof p2.deadline === "string" && typeof p2.witness?.validAfter === "string") return { validAfter: p2.witness.validAfter, validBefore: p2.deadline };
  return undefined;
}

/** The share a payload carries, if any (an echo without `payment` is not a share). */
function shareInfo(paymentPayload: PaymentPayload | undefined): SolidarityInfo | undefined {
  const ext = paymentPayload?.extensions?.[SOLIDARITY];
  const info = isSolidarityExtension(ext) ? ext.info : undefined;
  return info && info.payment !== undefined ? info : undefined;
}

export function solidarityClientExtension(opts: SolidarityClientOptions): ClientExtension {
  const report = (e: unknown) => {
    try {
      opts.onError?.(e);
    } catch {
      // a reporting callback must not break the purchase either
    }
  };
  const warm = (log: string) => {
    if (opts.policy.logs && !opts.policy.logs.includes(log)) return; // never fetch a log the owner does not trust
    if (opts.descriptors.get(log) || !opts.descriptors.refresh) return;
    opts.descriptors.refresh(log).catch(report);
  };
  // Shares signed on a channel and not answered yet, by share id.
  const inFlight = new Map<string, { channel: ClientChannel; at: number }>();
  const staleAfter = opts.staleChannelSeconds ?? 300;

  const decide = (decision: ShareDecision, pp: PaymentPayload) => {
    try {
      opts.onDecision?.(decision, pp);
    } catch (e) {
      report(e);
    }
  };

  async function enrichPaymentPayload(pp: PaymentPayload, pr: PaymentRequired): Promise<PaymentPayload> {
    try {
      if (pp.x402Version !== 2 || !pp.accepted) return pp;
      const declaredExt = pr.extensions?.[SOLIDARITY];
      const declared = isSolidarityExtension(declaredExt) ? declaredExt.info : undefined;
      const accepted = pp.accepted as PaymentRequirements;
      const fallbackLog = declared ? undefined : opts.fallbackLog?.(accepted);
      // Undeclared and no fallback: plain x402, untouched.
      if (!declared && !fallbackLog) return pp;

      const log = declared ? declared.logs?.find((l) => l.network === accepted.network && l.scheme === accepted.scheme)?.log : fallbackLog;
      if (!log) {
        decide({ attached: false, why: "the seller declared no log for this network and scheme" }, pp);
        return pp;
      }
      if (opts.policy.logs && !opts.policy.logs.includes(log)) {
        decide({ attached: false, why: "the owner does not trust this log" }, pp);
        return pp;
      }
      const descriptor = opts.descriptors.get(log);
      if (!descriptor) {
        warm(log);
        decide({ attached: false, why: "no descriptor cached for this log yet (fetching it for later purchases)" }, pp);
        return pp;
      }

      const channel = opts.channelFor?.(accepted);
      if (channel?.busy && channel.inFlight) {
        // A share whose response never came (for example a transport error after the paid
        // request) would hold the channel forever. Give it up after staleAfter: the state stays
        // as it was, and the next voucher resyncs through a cumulative-mismatch.
        // Only shares this extension signed: one signed elsewhere is that code's to free.
        const f = inFlight.get(channel.inFlight.id);
        if (f && Date.now() / 1000 - f.at > staleAfter) {
          inFlight.delete(channel.inFlight.id);
          applyOutcomeToChannel(channel, undefined);
        }
      }

      const decision = await buildShare(
        { policy: opts.policy, counter: opts.counter, signer: opts.signer, descriptor },
        {
          declared,
          accepted,
          purchaseWindow: purchaseWindowOf(pp.payload as Record<string, unknown>),
          fallbackLog,
          channel,
          mandateHolder: opts.mandateHolder,
          self: opts.self,
        },
      );
      decide(decision, pp);
      if (!decision.attached) return pp;
      if (decision.kind === "batch-settlement" && channel) inFlight.set(decision.info.id as string, { channel, at: Date.now() / 1000 });

      // A new extensions object with a cloned info: never write into the object the
      // PaymentRequired owns (see the header comment).
      const ext = { info: structuredClone(decision.info), schema: isSolidarityExtension(declaredExt) && declaredExt.schema ? declaredExt.schema : solidaritySchema };
      return { ...pp, extensions: { ...(pp.extensions ?? {}), [SOLIDARITY]: ext } };
    } catch (e) {
      report(e);
      return pp;
    }
  }

  async function onPaymentResponse(_declaration: unknown, ctx: PaymentResponseContext): Promise<void> {
    try {
      const info = shareInfo(ctx.paymentPayload);
      if (!info || typeof info.id !== "string") return;
      const id = info.id;
      const raw = ctx.settleResponse ? readOutcome(ctx.settleResponse as { extensions?: Record<string, unknown> }) : undefined;
      // Unsigned and relayed by the seller: only an outcome for this share's id counts.
      const outcome = raw && raw.id === id ? raw : undefined;
      const f = inFlight.get(id);
      if (f) {
        inFlight.delete(id);
        const applied = applyOutcomeToChannel(f.channel, outcome);
        if (!applied && outcome?.reason === "cumulative-mismatch" && outcome.channel) await resyncChannel(f.channel, outcome.channel);
      }
      opts.onOutcome?.(outcome, { id, paymentPayload: ctx.paymentPayload, settleResponse: ctx.settleResponse });
    } catch (e) {
      report(e);
    }
    // Always void: never {recovered: true}.
  }

  return {
    key: SOLIDARITY,
    enrichPaymentPayload,
    hooks: { onPaymentResponse },
    transportHooks: {
      http: {
        // Runs before payment creation. Starts fetching descriptors for the declared logs and
        // returns at once, so the next purchase on that log can carry a share.
        onPaymentRequired: async (declaration: unknown) => {
          try {
            if (!isSolidarityExtension(declaration)) return undefined;
            for (const l of declaration.info.logs ?? []) if (typeof l?.log === "string") warm(l.log);
          } catch (e) {
            report(e);
          }
          return undefined;
        },
      },
    },
  };
}
