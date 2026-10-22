/**
 * Merkle trees as RFC 6962 section 2.1 defines them (Certificate Transparency).
 *
 * - Leaf hash: SHA-256(0x00 || entry).
 * - Node hash: SHA-256(0x01 || left || right).
 * - MTH of the empty list: SHA-256("").
 * - An odd node is never duplicated: the tree splits at the largest power of
 *   two below n.
 * - Audit paths are PATH(m, D[n]) from section 2.1.1, and verification follows
 *   RFC 9162 section 2.1.3.2.
 *
 * Consistency proofs are not implemented: the spec ("Consistency between
 * months") says batches are closed and never extended, so they are not needed.
 */

import { createHash } from "node:crypto";

const enc = new TextEncoder();
const asBytes = (d: string | Uint8Array): Uint8Array => (typeof d === "string" ? enc.encode(d) : d);

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export function fromHex(h: string): Uint8Array {
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error("not a hex string");
  return new Uint8Array(Buffer.from(h, "hex"));
}

export const leafHash = (entry: string | Uint8Array): Uint8Array => sha256(Uint8Array.of(0), asBytes(entry));
export const nodeHash = (left: Uint8Array, right: Uint8Array): Uint8Array => sha256(Uint8Array.of(1), left, right);
export const EMPTY_ROOT_HEX = toHex(sha256());

/** Largest power of two strictly below n (n >= 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

export interface MerkleTree {
  size: number;
  root: Uint8Array;
  rootHex: string;
  /** Audit path for entry `index`, as hex strings. */
  proof(index: number): string[];
}

export function buildTree(entries: Array<string | Uint8Array>): MerkleTree {
  const leaves = entries.map(leafHash);
  const memo = new Map<string, Uint8Array>();
  const mth = (lo: number, hi: number): Uint8Array => {
    const key = `${lo}:${hi}`;
    const hit = memo.get(key);
    if (hit) return hit;
    let h: Uint8Array;
    if (hi - lo === 0) h = sha256();
    else if (hi - lo === 1) h = leaves[lo];
    else {
      const k = split(hi - lo);
      h = nodeHash(mth(lo, lo + k), mth(lo + k, hi));
    }
    memo.set(key, h);
    return h;
  };
  const path = (m: number, lo: number, hi: number): Uint8Array[] => {
    if (hi - lo <= 1) return [];
    const k = split(hi - lo);
    return m < k ? [...path(m, lo, lo + k), mth(lo + k, hi)] : [...path(m - k, lo + k, hi), mth(lo, lo + k)];
  };
  const root = mth(0, leaves.length);
  return {
    size: leaves.length,
    root,
    rootHex: toHex(root),
    proof(index: number) {
      if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error("index out of range");
      return path(index, 0, leaves.length).map(toHex);
    },
  };
}

/** Root hash (hex) of a list of entries. */
export const merkleRoot = (entries: Array<string | Uint8Array>): string => buildTree(entries).rootHex;

/** RFC 9162 section 2.1.3.2: is `entry` at `index` of a tree of `size` with root `rootHex`? */
export function verifyInclusion(
  entry: string | Uint8Array,
  index: number,
  size: number,
  proofHex: string[],
  rootHex: string,
): boolean {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leafHash(entry);
  for (const pHex of proofHex) {
    if (sn === 0) return false;
    const p = fromHex(pHex);
    if (p.length !== 32) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && toHex(r) === rootHex.toLowerCase();
}
