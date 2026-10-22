# x402-solidarity

A reference implementation of draft 2 of the `solidarity` extension: a proposal that lets the owner of an AI agent give a small, fixed share of what the agent spends to a humanitarian fund, at a rate and monthly cap the owner sets in advance. The seller is paid in full and never pays the share. Each share becomes one line in a public log, and each month the log publishes a signed, witnessed statement over its lines.

Please read this first:

- **A proposal.** It is not part of x402 or any other protocol, and it has not been reviewed or endorsed by their maintainers.
- **Not affiliated.** It is not affiliated with or endorsed by any company, the UN or any fund. I take no money from it.
- **No fund exists.** Every fund address here is a placeholder (`0x...f00d`, `0x...beef`).
- **Simulated.** Everything is tested offline against a simulated chain. No money moves.
- **One live script, never run.** `examples/live-base-sepolia/` would settle a share on Base Sepolia. It is testnet only and untested against a live chain.

The proposal, its spec and simulated demos live at https://craigmerry.com/solidarity-levy/. The spec ([`spec/solidarity.md`](https://craigmerry.com/solidarity-levy/spec/solidarity.md), draft 2, 2026-10-22) is the source of truth; where this code and the spec disagree, the spec wins and the code has a bug.

## Run it

Node 24 runs the TypeScript directly (type stripping, no build step). The only dependency is viem.

```
npm install
npm test
node examples/e2e-offline.ts
```

`npm test` runs every test with `node:test`. Two cross-checks use the site's own `merkle.js` and `verify.py` when they are found next to this repository (set `SOLIDARITY_SITE_DIR` to point elsewhere); one checks the cited USDC constants against a checkout of the x402 repository (`X402_DIR`). They skip when those files are missing.

## What is here

```
src/solidarity/       the extension, laid out like @x402/extensions/payment-identifier
  index.ts            exports and usage
  types.ts            constants, skip reasons, wire and ledger types
  constants.ts        USDC on Base Sepolia and batch-settlement constants, with sources
  schema.ts           the spec's JSON schemas and a small validator for them
  utils.ts            share ids, floor(amount x rate) in bigint, CAIP-10, periods
  policy.ts           owner policy checks, a local policy hash, the cap counter
  evm.ts              EIP-3009 and batch-settlement voucher signing and checks (viem)
  client.ts           the policy holder: builds and signs the share; processor-mode fields
  resourceServer.ts   the seller's declaration
  validation.ts       extraction and schema validation
  facilitator.ts      the log: ordered checks, outcomes, claims, month close, /proofs
  book.ts             batches, settlement files, chained statements, publication
  ledger.ts           lines, RFC 6962 batches, JCS statements, JWS, receipts, witness, fund
  jcs.ts              RFC 8785
  merkle.ts           RFC 6962 trees and inclusion proofs
  processor.ts        processor mode (card and bank rails), as bookkeeping only
src/sim/chain.ts      the simulated chain: USDC with EIP-3009, a batch-settlement escrow
conformance/          JSON test vectors for other implementations (see below)
examples/             the offline flow, and the Base Sepolia script
scripts/              the conformance generator
test/                 node:test suites
```

The module split follows `typescript/packages/extensions/src/payment-identifier` in the x402 repository (`types`, `schema`, `utils`, `client`, `resourceServer`, `validation`, `index`), so it can be ported into `@x402/extensions` later. Imports use `.ts` extensions and only erasable TypeScript syntax.

## The flow

1. The owner sets a policy: rate (at most 1%), monthly cap, fund, refund rule. The agent holds it; it never goes on the wire.
2. A seller declares the extension on its routes, with a log for each network and scheme.
3. The agent signs the purchase and, next to it, its own payment for the share: an EIP-3009 transfer to the fund (`exact`), or a cumulative voucher on a channel whose receiver is the fund (`batch-settlement`). The cap counts the share when it is signed.
4. The facilitator verifies and settles the purchase exactly as it would without the extension. Only after the purchase settles does the log check the share, in the spec's order, and record a line. The outcome goes back to the buyer in `SettleResponse.extensions.solidarity`. A problem with the share never changes the purchase.
5. Refunds never touch a share in separate mode (`keep`). Nothing ever comes back from a fund.
6. At month end the log claims what it is owed, builds the batch (an RFC 6962 Merkle tree over sorted lines), writes the settlements file and signs a JCS statement chained to the previous month. A witness and the fund cosign it; the fund's cosignature says the money arrived.
7. The owner fetches `/proofs/<id>` and the statement, and checks the inclusion proof and the signatures.

