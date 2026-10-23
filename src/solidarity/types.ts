/**
 * Type definitions and constants for the solidarity extension, draft 3.
 *
 * Source of truth: the draft 3 spec (2026-10-23), three documents:
 * - https://craigmerry.com/solidarity-levy/spec/solidarity.md (the x402 extension),
 * - https://craigmerry.com/solidarity-levy/spec/attestation.md (the receipt attestation contract, normative for logs),
 * - https://craigmerry.com/solidarity-levy/spec/processor-mode.md (informative).
 * A section name quoted alone in a comment ("Owner policy", "Facilitator
 * behaviour" and so on) is a heading of solidarity.md; sections of the other
 * two documents are cited with the document's URL.
 */

/** Extension key in `extensions`. */
export const SOLIDARITY = "solidarity";

/**
 * `vct` of the AP2 Solidarity Mandate
 * (https://craigmerry.com/solidarity-levy/spec/processor-mode.md, "AP2: a Solidarity Mandate").
 * AP2 lets specifiers define new mandate types and recommends a
 * collision-resistant name, such as a reverse-DNS prefix the specifier
 * controls; the suffix follows AP2's mandate versioning.
 */
export const AP2_MANDATE_VCT = "com.craigmerry.solidarity.1";

/** Why the holder does not enroll a Solidarity Mandate, in its Mandate Receipt. */
export const AP2_REFUSAL_REASONS = ["bad-policy", "wrong-log", "fund-not-allowed", "superseded", "stopped", "suspended"] as const;
export type Ap2RefusalReason = (typeof AP2_REFUSAL_REASONS)[number];

/**
 * The Solidarity Mandate's content: the owner policy in AP2's shapes. `cap` is
 * an AP2 Amount (integer minor units of an ISO 4217 code); `iat` stands in for
 * the policy's `since`, and the policy ends at `exp` if there is one.
 */
export interface Ap2SolidarityMandate {
  vct: typeof AP2_MANDATE_VCT;
  holder: string;
  rate: string;
  cap: { amount: number; currency: string };
  fund: string;
  logs: string[];
  refunds?: "keep" | "net";
  iat: number;
  exp?: number;
}

/** The `solidarity` property the holder adds to its signed Mandate Receipt. */
export type Ap2EnrollmentOutcome = { status: "enrolled"; log: string } | { status: "refused"; reason: Ap2RefusalReason; log: string };

/** Wire and statement version. */
export const SOLIDARITY_VERSION = 2;

/** Line prefix (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Lines"). */
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

/**
 * The share's own x402 payment. The log checks it with its scheme code as
 * /verify and /settle would, with paymentPayload = {x402Version: 2, accepted,
 * payload} and paymentRequirements = accepted.
 */
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

/**
 * Channel snapshot returned for batch-settlement shares. Untrusted: it passes
 * through the seller unsigned. `signedMaxClaimable` and `signature` are the
 * last voucher the log holds, for recovery after a cumulative-mismatch (as the
 * binding's Corrective 402 carries them in `extra.voucherState`).
 */
export interface ChannelSnapshot {
  channelId: string;
  balance?: string;
  totalClaimed?: string;
  withdrawRequestedAt?: number;
  refundNonce?: string;
  chargedCumulativeAmount: string;
  signedMaxClaimable?: string;
  signature?: string;
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

/** One `accepts` entry of a log descriptor (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Publication"). */
export interface DescriptorAccept {
  network: string;
  asset: string;
  scheme: ShareKind;
  maxTimeoutSeconds: number;
  minAmount?: string;
  extra?: Record<string, unknown>;
}

/** A public key as a JWK (RFC 7517): OKP Ed25519 for EdDSA, EC P-256 for ES256. */
export interface PublicJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
}

/**
 * One statement key a log has used (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Signatures and keys"): its public key,
 * and the first and last period it signed (`until` is null for the current
 * key). DID documents and DNS show only current state, so a retired key's
 * public key is known only from here. A descriptor with no current key
 * belongs to a retired log, whose final period is the latest `until`
 * (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Retiring a log").
 */
export interface DescriptorKey {
  kid: string;
  from: string;
  until: string | null;
  jwk?: PublicJwk;
}

/** The log descriptor served at `GET <log>`. */
export interface LogDescriptor {
  version: 2;
  log: string;
  funds: string[];
  accepts?: DescriptorAccept[];
  minCollection?: string;
  keys: DescriptorKey[];
  /**
   * The witnesses the log expects, by DID, for information only. A verifier
   * never derives the cosigners it requires from these: it names each by its
   * exact kid itself (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Witnesses and the fund").
   */
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

/** Statement payload (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Statements"). */
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

/** A receipt (https://craigmerry.com/solidarity-levy/spec/attestation.md, "Receipts"). */
export interface Receipt {
  version: 2;
  line: string;
  index: number;
  proof: string[];
  statement: JwsEnvelope;
  cosignatures: JwsEnvelope[];
}
