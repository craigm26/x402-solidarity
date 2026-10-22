/**
 * JSON Canonicalization Scheme, RFC 8785.
 *
 * - Objects: properties sorted by their names as arrays of UTF-16 code units
 *   (section 3.2.3), recursively. JavaScript's default string comparison is
 *   exactly that order.
 * - Strings: serialized as ECMAScript JSON.stringify does (section 3.2.2.2).
 *   Lone surrogates are rejected, because the input must be I-JSON (RFC 7493).
 * - Numbers: serialized as ECMAScript Number.prototype.toString does
 *   (section 3.2.2.3), which JSON.stringify uses. NaN and Infinity are errors.
 *   -0 serializes as 0.
 * - Literals: null, true, false.
 *
 * `canonicalize` handles all of JSON. Statements are limited by the spec to
 * strings, integers below 2^53, arrays, objects and null; `canonicalizeStrict`
 * enforces that and is what the ledger uses.
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new Error("JCS: lone surrogate in string (not I-JSON)");
  return JSON.stringify(s);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`JCS: ${n} is not a JSON number`);
  // Object.is(n, -0) also prints "0" with toString; JSON.stringify(-0) is "0".
  return JSON.stringify(n);
}

export interface CanonicalizeOptions {
  /**
   * The statement form: only strings, non-negative integers below 2^53,
   * arrays, objects and null. Rejects other numbers and booleans.
   */
  strictIntegers?: boolean;
}

export function canonicalize(value: unknown, opts: CanonicalizeOptions = {}): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      if (opts.strictIntegers) throw new Error("JCS strict: booleans are not allowed");
      return value ? "true" : "false";
    case "string":
      return serializeString(value);
    case "number":
      if (opts.strictIntegers && !(Number.isSafeInteger(value) && value >= 0)) {
        throw new Error(`JCS strict: ${value} is not a non-negative integer below 2^53`);
      }
      return serializeNumber(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v, opts)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
      keys.sort(); // UTF-16 code unit order, as section 3.2.3 requires
      return `{${keys.map((k) => `${serializeString(k)}:${canonicalize(obj[k], opts)}`).join(",")}}`;
    }
    default:
      throw new Error(`JCS: cannot canonicalize a ${typeof value}`);
  }
}

/** The ledger's form: strings, non-negative integers below 2^53, arrays, objects and null. */
export const canonicalizeStrict = (value: unknown): string => canonicalize(value, { strictIntegers: true });

/** UTF-8 bytes of the canonical form (section 3.2.4). */
export const canonicalBytes = (value: unknown, opts: CanonicalizeOptions = {}): Uint8Array =>
  new TextEncoder().encode(canonicalize(value, opts));

/** True when `text` is exactly the JCS form of its own parsed content. */
export function isCanonical(text: string, opts: CanonicalizeOptions = {}): boolean {
  try {
    return canonicalize(JSON.parse(text), opts) === text;
  } catch {
    return false;
  }
}
