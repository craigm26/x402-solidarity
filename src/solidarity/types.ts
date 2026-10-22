/**
 * Type definitions and constants for the solidarity extension, draft 2.
 *
 * Source of truth: spec/solidarity.md, draft 2 (2026-10-22). Section names in
 * comments ("Owner policy", "Facilitator behaviour" and so on) refer to it.
 */

/** Extension key in `extensions`. */
export const SOLIDARITY = "solidarity";

/** Wire and statement version. */
export const SOLIDARITY_VERSION = 2;

/** Line prefix ("Receipt attestation", "Lines"). */
export const LINE_PREFIX = "solidarity/2";

/** `rate` on the wire: "0.000001" to "0.01", no trailing zeros. */
export const RATE_PATTERN = /^0\.(01|00[0-9]{0,3}[1-9])$/;

/** `id`: 22 to 128 characters of [A-Za-z0-9_-]. */
export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

/** CAIP-10 account, as in the schema's `fund` pattern. */
export const CAIP10_PATTERN = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$/;

/** Positive base-10 integer with no leading zeros. */
export const AMOUNT_PATTERN = /^[1-9][0-9]*$/;

/** `YYYY-MM`. */
export const PERIOD_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/** Share kinds a log may list in its descriptor ("Share kinds"). */
export type ShareKind = "exact" | "batch-settlement";

/** Status of a share in `SettleResponse.extensions.solidarity`. */
export type ShareStatus = "accepted" | "pending" | "skipped";

/** Skip reasons, in the order the spec lists them in the schema. */
export const SKIP_REASONS = [
  "wrong-log",
  "fund-not-allowed",
  "bad-payment",
  "kind-not-supported",
  "over-rate",
  "duplicate",
  "cumulative-mismatch",
  "below-minimum",
  "amount-changed",
  "purchase-not-supported",
  "purchase-not-final",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Refund rule ("Refunds"). Separate mode is `keep` only. */
export type RefundRule = "keep" | "net";

/** Which party holds the policy ("Modes"). */
export type Mode = "separate" | "processor";

/** The owner policy. Held by one party, never sent on the wire. */
export interface OwnerPolicy {
  version: 2;
  rate: string;
  cap: { amount: string; asset: string };
  fund: string;
  logs?: string[];
  refunds?: RefundRule;
  since: string;
}

/** One `logs` entry declared by a seller. */
export interface LogEntry {
  network: string;
  scheme: string;
  log: string;
}

/** x402 PaymentRequirements, the subset this code reads. */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** A complete x402 payment for the share: the pair /verify and /settle take. */
export interface SharePayment {
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
}

/** `extensions.solidarity.info`, as declared by a seller and as completed by a client. */
export interface SolidarityInfo {
  version: 2;
  logs?: LogEntry[];
  log?: string;
  id?: string;
  rate?: string;
  fund?: string;
  payment?: SharePayment;
}

export interface SolidarityExtension {
  info: SolidarityInfo;
  schema: Record<string, unknown>;
}

/** Channel snapshot returned for batch-settlement shares. */
export interface ChannelSnapshot {
  channelId: string;
  balance?: string;
  totalClaimed?: string;
  withdrawRequestedAt?: number;
  refundNonce?: string;
  chargedCumulativeAmount: string;
}

/** `SettleResponse.extensions.solidarity.info`. */
export interface SolidarityOutcome {
  status: ShareStatus;
  reason?: SkipReason;
  id: string;
  log: string;
  period?: string;
  amount?: string;
  channel?: ChannelSnapshot;
}

/** One `accepts` entry of a log descriptor ("Publication"). */
export interface DescriptorAccept {
  network: string;
  asset: string;
  scheme: ShareKind;
  maxTimeoutSeconds: number;
  minAmount?: string;
  extra?: Record<string, unknown>;
}

export interface DescriptorKey {
  kid: string;
  from: string;
  until: string | null;
}

/** The log descriptor served at `GET <log>`. */
export interface LogDescriptor {
  version: 2;
  log: string;
  funds: string[];
  accepts?: DescriptorAccept[];
  minWithdrawDelay?: number;
  minCollection?: string;
  keys: DescriptorKey[];
  witnesses?: string[];
}

/** x402 PaymentPayload, the subset this code reads. */
export interface PaymentPayload {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  resource?: unknown;
}

/** x402 SettleResponse. `extra` is used by the batch-settlement binding. */
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  extensions?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/** A JWS envelope, as in the offer-and-receipt extension (section 3.1 there). */
export interface JwsEnvelope {
  format: "jws";
  signature: string;
}

/** Statement payload ("Statements"). */
export interface StatementPayload {
  version: 2;
  log: string;
  period: string;
  size: number;
  root: string;
  totals: TotalsRow[];
  settlements: string;
  previous: string | null;
  issuedAt: number;
}

export interface TotalsRow {
  fund: string;
  asset: string;
  lines: number;
  amount: string;
}

/** `GET <log>/statements/<period>`. */
export interface PublishedStatement {
  statement: JwsEnvelope;
  cosignatures: JwsEnvelope[];
}

/** A receipt ("Receipts"). */
export interface Receipt {
  version: 2;
  line: string;
  index: number;
  proof: string[];
  statement: JwsEnvelope;
  cosignatures: JwsEnvelope[];
}
