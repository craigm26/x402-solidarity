import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalBytes, canonicalize, canonicalizeStrict, isCanonical } from "../src/solidarity/jcs.ts";
import { conformance } from "./helpers.ts";

const v = conformance("jcs-rfc8785.json");

test("RFC 8785 section 3.2.2 to 3.2.3: primitives and sorting of the sample", () => {
  assert.equal(canonicalize(JSON.parse(v.primitives.input)), v.primitives.canonical);
});

test("RFC 8785 section 3.2.4: UTF-8 bytes of the canonical sample", () => {
  assert.equal(Buffer.from(canonicalBytes(JSON.parse(v.primitives.input))).toString("hex"), v.primitives.utf8Hex);
});

test("RFC 8785 section 3.2.3: property order by UTF-16 code units", () => {
  // Read the order from the canonical text itself: re-parsing would move the key "1" first.
  const text = canonicalize(JSON.parse(v.sorting.input));
  assert.deepEqual([...text.matchAll(/:"([^"]*)"/g)].map((x) => x[1]), v.sorting.expectedValueOrder);
  // Not UTF-8 order: the emoji (surrogate pair D83D) sorts before U+FB33.
  const keys = Object.keys(JSON.parse(v.sorting.input)).sort();
  assert.equal(keys.at(-1), "\ufb33");
});

test("RFC 8785 Appendix B: number serialization samples", () => {
  assert.equal(v.numbers.length, 26);
  for (const [hex, expected] of v.numbers as Array<[string, string | null]>) {
    const n = Buffer.from(hex, "hex").readDoubleBE(0);
    if (expected === null) assert.throws(() => canonicalize(n), /not a JSON number/, hex);
    else assert.equal(canonicalize(n), expected, hex);
  }
});

test("I-JSON: lone surrogates are rejected", () => {
  assert.throws(() => canonicalize("\ud800"), /lone surrogate/);
  assert.throws(() => canonicalize({ ["\udc00"]: 1 }), /lone surrogate/);
  assert.equal(canonicalize("\ud83d\ude00"), '"\ud83d\ude00"');
});

test("strict mode (statements): integers below 2^53 only", () => {
  assert.equal(canonicalizeStrict({ b: 9007199254740991, a: [null, "x"] }), '{"a":[null,"x"],"b":9007199254740991}');
  assert.throws(() => canonicalizeStrict({ a: 1.5 }), /non-negative integer/);
  assert.throws(() => canonicalizeStrict({ a: 2 ** 53 }), /non-negative integer/);
  assert.throws(() => canonicalizeStrict({ a: -1 }), /non-negative integer/, "statements hold no negative numbers");
  assert.throws(() => canonicalizeStrict({ a: true }), /booleans/, "nor booleans");
  assert.equal(canonicalize({ a: 1.5 }), '{"a":1.5}');
});

test("isCanonical accepts only the exact JCS form", () => {
  assert.equal(isCanonical('{"a":1,"b":2}'), true);
  assert.equal(isCanonical('{"b":2,"a":1}'), false);
  assert.equal(isCanonical('{"a": 1}'), false);
  assert.equal(isCanonical('{"a":1.0}'), false);
  assert.equal(isCanonical('{"a":"\\u0041"}'), false);
});

test("undefined properties are omitted, as JSON.stringify does", () => {
  assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalize(-0), "0");
});
