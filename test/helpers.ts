import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const conformance = (rel: string) => JSON.parse(readFileSync(join(ROOT, "conformance", rel), "utf8"));
export const conformanceText = (rel: string) => readFileSync(join(ROOT, "conformance", rel), "utf8");

/**
 * The site's reference files (merkle.js, verify.py), for cross-checks. Set
 * SOLIDARITY_SITE_DIR to point elsewhere; the cross-check tests skip when the
 * directory is missing.
 */
export const SITE_DIR = process.env.SOLIDARITY_SITE_DIR ?? join(ROOT, "..", "personalsite-solidarity", "public", "solidarity-levy");
export const siteFile = (name: string): string | undefined => (existsSync(join(SITE_DIR, name)) ? join(SITE_DIR, name) : undefined);

/** The x402 repository, for checking cited constants. Skips when missing. */
export const X402_DIR = process.env.X402_DIR ?? join(ROOT, "..", "x402");
export const x402File = (rel: string): string | undefined => (existsSync(join(X402_DIR, rel)) ? join(X402_DIR, rel) : undefined);
