import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildTree, EMPTY_ROOT_HEX, leafHash, merkleRoot, nodeHash, toHex, verifyInclusion } from "../src/solidarity/merkle.ts";
import { buildBatch } from "../src/solidarity/ledger.ts";
import { conformance, siteFile } from "./helpers.ts";

const m = conformance("merkle-rfc6962.json");
const leaves = (m.leavesHex as string[]).map((h) => new Uint8Array(Buffer.from(h, "hex")));

// The 8-leaf root the spec lists, and the per-prefix roots verify.py carries.
const SPEC_ROOT_8 = "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328";
const VERIFY_PY_ROOTS = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  SPEC_ROOT_8,
];

// Audit paths from the Certificate Transparency reference implementation's tests.
const CT_PATHS: Array<[number, number, string[]]> = [
  [0, 8, ["96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7", "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", "6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4"]],
  [5, 8, ["bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b", "ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0", "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7"]],
  [2, 3, ["fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125"]],
  [1, 5, ["6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d", "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b"]],
];

test("RFC 6962 reference roots for every prefix of the 8 test leaves", () => {
  for (let n = 1; n <= 8; n++) assert.equal(merkleRoot(leaves.slice(0, n)), VERIFY_PY_ROOTS[n - 1], `n=${n}`);
  assert.deepEqual(m.rootsByPrefixSize, VERIFY_PY_ROOTS);
});

test("empty tree root is SHA-256 of the empty string", () => {
  assert.equal(merkleRoot([]), EMPTY_ROOT_HEX);
  assert.equal(EMPTY_ROOT_HEX, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("audit paths match the Certificate Transparency reference tests", () => {
  for (const [index, size, path] of CT_PATHS) {
    assert.deepEqual(buildTree(leaves.slice(0, size)).proof(index), path, `${index} of ${size}`);
  }
});

test("every inclusion proof for trees of 1 to 8 leaves verifies, and fails when tampered", () => {
  for (let size = 1; size <= 8; size++) {
    const t = buildTree(leaves.slice(0, size));
    for (let i = 0; i < size; i++) {
      const p = t.proof(i);
      assert.ok(verifyInclusion(leaves[i], i, size, p, t.rootHex), `${i}/${size}`);
      if (size > 1) {
        assert.equal(verifyInclusion(leaves[(i + 1) % size], i, size, p, t.rootHex), false); // the 8 test leaves are distinct
        if (size < 8) assert.equal(verifyInclusion(leaves[i], i, size + 1, p, merkleRoot(leaves.slice(0, size + 1))), false);
        const bad = [...p];
        bad[0] = bad[0].replace(/^./, (c) => (c === "0" ? "1" : "0"));
        assert.equal(verifyInclusion(leaves[i], i, size, bad, t.rootHex), false);
      }
      assert.equal(verifyInclusion(leaves[i], size, size, p, t.rootHex), false);
    }
  }
});

test("an inner node cannot pass as a leaf (second preimage)", () => {
  const t = buildTree(leaves.slice(0, 2));
  // The root of a 2-leaf tree is H(0x01 || l0 || l1); presenting l0||l1 as one leaf must not match.
  const fake = Buffer.concat([Buffer.from(buildTree([leaves[0]]).root), Buffer.from(buildTree([leaves[1]]).root)]);
  assert.notEqual(merkleRoot([new Uint8Array(fake)]), t.rootHex);
});

test("agrees with the site's merkle.js on the spec lines and the conformance batch", { skip: !siteFile("merkle.js") && "site merkle.js not found" }, async () => {
  const site = await import(pathToFileURL(siteFile("merkle.js") as string).href);
  const spec = conformance("spec-draft2-vectors.json");
  const ledger = conformance("ledger.json");
  for (const lines of [spec.lines.input as string[], ledger.lines as string[], []]) {
    const mine = buildBatch(lines);
    const theirs = await site.buildBatch(lines);
    assert.equal(mine.root, theirs.root);
    assert.deepEqual(mine.totals, theirs.totals);
    for (let i = 0; i < mine.size; i++) assert.deepEqual(mine.proof(i), await theirs.proof(i));
  }
  for (let n = 0; n <= 8; n++) {
    const t = await site.buildTree(leaves.slice(0, n));
    assert.equal(t.rootHex, merkleRoot(leaves.slice(0, n)));
  }
});

test("inclusion proofs past 2^31 leaves: arithmetic, not 32-bit bitwise operators", () => {
  // The last leaf of a tree of 2^k + 1 leaves sits alone on the right: its audit path is the left subtree's root.
  const left = new Uint8Array(32).fill(7);
  const root = toHex(nodeHash(left, leafHash("last")));
  for (const k of [31, 32, 40]) {
    assert.equal(verifyInclusion("last", 2 ** k, 2 ** k + 1, [toHex(left)], root), true, `2^${k}`);
    assert.equal(verifyInclusion("other", 2 ** k, 2 ** k + 1, [toHex(left)], root), false, `2^${k}`);
  }
  assert.equal(verifyInclusion("last", 2 ** 53, 2 ** 53 + 1, [toHex(left)], root), false, "beyond safe integers: refused");
});
