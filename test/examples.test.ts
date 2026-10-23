import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { runOfflineDemo } from "../examples/e2e-offline.ts";
import { checkEnv, PLACEHOLDER_FUND } from "../examples/live-base-sepolia/env.ts";
import { RpcLogChain } from "../examples/live-base-sepolia/rpcChain.ts";
import { ROOT } from "./helpers.ts";

test("offline example: the whole flow, with throwaway keys and no network", async () => {
  const r = await runOfflineDemo({ quiet: true });
  assert.equal(r.outcomes.report?.status, "accepted");
  assert.equal(r.outcomes.report?.amount, "48000");
  assert.equal(r.outcomes["search-1"]?.status, "accepted");
  assert.equal(r.outcomes["search-2"]?.status, "accepted");
  assert.equal(r.outcomes.failed?.reason, "purchase-not-final");
  assert.equal(r.released, true, "the failed purchase's unexecuted exact share left the cap counter");
  assert.equal(r.receiptCheck.ok, true, r.receiptCheck.problems.join("; "));
  assert.equal(r.lines.length, 3);
  assert.equal(r.fundBalance, 48000n + 2000n + 3500n, "simulated fund received exactly the totals");
  assert.equal((r.proofs.failed as { status?: string }).status, undefined, "404: the log never accepted it");
});

test("live example: refuses without PRIVATE_KEY and RPC_URL (checked without running the script)", () => {
  const none = checkEnv({});
  assert.equal(none.ok, false);
  if (!none.ok) {
    assert.match(none.message, /PRIVATE_KEY and RPC_URL/);
    assert.match(none.message, /testnet/);
  }
  assert.equal(checkEnv({ PRIVATE_KEY: `0x${"1".repeat(64)}` }).ok, false);
  assert.equal(checkEnv({ RPC_URL: "https://sepolia.base.example" }).ok, false);
  assert.equal(checkEnv({ PRIVATE_KEY: "nope", RPC_URL: "https://x" }).ok, false);
  const ok = checkEnv({ PRIVATE_KEY: `0x${"1".repeat(64)}`, RPC_URL: "https://x" });
  assert.ok(ok.ok && ok.fundAddress === PLACEHOLDER_FUND && ok.placeholderFund && !ok.dryRun);
  assert.equal(typeof RpcLogChain, "function");
});

const TEXT_FILES = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (["node_modules", ".git", ".wrangler"].includes(name)) return [];
    if (statSync(p).isDirectory()) return TEXT_FILES(p);
    return /\.(ts|md|json|jsonc|txt|html)$/.test(name) || ["LICENSE", "NOTICE"].includes(name) ? [p] : [];
  });

const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

test("no em or en dashes anywhere in the repository's text", () => {
  const files = TEXT_FILES(ROOT);
  assert.ok(files.some((f) => f.endsWith("wrangler.jsonc")), "the scan covers .jsonc");
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    assert.ok(!DASHES.test(s), `${relative(ROOT, f)} contains an em or en dash`);
  }
});

test("README says plainly: proposal, simulated, not affiliated, no fund, testnet only", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  for (const phrase of [/not part of x402/i, /not affiliated/i, /no fund exists/i, /simulated/i, /no money moves/i, /testnet only/i, /run once on Base Sepolia/i, /placeholder/i, /Apache-2\.0/]) {
    assert.match(readme, phrase);
  }
  const live = readFileSync(join(ROOT, "examples/live-base-sepolia/README.md"), "utf8");
  for (const phrase of [/testnet only/i, /run once on Base Sepolia/i, /no fund exists/i, /placeholder/i]) assert.match(live, phrase);
});
