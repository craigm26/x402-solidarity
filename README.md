# x402-solidarity

A reference implementation of draft 2 of the `solidarity` extension: a proposal that lets the owner of an AI agent give a small, fixed share of what the agent spends to a humanitarian fund, at a rate and monthly cap the owner sets in advance. The seller is paid in full and never pays the share. Each share becomes one line in a public log, and each month the log publishes a signed, witnessed statement over its lines.

Please read this first:

- **A proposal.** It is not part of x402 or any other protocol, and it has not been reviewed or endorsed by their maintainers.
- **Not affiliated.** It is not affiliated with or endorsed by any company, the UN or any fund. I take no money from it.
- **No fund exists.** Every fund address here is a placeholder (`0x...f00d`, `0x...beef`).
- **Simulated.** Everything except the one testnet run below is tested offline against a simulated chain. No money moves: test USDC has no value.
- **One live script, run once on Base Sepolia.** `examples/live-base-sepolia/` settles a purchase and its share on Base Sepolia, testnet only, with test USDC that has no value. On 2026-10-22 it settled a 1 USDC [purchase](https://sepolia.basescan.org/tx/0x28b37a956391981ab4e11c313b9454d24bf7469364a6f9de071a544fb4bbab5c) (to the payer itself) and then its 0.001 USDC [share](https://sepolia.basescan.org/tx/0xd1e4a7fb3152953a4ddcec9daeb49b09edff94074e3eb69c6c976bda37002a70) to the placeholder fund, both through the public x402.org facilitator. Its `SIMULATE=1` mode checks both transfers against the deployed USDC contract with `eth_call` and sends nothing, and a test also checks five ways it must fail.
- **Written with AI assistance** (Claude Code).

The proposal and its simulated demos live at https://craigmerry.com/solidarity-levy/. The spec (draft 2, 2026-10-22) is the source of truth; where this code and the spec disagree, the spec wins and the code has a bug. It is three documents:

- [`solidarity.md`](https://craigmerry.com/solidarity-levy/spec/solidarity.md), the x402 extension: owner policy, advertisement, the `PaymentPayload` fields and their schema, the `exact` share kind, facilitator behaviour, the outcome in `SettleResponse`, refunds. This is what `client.ts`, `resourceServer.ts`, `schema.ts`, `validation.ts`, `policy.ts`, the EIP-3009 code in `evm.ts` and the checks in `facilitator.ts` implement.
- [`attestation.md`](https://craigmerry.com/solidarity-levy/spec/attestation.md), the receipt attestation contract, normative for logs: lines, batches, settlement references, statements, keys, witnesses, receipts, publication, the optional `batch-settlement` share kind, and the test vectors. This is `ledger.ts`, `book.ts`, `merkle.ts`, `jcs.ts`, the channel handling in `evm.ts`, `client.ts` and `facilitator.ts`, and the conformance files.
- [`processor-mode.md`](https://craigmerry.com/solidarity-levy/spec/processor-mode.md), informative: processor mode for card and bank rails, `net` refunds, `minCollection`, fees, AP2 and ACP notes, fund policy. This is `processor.ts` and `solidarityMandate` in `client.ts`.

Comments in the code cite sections by name: a name alone is a heading of `solidarity.md`, and sections of the other two documents come with the document's URL.

## Run it

Node 24 runs the TypeScript directly (type stripping, no build step). The only dependency is viem.

```
npm install
npm test
node examples/e2e-offline.ts
```

The integration kit for the x402 TypeScript SDK has its own exact-pinned dependencies and its own tests, which the root `npm test` does not run. After `npm install` in the root:

```
cd integrations/x402-sdk
npm install
npm test
```

It also runs in Cloudflare Workers with the `nodejs_compat` flag. Signing never hands node:crypto a `{ key, dsaEncoding }` options object, which workerd rejects for KeyObjects; ES256 converts between DER and the JWS r||s form itself. To check a Workers build, run `npx wrangler dev` in `examples/cloudflare-worker/`, then `node examples/cloudflare-worker/check.ts http://127.0.0.1:8787`: signatures made in workerd must verify in Node, signatures made in Node must verify in workerd, and tampered ones must fail in both.

`npm test` runs every test with `node:test`. A few cross-checks need files from outside this repository. They read only the two environment variables below, with no default paths, and without them they skip and say which variable to set:

- `SOLIDARITY_SITE_DIR`: a folder with the site's checkers and the three spec documents, laid out as on the site. Without it, the tests that run `merkle.js` and `verify.py` against the conformance files, and the one that compares the schemas here with the spec's, skip. To fetch them:

  ```
  mkdir -p site/spec && (
    set -e
    for f in merkle.js verify.py spec/solidarity.md spec/attestation.md spec/processor-mode.md; do
      curl -fsS -o site/$f https://craigmerry.com/solidarity-levy/$f
    done
  ) && SOLIDARITY_SITE_DIR=$PWD/site npm test
  ```

  A failed download stops it before the tests run. `site/` is in `.gitignore`.

- `X402_DIR`: a checkout of the x402 repository (x402-foundation/x402), for the test that checks the cited USDC and batch-settlement constants. Without it, that test skips.

- `BASE_SEPOLIA_RPC_URL`: a Base Sepolia RPC endpoint such as `https://sepolia.base.org`, for the test that runs signed shares against the deployed USDC contract with `eth_call` (it sends nothing). Without it, that test skips.

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
examples/             the offline flow, the Base Sepolia script (simulate, facilitator or RPC), and a Cloudflare Workers check
integrations/x402-sdk/  a kit that wires the extension into the x402 TypeScript SDK 2.28.0, with its own package.json and README
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

Everything in `conformance/` is generated by `node scripts/generate-conformance.ts`, and a test fails if the files drift from the generator. The keys are published test keys and must never hold value: the payer is the well-known Hardhat and Anvil development account 0, account 1 signs the vouchers for a channel that is not its own, and statements are signed with the RFC 8032 section 7.1 TEST 1, 2 and 3 keys.

| File | What it holds |
| --- | --- |
| `jcs-rfc8785.json` | The RFC 8785 examples: primitives, property sorting, UTF-8 bytes, the number table |
| `merkle-rfc6962.json` | The Merkle test leaves of the Certificate Transparency reference implementation (RFC 6962 hashing), roots for every prefix, audit paths |
| `shares.json` | Share, recorded amount and `net` credit arithmetic, and which rates are valid |
| `policies.json` | Valid and invalid owner policies per mode, a policy hash, the AP2 Solidarity Mandate for a processor-mode policy |
| `ap2.json` | AP2 Solidarity Mandates presented to one holder in order: what its Mandate Receipt says (enrolled, or refused with each reason), and the shares it records for finalized payments under the policy in force |
| `payloads.json` | Forty-four facilitator cases, processed in order by one log. Each has its outcome written by hand (`want`), and the generator fails if the log disagrees; `expected` is the log's full outcome. Every skip reason is covered. Each `bad-payment` case breaks one rule and is valid in every other respect, so a log that left that rule out would accept it. Shape checks on malformed payloads are in `test/hardening.test.ts` instead |
| `ledger.json` | The batch those cases produce, with every line's audit path and the settlements file |
| `statements.json` | Three chained monthly statements, cosigned; the first two are the draft 2 vectors in `attestation.md` |
| `files/`, `receipts/` | The same statements, lines and settlements as a log would publish them, and receipts |
| `spec-draft2-vectors.json` | A copy of the vectors in `attestation.md` (published as `solidarity-vectors.json`); this code reproduces every byte, signatures included |

The site's `verify.py` accepts the generated files (`--lines`, `--chain`, receipts and `--selftest`), and the site's `merkle.js` agrees on every root, proof and statement hash. The tests check both when `SOLIDARITY_SITE_DIR` points at them (see "Run it").

## Constants

USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, with EIP-712 domain name `USDC` and version `2`. Both were copied from coinbase/x402 at commit `0e6e8c55`: `typescript/packages/mechanisms/evm/src/defaultAssets.ts` (`DEFAULT_ASSETS["eip155:84532"]`) and, for a second source, `typescript/packages/legacy/x402/src/types/shared/evm/config.ts`. The batch-settlement address and domain come from `typescript/packages/mechanisms/evm/src/batch-settlement/constants.ts`. coinbase/x402 is now a development fork of x402-foundation/x402, and that commit is not on x402-foundation main, but the same values are at the same paths on x402-foundation/x402 main as of 2026-10-22. A test reads those files from `X402_DIR` and checks them.

## What it does not do

- On its own it checks signatures offline with viem (`verifyTypedData`, which is ecrecover). It does not read balances or nonce state before accepting a share, and it does not handle smart-wallet signatures (ERC-1271, ERC-6492). A `LogChain` may supply `verifyExact`, the facilitator's own scheme check, which then replaces the offline one; the SDK kit in `integrations/x402-sdk/` does, through the operator's `ExactEvmScheme`.
- It does not open batch-settlement channels. As `attestation.md` says, the channel is funded outside the extension, and a share with a `deposit` payload is skipped with `bad-payment`.
- It does not resolve `did:web` or DNS keys. Verifiers pass a key resolver, which stands for that lookup and so answers for the current key only. A retired key is taken from the descriptor's `jwk`, and only with a cosignature the verifier requires.
- It refuses `batch-settlement` channels whose `payerAuthorizer` is zero. For those the contract checks the payer's signature with EIP-1271 when the payer has code, which this offline check cannot do, so a voucher that looks valid here could make every claim revert.
- The Base Sepolia script's two chains (RPC and facilitator) do not implement `findExactTransfer`, so there a share whose authorization someone else submitted first is reported uncollected. The simulated chain implements it.
- It does not serve HTTP or persist anything. The log's five endpoints are a function over memory.
- Processor mode is arithmetic and bookkeeping only. It charges no one and pays no one.
- No consistency proofs: `attestation.md` closes every batch for good, so it does not need them.

## Where the spec was unclear

Where I had to choose, the code says so in a comment. The main choices, to settle in draft 3:

- The spec implies, without saying it, that a held `exact` share falls in the month its purchase confirms, when the log accepts it ("the month the log accepted the share"). Here it is that month.
- The spec says a log retries a failed claim until the statement for the share's period is due, and that statement SHOULD appear within 15 days after the period ends. Here the log stops at 14 days after the period ends (`claimGraceSeconds`), so a statement issued on time never waits on a claim.
- The cap counts the signed amount, so an `upto` purchase that settles for less still uses the larger amount, with no way to release it.

## License

Apache-2.0, the same as x402. See [LICENSE](LICENSE).
