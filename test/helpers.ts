import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const conformance = (rel: string) => JSON.parse(readFileSync(join(ROOT, "conformance", rel), "utf8"));
export const conformanceText = (rel: string) => readFileSync(join(ROOT, "conformance", rel), "utf8");

/**
 * The site's files, for cross-checks: merkle.js and verify.py, and the three
 * spec documents under spec/ (solidarity.md, attestation.md, processor-mode.md).
 * Only SOLIDARITY_SITE_DIR points at them, with no default; when it is unset or
 * a file is missing, the tests that need it skip and say so (README, "Run it").
 */
export const SITE_DIR = process.env.SOLIDARITY_SITE_DIR;
export const siteFile = (name: string): string | undefined => (SITE_DIR && existsSync(join(SITE_DIR, name)) ? join(SITE_DIR, name) : undefined);

/** A checkout of the x402 repository, for checking cited constants: X402_DIR only, no default. */
export const X402_DIR = process.env.X402_DIR;
export const x402File = (rel: string): string | undefined => (X402_DIR && existsSync(join(X402_DIR, rel)) ? join(X402_DIR, rel) : undefined);
