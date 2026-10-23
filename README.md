# x402-solidarity

A reference implementation of draft 3 of the `solidarity` extension: a proposal that lets the owner of an AI agent give a small, fixed share of what the agent spends to a humanitarian fund, at a rate and monthly cap the owner sets in advance. The seller is paid in full and never pays the share. Each share becomes one line in a public log, and each month the log publishes a signed, witnessed statement over its lines.

Please read this first:

- **A proposal.** It is not part of x402 or any other protocol, and it has not been reviewed or endorsed by their maintainers.
- **Not affiliated.** It is not affiliated with or endorsed by any company, the UN or any fund. I take no money from it.
- **No fund exists.** Every fund address here is a placeholder (`0x...f00d`, `0x...beef`).
- **Simulated.** Everything except the testnet runs below is tested offline against a simulated chain. No money moves: test USDC has no value.
- **One live script, run once on Base Sepolia.** `examples/live-base-sepolia/` settles a purchase and its share on Base Sepolia, testnet only, with test USDC that has no value. On 2026-10-22 it settled a 1 USDC [purchase](https://sepolia.basescan.org/tx/0x28b37a956391981ab4e11c313b9454d24bf7469364a6f9de071a544fb4bbab5c) (to the payer itself) and then its 0.001 USDC [share](https://sepolia.basescan.org/tx/0xd1e4a7fb3152953a4ddcec9daeb49b09edff94074e3eb69c6c976bda37002a70) to the placeholder fund, both through the public x402.org facilitator. Its `SIMULATE=1` mode checks both transfers against the deployed USDC contract with `eth_call` and sends nothing, and a test also checks five ways it must fail.
- **A demo log Worker, not deployed.** `examples/demo-log-worker/` runs a log on its own in a Cloudflare Durable Object: every 6 hours it buys 1 test USDC from itself on Base Sepolia, its log settles the 0.001 USDC share to the placeholder fund, and each month a demo witness and a demo fund key, both held by the same Worker, cosign the statement. Under `wrangler dev` on 2026-10-23 it ran two real cycles on Base Sepolia, recorded only in a local dev log that was never published; its README lists them.
- **Written with AI assistance** (Claude Code).

The proposal and its simulated demos live at https://craigmerry.com/solidarity-levy/. The spec (draft 3, 2026-10-23) is the source of truth; where this code and the spec disagree, the spec wins and the code has a bug. It is three documents:

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

`npm test` also runs the demo log Worker's offline tests (`examples/demo-log-worker/test/`), which need no network and no wrangler.

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
examples/             the offline flow, the Base Sepolia script (simulate, facilitator or RPC), a Cloudflare Workers check,
                      and a demo log Worker (a Durable Object that runs a log on Base Sepolia by itself)
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
| `statements.json` | Three chained monthly statements, cosigned; the first two are the vectors in `attestation.md` |
| `files/`, `receipts/` | The same statements, lines and settlements as a log would publish them, and receipts |
| `spec-draft2-vectors.json` | A copy of the vectors in `attestation.md` (published as `solidarity-vectors.json`, unchanged since draft 2, hence the name); this code reproduces every byte, signatures included |

The site's `verify.py` accepts the generated files (`--lines`, `--chain`, receipts and `--selftest`), and the site's `merkle.js` agrees on every root, proof and statement hash. The tests check both when `SOLIDARITY_SITE_DIR` points at them (see "Run it").

## Constants

USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, with EIP-712 domain name `USDC` and version `2`. Both were copied from coinbase/x402 at commit `0e6e8c55`: `typescript/packages/mechanisms/evm/src/defaultAssets.ts` (`DEFAULT_ASSETS["eip155:84532"]`) and, for a second source, `typescript/packages/legacy/x402/src/types/shared/evm/config.ts`. The batch-settlement address and domain come from `typescript/packages/mechanisms/evm/src/batch-settlement/constants.ts`. coinbase/x402 is now a development fork of x402-foundation/x402, and that commit is not on x402-foundation main, but the same values are at the same paths on x402-foundation/x402 main as of 2026-10-22. A test reads those files from `X402_DIR` and checks them.

## What it does not do

- On its own it checks signatures offline with viem (`verifyTypedData`, which is ecrecover). It does not read balances or nonce state before accepting a share, and it does not handle smart-wallet signatures (ERC-1271, ERC-6492). A `LogChain` may supply `verifyExact`, the facilitator's own scheme check, which then replaces the offline one; the SDK kit in `integrations/x402-sdk/` does, through the operator's `ExactEvmScheme`.
- It does not open batch-settlement channels. As `attestation.md` says, the channel is funded outside the extension, and a share with a `deposit` payload is skipped with `bad-payment`.
- It does not resolve `did:web` or DNS keys. Verifiers pass a key resolver, which stands for that lookup and so answers for the current key only. A retired key is taken from the descriptor's `jwk`, and only with a cosignature the verifier requires. Which DID may sign as the log is checked here: by default only the root `did:web:<host>` of the log's host (`didWebAuthorizesLogKey`), never a `did:web:<host>:<path>` key such as a witness's served next to the log; `logKeyAuthorizer` adds the DNS route from the `controller` values a verifier read from `_controllers.<host>` itself.
- It refuses `batch-settlement` channels whose `payerAuthorizer` is zero. For those the contract checks the payer's signature with EIP-1271 when the payer has code, which this offline check cannot do, so a voucher that looks valid here could make every claim revert.
- On Base Sepolia, `findExactTransfer` (a share whose authorization someone else submitted first) searches only the last 2,000 blocks, about an hour, in 200-block requests because public RPC endpoints limit `eth_getLogs`. A transfer older than that is not found, and its share stays queued (its authorization reads used), never uncollected. The same window bounds the search for a cancellation.
- It does not record a skipped `exact` share that someone executes later anyway (a MAY in "Share kinds"). It records late only a share it accepted, reported uncollected and later sees executed.
- The library does not serve HTTP or store anything itself: the log's five endpoints are a function over memory. What draft 3 says must survive a restart goes to callbacks: each new statement to `persistStatement` before it is published, a witness's record to `Witness`'s `persist`, a fund's to `FundCosigner`'s, and each comes back as an option after a restart. `examples/demo-log-worker/` shows one way to do both, in a Durable Object that records every step and rebuilds the log by replaying the records. For that, `closePeriod(period, issuedAt, {signed})` (and `LogBook.close` with a stored JWS) re-adds a statement signed before, after checking it is the log key's signature over exactly the payload it rebuilt, so replay never signs and published statements stay byte for byte the same.
- Processor mode is arithmetic and bookkeeping only. It charges no one and pays no one.
- No consistency proofs: `attestation.md` closes every batch for good, so it does not need them.

## Where the spec was unclear

Where I had to choose, the code says so in a comment. Draft 3 settled the three choices listed here for draft 2 (a held share falls in the month its purchase confirms, a failed claim is retried for 14 days after its period ends, the cap counts the signed amount), and the code already did what it says. The main choices now, to settle in a later draft:

- **A cancelled authorization.** "Share kinds" says a share whose transfer was cancelled is uncollected, and also that the log MUST NOT report it uncollected until the chain shows the authorization unused (EIP-3009 `authorizationState`). USDC's `authorizationState` reads true for a cancelled authorization, as for a used one. Here a cancellation the chain shows (USDC's `AuthorizationCanceled` event, `LogChain.authorizationCanceled`) counts as showing it was never used, once `validBefore` has passed. A log that cannot read it keeps such a share queued, and then cannot retire.
- **Whose clock.** "Until its `validBefore` has passed" is read on the log's clock, 30 seconds past (`expiryMarginSeconds`), since block timestamps can lag it.
- **Exact shares at month close.** The spec says how long a log retries a failed claim, not how long it waits for an `exact` transfer that is not final. Here it waits the same 14 days, then closes the month without the share, still queued (never uncollected for that reason). One that executes later is recorded in the month the log sees it.
- **A held share after the log stops accepting shares.** "Retiring a log" says the log stops accepting shares, and a held share is accepted only when its purchase confirms. Here a share held before the log stopped is still processed when its purchase confirms, since the buyer was told `pending`, and `retire` refuses while any share is held.
- **A processor's shares below `minCollection` at retirement.** Here they are uncollected when the log retires; a processor could instead collect them below its minimum first.
- **A witness that lost its record.** It cannot know that in general. Here it refuses when a statement in front of it carries its own valid cosignature that its record does not hold.
- **`issuedAt`.** It is "the time of that first write": here the log's clock when it closes the month, for `LogBook` and a processor's log too (in the draft 2 code those two used the first second of the next month).

## License

Apache-2.0, the same as x402. See [LICENSE](LICENSE).
