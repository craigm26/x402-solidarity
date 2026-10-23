/**
 * What the demo fund checks before it cosigns a month: that every
 * `exact:<transaction>` settlement reference is a successful Base Sepolia
 * transaction with exactly one USDC Transfer to the fund's address, of the
 * listed amount (attestation.md, "Witnesses and the fund").
 *
 * FundCosigner reads a synchronous FundView, so the chain is read first, one
 * receipt at a time, and each reading is recorded as a fund-check event. The
 * view is then built from those recorded facts, which also makes the fund's
 * decision replayable.
 */

import type { FundView } from "../../src/solidarity/index.ts";
import type { ReceiptFacts } from "./io.ts";
import { TRANSFER_TOPIC } from "./io.ts";

export interface TransferFact {
  token: string;
  to: string;
  value: string;
}

export interface FundCheck {
  tx: string;
  block: string;
  status: "success" | "reverted";
  /** The one USDC Transfer to the fund in this transaction, or null if there is not exactly one. */
  transfer: TransferFact | null;
}

const word = (address: string): string => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** The single Transfer of `token` to `fund` in a receipt, or null when there is none or more than one. */
export function transferToFund(receipt: ReceiptFacts, token: string, fund: string): TransferFact | null {
  const t = token.toLowerCase();
  const to = word(fund);
  const hits = receipt.logs.filter((l) => l.address.toLowerCase() === t && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics[2]?.toLowerCase() === to);
  if (hits.length !== 1) return null;
  return { token: t, to: fund.toLowerCase(), value: BigInt(hits[0].data).toString() };
}

/** The fund-check body for a receipt. */
export function fundCheckOf(tx: string, receipt: ReceiptFacts, token: string, fund: string): FundCheck {
  return { tx: tx.toLowerCase(), block: receipt.blockNumber.toString(), status: receipt.status, transfer: receipt.status === "success" ? transferToFund(receipt, token, fund) : null };
}

/** A FundView over recorded checks. There are no claims or payouts in this log. */
export function fundViewFrom(checks: ReadonlyMap<string, FundCheck>): FundView {
  return {
    exactTransfer(tx) {
      const c = checks.get(tx.toLowerCase());
      return c && c.status === "success" && c.transfer ? { token: c.transfer.token, to: c.transfer.to, value: BigInt(c.transfer.value) } : undefined;
    },
    claimIncrease() {
      return undefined;
    },
  };
}

/** The exact:<transaction> references of a settlements file's parsed entries; throws on any other kind. */
export function exactRefs(entries: ReadonlyArray<{ ref: string }>): string[] {
  return entries.map((e) => {
    const m = /^exact:(0x[0-9a-f]{64})$/.exec(e.ref);
    if (!m) throw new Error(`fund refuses: ${e.ref} is not an exact transfer this log could list`);
    return m[1];
  });
}