`node examples/e2e-offline.ts` walks through all of that with throwaway keys, including a failed purchase, a refund and the month close.

## Conformance vectors

Everything in `conformance/` is generated by `node scripts/generate-conformance.ts`, and a test fails if the files drift from the generator. The keys are published test keys and must never hold value: the payer is the well-known Hardhat and Anvil development account 0, and statements are signed with the RFC 8032 section 7.1 TEST 1, 2 and 3 keys.

| File | What it holds |
| --- | --- |
| `jcs-rfc8785.json` | The RFC 8785 examples: primitives, property sorting, UTF-8 bytes, the number table |
| `merkle-rfc6962.json` | The RFC 6962 test leaves, roots for every prefix, audit paths |
| `shares.json` | Share, recorded amount and `net` credit arithmetic, and which rates are valid |
| `policies.json` | Valid and invalid owner policies per mode, a policy hash, a processor-mode constraint |
| `payloads.json` | Twenty facilitator cases, processed in order by one log, with the expected outcome of each (every skip reason is covered) |
| `ledger.json` | The batch those cases produce, with every line's audit path and the settlements file |
| `statements.json` | Three chained monthly statements, cosigned; the first two are the spec's own draft 2 vectors |
| `files/`, `receipts/` | The same statements, lines and settlements as a log would publish them, and receipts |
| `spec-draft2-vectors.json` | A copy of the spec's vectors; this code reproduces every byte, signatures included |

The site's `verify.py` accepts the generated files (`--lines`, `--chain`, receipts and `--selftest`), and the site's `merkle.js` agrees on every root, proof and statement hash. The tests check both.

## Constants

USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, with EIP-712 domain name `USDC` and version `2`. Both come from the x402 repository at commit `0e6e8c55`: `typescript/packages/mechanisms/evm/src/defaultAssets.ts` (`DEFAULT_ASSETS["eip155:84532"]`) and, for a second source, `typescript/packages/legacy/x402/src/types/shared/evm/config.ts`. The batch-settlement address and domain come from `typescript/packages/mechanisms/evm/src/batch-settlement/constants.ts`. A test reads those files and checks them.

## What it does not do

- It checks signatures offline with viem (`verifyTypedData`, which is ecrecover). It does not read balances or nonce state before accepting a share, and it does not handle smart-wallet signatures (ERC-1271, ERC-6492). A real facilitator would add its usual chain reads.
- It does not open batch-settlement channels. The owner deposits out of band; a share with a `deposit` payload is skipped.
- It does not resolve `did:web` or DNS keys. Verifiers pass a key resolver.
- It does not serve HTTP or persist anything. The log's five endpoints are a function over memory.
- Processor mode is arithmetic and bookkeeping only. It charges no one and pays no one.
- No consistency proofs: the spec closes every batch for good, so it does not need them.

## Where the spec was unclear

Where I had to choose, the code says so in a comment. The main choices, to settle in draft 3:

- There is no skip reason for a malformed share (bad id, a rate with trailing zeros). I used `bad-payment`, and `over-rate` only for a well-formed rate above 0.01.
- It is not said whether a skipped share's id counts as "seen". Here only ids the log holds (accepted or pending) count, so a retried share is checked again.
- "Uncollected" is defined only for `batch-settlement`. An accepted `exact` share whose transfer later fails is treated as uncollected too.
- It is not said when a share held for a `settlement_pending` purchase is checked. Here it is checked when the purchase confirms, in that month.
- Refund payloads and escrow flows get `purchase-not-supported`.
- The cap counts the signed amount, so an `upto` purchase that settles for less still uses the larger amount, with no way to release it.

## License

Apache-2.0, the same as x402. See [LICENSE](LICENSE).
