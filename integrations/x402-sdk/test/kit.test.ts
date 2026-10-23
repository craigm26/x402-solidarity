/**
 * The kit's own housekeeping: exact pins, the installed SDK, constants shared
 * with the reference implementation, and the README's plain statements.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BATCH_SETTLEMENT_ADDRESS as SDK_BATCH_ADDRESS, BATCH_SETTLEMENT_DOMAIN as SDK_BATCH_DOMAIN, DEFAULT_ASSETS } from "@x402/evm";
import { BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_DOMAIN, USDC_BASE_SEPOLIA } from "../../../src/solidarity/index.ts";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (p: string) => JSON.parse(readFileSync(join(KIT, p), "utf8"));

test("package.json: private, exact pins, no @x402 scope in the name", () => {
  const pkg = json("package.json");
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.ok(!pkg.name.startsWith("@x402"), "the name must not suggest the package is part of x402");
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.deepEqual(Object.keys(deps).sort(), ["@x402/core", "@x402/evm", "@x402/fetch", "viem"]);
  for (const [name, range] of Object.entries(deps)) assert.match(String(range), /^[0-9]+\.[0-9]+\.[0-9]+$/, `${name} is pinned exactly`);
  assert.equal(pkg.dependencies["@x402/core"], "2.28.0");
  assert.equal(pkg.dependencies["@x402/evm"], "2.28.0");
  assert.equal(pkg.devDependencies["@x402/fetch"], "2.28.0");
  assert.equal(pkg.dependencies.viem, "2.48.11");
});

test("the installed SDK is the pinned one (the facilitator hook relies on 2.28.0 behaviour)", () => {
  for (const p of ["@x402/core", "@x402/evm", "@x402/fetch"]) assert.equal(json(`node_modules/${p}/package.json`).version, "2.28.0", p);
  assert.equal(json("node_modules/viem/package.json").version, "2.48.11");
  // One @x402/core only: two copies would mean two x402Facilitator classes.
  assert.throws(() => statSync(join(KIT, "node_modules/@x402/evm/node_modules/@x402/core")));
});

test("the SDK's constants match the reference implementation's (an offline counterpart to the X402_DIR test)", () => {
  const usdc = DEFAULT_ASSETS["eip155:84532"]?.[0];
  assert.ok(usdc);
  assert.equal(usdc.asset, USDC_BASE_SEPOLIA.address);
  assert.equal(usdc.name, USDC_BASE_SEPOLIA.name);
  assert.equal(usdc.version, USDC_BASE_SEPOLIA.version);
  assert.equal(usdc.decimals, USDC_BASE_SEPOLIA.decimals);
  assert.equal(SDK_BATCH_ADDRESS, BATCH_SETTLEMENT_ADDRESS);
  assert.deepEqual({ ...SDK_BATCH_DOMAIN }, { ...BATCH_SETTLEMENT_DOMAIN });
});

test("the README says plainly what this is and is not", () => {
  const readme = readFileSync(join(KIT, "README.md"), "utf8");
  for (const phrase of [
    /a proposal/i,
    /not part of x402/i,
    /not affiliated with or endorsed by/i,
    /no fund exists/i,
    /placeholder/i,
    /simulated/i,
    /no money moves/i,
    /testnet only/i,
    /untested/i,
    /processor-mode\.md/,
  ]) {
    assert.match(readme, phrase);
  }
});

const TEXT = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(p).isDirectory()) return TEXT(p);
    return /\.(ts|md|json|txt)$/.test(name) ? [p] : [];
  });

test("no em or en dashes in the kit's text, the lockfile included (the root suite checks this too)", () => {
  const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
  const files = TEXT(KIT);
  assert.ok(files.some((f) => f.endsWith("package-lock.json")), "the lockfile is committed and scanned");
  for (const f of files) assert.ok(!dashes.test(readFileSync(f, "utf8")), `${relative(KIT, f)} contains an em or en dash`);
});
