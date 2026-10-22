import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { generate } from "../scripts/generate-conformance.ts";
import { ROOT, conformance, conformanceText, siteFile } from "./helpers.ts";

test("conformance/ is exactly what the generator produces (no hand edits, no drift)", async () => {
  const files = await generate();
  assert.ok(Object.keys(files).length >= 20);
  for (const [rel, body] of Object.entries(files)) {
    assert.equal(readFileSync(join(ROOT, "conformance", rel), "utf8"), body, `conformance/${rel}`);
  }
});

const python = spawnSync("python3", ["--version"]).status === 0;
const verifyPy = siteFile("verify.py");
const run = (...args: string[]) => spawnSync("python3", ["-I", verifyPy as string, ...args], { cwd: join(ROOT, "conformance"), encoding: "utf8" });

test("the site's verify.py accepts every generated batch, the chain and the receipts", { skip: (!python || !verifyPy) && "python3 or verify.py not found" }, () => {
  for (const p of ["2026-10", "2026-11", "2026-12"]) {
    const r = run("--lines", `files/${p}.lines`, "--statement", `files/${p}.statement.json`, "--settlements", `files/${p}.settlements`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /statement root, size and totals match/);
    assert.match(r.stdout, /settlements file hash and sums match/);
  }
  const chain = run("--chain", "files/2026-10.statement.json", "files/2026-11.statement.json", "files/2026-12.statement.json");
  assert.equal(chain.status, 0, chain.stdout);
  assert.match(chain.stdout, /2026-12: chains to the previous statement/);
  const keyHex = conformance("statements.json").keys.log.publicKeyHex;
  for (const id of ["conformance-share-0001", "conformance-share-0014"]) {
    const r = run(`receipts/${id}.json`, "--key", keyHex);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /included in https:\/\/log\.example\/solidarity 2026-12/);
  }
  const self = run("--selftest", "spec-draft2-vectors.json");
  assert.equal(self.status, 0, self.stdout);
  // And it notices a tampered file.
  const bad = spawnSync("python3", ["-I", verifyPy as string, "--chain", "files/2026-10.statement.json", "files/2026-12.statement.json"], { cwd: join(ROOT, "conformance"), encoding: "utf8" });
  assert.notEqual(bad.status, 0);
});

test("the site's merkle.js verifies the generated receipts and reproduces the statements", { skip: !siteFile("merkle.js") && "site merkle.js not found" }, async () => {
  const site = await import(pathToFileURL(siteFile("merkle.js") as string).href);
  const st = conformance("statements.json");
  const raw = Buffer.from(st.keys.log.publicKeyHex, "hex");
  const logKey = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  for (const id of ["conformance-share-0001", "conformance-share-0011", "conformance-share-0012", "conformance-share-0014", "conformance-share-0017"]) {
    const r = await site.verifyReceipt(conformance(`receipts/${id}.json`), { logKey });
    assert.equal(r.ok, true, id);
  }
  for (const p of st.periods) {
    assert.equal(site.canonicalJSON(p.payload), p.jcs);
    assert.equal(await site.statementHash(p.payload), p.sha256);
    const lines = conformanceText(`files/${p.period}.lines`).split("\n").filter(Boolean);
    const b = await site.buildBatch(lines);
    assert.equal(b.root, p.root);
    assert.deepEqual(b.totals, p.totals);
  }
});
