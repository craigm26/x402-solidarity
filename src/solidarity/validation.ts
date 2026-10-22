/**
 * Validation and extraction utilities for the solidarity extension.
 */

import type { PaymentPayload, SolidarityExtension, SolidarityInfo, SolidarityOutcome } from "./types.ts";
import { SOLIDARITY } from "./types.ts";
import { solidarityOutcomeSchema, solidaritySchema, validateSchema } from "./schema.ts";

/** Basic structure check: `{info: {version: 2, ...}, schema}`. Does not validate the share. */
export function isSolidarityExtension(extension: unknown): extension is SolidarityExtension {
  if (!extension || typeof extension !== "object") return false;
  const info = (extension as Partial<SolidarityExtension>).info as Partial<SolidarityInfo> | undefined;
  return !!info && typeof info === "object" && info.version === 2;
}

export interface SolidarityValidationResult {
  valid: boolean;
  errors?: string[];
}

/** Validate `extensions.solidarity` against the normative schema. */
export function validateSolidarity(extension: unknown): SolidarityValidationResult {
  if (!extension || typeof extension !== "object") return { valid: false, errors: ["Extension must be an object"] };
  const info = (extension as { info?: unknown }).info;
  if (!info || typeof info !== "object") return { valid: false, errors: ["Extension must have an 'info' object"] };
  const errors = validateSchema(solidaritySchema, info);
  return errors.length ? { valid: false, errors } : { valid: true };
}

/** Validate a `SettleResponse.extensions.solidarity.info` outcome. */
export function validateOutcome(outcome: SolidarityOutcome): SolidarityValidationResult {
  const errors = validateSchema(solidarityOutcomeSchema, outcome);
  return errors.length ? { valid: false, errors } : { valid: true };
}

/** The solidarity info from a PaymentPayload, if any. */
export function extractSolidarity(paymentPayload: PaymentPayload): SolidarityInfo | undefined {
  const ext = paymentPayload.extensions?.[SOLIDARITY];
  return isSolidarityExtension(ext) ? ext.info : undefined;
}

/**
 * A share is present only when `payment` is. An echo with `version` and
 * `logs` but no `payment` is not a share, and gets no solidarity entry.
 */
export function hasShare(paymentPayload: PaymentPayload): boolean {
  const info = extractSolidarity(paymentPayload);
  return !!info && info.payment !== undefined;
}
