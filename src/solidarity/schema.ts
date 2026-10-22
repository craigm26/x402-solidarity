/**
 * JSON Schema definitions for the solidarity extension (draft 2020-12), copied
 * from https://craigmerry.com/solidarity-levy/spec/solidarity.md ("`PaymentRequired` and
 * `PaymentPayload`" and "`SettleResponse`"), plus a
 * small validator for the keywords these schemas use. The x402 SDK uses Ajv;
 * this repository depends only on viem, so it carries its own validator.
 */

/** Schema of `extensions.solidarity.info` in PaymentRequired and PaymentPayload. */
export const solidaritySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    version: { const: 2 },
    logs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          network: { type: "string" },
          scheme: { type: "string" },
          log: { type: "string", pattern: "^https://" },
        },
        required: ["network", "scheme", "log"],
        additionalProperties: false,
      },
    },
    log: { type: "string", pattern: "^https://" },
    id: { type: "string", pattern: "^[A-Za-z0-9_-]{22,128}$" },
    rate: { type: "string", pattern: "^0\\.(01|00[0-9]{0,3}[1-9])$" },
    fund: { type: "string", pattern: "^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$" },
    payment: {
      type: "object",
      properties: {
        accepted: {
          type: "object",
          properties: { amount: { type: "string", pattern: "^[1-9][0-9]*$" } },
          required: ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"],
        },
        payload: { type: "object" },
      },
      required: ["accepted", "payload"],
      additionalProperties: false,
    },
  },
  required: ["version"],
  dependentRequired: { payment: ["log", "id", "rate", "fund"] },
  additionalProperties: false,
} as const;

/** Schema of `SettleResponse.extensions.solidarity.info`. */
export const solidarityOutcomeSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    status: { enum: ["accepted", "pending", "skipped"] },
    reason: {
      enum: [
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
      ],
    },
    id: { type: "string" },
    log: { type: "string" },
    period: { type: "string", pattern: "^[0-9]{4}-(0[1-9]|1[0-2])$" },
    amount: { type: "string", pattern: "^[1-9][0-9]*$" },
    channel: { type: "object", required: ["channelId", "chargedCumulativeAmount"] },
  },
  required: ["status", "id", "log"],
  oneOf: [
    { properties: { status: { const: "accepted" }, reason: false }, required: ["period", "amount"] },
    { properties: { status: { const: "pending" }, reason: false, period: false, amount: false } },
    { properties: { status: { const: "skipped" }, period: false, amount: false }, required: ["reason"] },
  ],
  additionalProperties: false,
} as const;

/**
 * Schemas of the AP2 Payment Mandate Constraint and of the `solidarity`
 * property the holder adds to its Payment Receipt, copied from
 * https://craigmerry.com/solidarity-levy/spec/processor-mode.md ("AP2: a Payment Mandate Constraint").
 * The whole constraint is one selectively disclosable element of the open
 * Payment Mandate's `constraints` array; no field inside it is disclosable on
 * its own.
 */
export const ap2ConstraintSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    type: { const: "com.craigmerry.solidarity" },
    holder: { type: "string", pattern: "^https://[^/?#\\s]+$" },
    rate: { type: "string", pattern: "^0\\.(01|00[0-9]{0,3}[1-9])$" },
    cap: {
      type: "object",
      properties: { amount: { type: "integer" }, currency: { type: "string", pattern: "^[A-Z]{3}$" } },
      required: ["amount", "currency"],
      additionalProperties: false,
    },
    fund: { type: "string", pattern: "^\\S{1,256}$" },
    logs: { type: "array", items: { type: "string", pattern: "^https://" } },
    refunds: { enum: ["keep", "net"] },
  },
  required: ["type", "holder", "rate", "cap", "fund", "logs"],
  additionalProperties: false,
} as const;

export const ap2ReceiptSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    status: { enum: ["pending", "skipped"] },
    reason: { enum: ["bad-policy", "wrong-log", "fund-not-allowed", "purchase-not-supported", "below-minimum", "cap-reached"] },
    id: { type: "string", pattern: "^[A-Za-z0-9_-]{22,128}$" },
    log: { type: "string", pattern: "^https://" },
  },
  required: ["status", "log"],
  oneOf: [
    { properties: { status: { const: "pending" }, reason: false }, required: ["id"] },
    { properties: { status: { const: "skipped" }, id: false }, required: ["reason"] },
  ],
  additionalProperties: false,
} as const;

type Schema = Record<string, unknown> | boolean;

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "integer":
      return Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      throw new Error(`schema type ${type} not supported by this validator`);
  }
}

const SUPPORTED = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "pattern",
  "const",
  "enum",
  "items",
  "dependentRequired",
  "oneOf",
]);

/**
 * Validate `value` against `schema`, for the keywords listed in SUPPORTED.
 * Returns a list of error strings with JSON-pointer-like paths; [] when valid.
 * Throws on a keyword it does not implement, so it never passes silently.
 */
export function validateSchema(schema: Schema, value: unknown, path = ""): string[] {
  const at = path || "/";
  if (schema === true) return [];
  if (schema === false) return [`${at}: not allowed`];
  for (const k of Object.keys(schema)) if (!SUPPORTED.has(k)) throw new Error(`schema keyword ${k} not supported`);
  const errs: string[] = [];
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter((s) => validateSchema(s as Schema, value, path).length === 0).length;
    if (passing !== 1) errs.push(`${at}: matches ${passing} of the oneOf branches, not exactly one`);
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${at}: not an allowed value`);
  if (typeof schema.type === "string" && !typeOk(schema.type, value)) {
    errs.push(`${at}: must be ${schema.type}`);
    return errs;
  }
  if (typeof schema.pattern === "string" && typeof value === "string" && !new RegExp(schema.pattern, "u").test(value)) {
    errs.push(`${at}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errs.push(...validateSchema(schema.items as Schema, item, `${path}/${i}`)));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>; // a property may be `false`: never allowed
    // Own properties only: `k in props` would also find constructor, __proto__, toString and the
    // rest of Object.prototype, and let them past additionalProperties: false.
    const has = (o: object, k: string) => Object.hasOwn(o, k);
    for (const r of (schema.required ?? []) as string[]) if (!has(obj, r)) errs.push(`${path}/${r}: required`);
    for (const [k, v] of Object.entries(obj)) {
      if (has(props, k)) errs.push(...validateSchema(props[k], v, `${path}/${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}/${k}: not allowed`);
    }
    const dep = (schema.dependentRequired ?? {}) as Record<string, string[]>;
    for (const [k, needs] of Object.entries(dep)) {
      if (has(obj, k)) for (const n of needs) if (!has(obj, n)) errs.push(`${path}/${n}: required when ${k} is present`);
    }
  }
  return errs;
}
