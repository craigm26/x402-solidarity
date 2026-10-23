# x402 SDK integration kit

This folder wires the draft 2 `solidarity` extension into the official x402 TypeScript SDK, version 2.28.0 (`@x402/core`, `@x402/evm`, and `@x402/fetch` for buyers). Each role adds it in about three lines, and the kit reuses the reference implementation in `../../src/solidarity/` unchanged.

Read this first:

- **A proposal.** The `solidarity` extension is not part of x402 or any other protocol. This kit is not affiliated with or endorsed by x402, Coinbase, the x402 Foundation, the UN or any fund, and it has not been reviewed by the SDK's maintainers.
- **No fund exists.** Every fund address here is a placeholder (`0x...f00d`, `0x...beef`). Nobody controls them.
- **Simulated.** Every test runs the real SDK classes in one process against a simulated chain (`../../src/sim/chain.ts`), with throwaway keys, no sockets and no network. No money moves.
- **Testnet only** for anything beyond the tests: the manual appendix at the end uses Base Sepolia and test USDC, and nothing here has been run against a live chain.
- **Pinned.** The facilitator side relies on how `@x402/core` 2.28.0 hands the settle result to its hooks (see "How the outcome reaches the buyer"). The versions are pinned exactly, and a test fails if that behaviour changes.
- **Written with AI assistance** (Claude Code).

The spec is three documents at https://craigmerry.com/solidarity-levy/spec/: `solidarity.md` (the extension), `attestation.md` (the log) and `processor-mode.md` (informative). Where this kit and the spec disagree, the spec wins.

## The lines per role

```ts
// Buyer (the agent that holds the owner's policy)
client.registerExtension(solidarityClientExtension({ policy, counter, signer, descriptors }));

// Seller
server.registerExtension(solidarityServerExtension());
routes["GET /report"].extensions = { solidarity: declareSolidarityExtension([{ network: "eip155:84532", scheme: "exact", log: "https://facilitator.example/solidarity" }]) };

// Facilitator (runs the log)
const solidarity = attachSolidarity(facilitator, { log });
const handle = facilitatorFetchHandler({ facilitator, solidarity });
```

## Install and test

Node 24 runs the TypeScript directly; there is no build step. The kit imports the reference code by relative path, so install the repository root first (it provides viem for `src/`), then the kit:

```
npm install                          # in the repository root
cd integrations/x402-sdk
npm install
npm test                             # node --test --test-concurrency=1 test/*.test.ts
```

The root `npm test` does not run the kit's tests (its glob is `test/*.test.ts` at the root), but its dash check does read the kit's text files, the lockfile included.

| Test file | What it covers |
| --- | --- |
| `e2e.test.ts` | A buyer's x402Client (through `wrapFetchWithPayment`) pays an x402HTTPResourceServer route that settles through an x402Facilitator with `@x402/evm`'s ExactEvmScheme on the simulated chain. The share lands in the log, the buyer reads the outcome from `PAYMENT-RESPONSE`, the fund's simulated balance rises by exactly the share. Also: a failed purchase, `settlement_pending` with and without the seller's retry, three bad shares (byte-identical purchase core fields against a run with no extension), no policy, no declaration, a facilitator without the kit, the month close with a verified receipt, `batch-settlement` shares, and the cap. |
| `client.test.ts` | The buyer's extension inside x402Client: the share's window, the untouched declaration, the fallback, missing or throwing descriptors and signers, the owner's rules, no retry signal. |
| `resourceServer.test.ts` | No settle enrichment, echo validation with `dynamicInfoFields`, logs filled from `/supported`. |
| `facilitator.test.ts` | `/supported`, `/verify` unchanged, the SDK canary, a throwing log, a log that changes a core field, an unsubmittable share, `process()` without the hook. |
| `wire.test.ts` | The SDK's own HTTPFacilitatorClient against `facilitatorFetchHandler` (through a swapped `globalThis.fetch`), and the log's read endpoints. |
| `kit.test.ts` | Exact pins, the installed versions, constants shared with the SDK, this README's plain statements, no dashes. |

## For a facilitator operator: an afternoon

You already run an x402 facilitator on `@x402/core`. You add a log: it checks each share after the purchase settles, records a line, submits the share's transfer to the fund, and publishes a signed statement each month.

### 1. Register the exact scheme yourself

`registerExactEvmScheme` hides the scheme instance, and the log needs it to settle shares without running your facilitator's hooks on them. So construct it:

```ts
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";

const exact = new ExactEvmScheme(signer);          // your FacilitatorEvmSigner
const facilitator = new x402Facilitator();
facilitator.register("eip155:84532", exact);      // plus registerV1(...) if you serve v1
```

### 2. Create the log and attach it

```ts
import { SolidarityLog, attachSolidarity, facilitatorLogChain } from "./integrations/x402-sdk/src/index.ts";

const log = new SolidarityLog({ descriptor, key, chain: facilitatorLogChain(exact) });
const solidarity = attachSolidarity(facilitator, { log, onError: (e, where) => console.error("solidarity", where, e) });
```

`attachSolidarity` does two things: `facilitator.registerExtension(...)`, so `/supported` lists `"solidarity"`, and `facilitator.onAfterSettle(...)`, which hands each settled purchase to the log. It registers nothing on `/verify`: the purchase is verified exactly as without the extension, and a test checks that the VerifyResponse is identical with and without a share, with no chain writes.

`facilitatorLogChain(exact)` settles an accepted `exact` share as the spec says: through your existing scheme code, with `paymentPayload = {x402Version: 2, accepted: payment.accepted, payload: payment.payload}` and `paymentRequirements = payment.accepted`. If that settle comes back `settlement_pending`, it settles again (twice by default), and the scheme's pending store reconciles the same broadcast. The optional `batch-settlement` share kind needs channel reads and claims that a FacilitatorEvmSigner cannot make; pass them as `facilitatorLogChain(exact, { fallback })`, or leave `batch-settlement` out of your descriptor.

### 3. The descriptor and the log's key

The descriptor is what `GET <log>` serves (attestation.md, "Publication"):

```ts
import { generateSigningKey, publicJwk } from "./integrations/x402-sdk/src/index.ts";

const key = generateSigningKey("EdDSA", "did:web:facilitator.example#solidarity-1"); // load yours from a secret store
const descriptor = {
  version: 2,
  log: "https://facilitator.example/solidarity",
  funds: ["eip155:84532:0x000000000000000000000000000000000000f00d"],   // placeholder: no fund exists
  accepts: [
    { network: "eip155:84532", asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", scheme: "exact",
      maxTimeoutSeconds: 60, minAmount: "10000", extra: { name: "USDC", version: "2" } },
  ],
  keys: [{ kid: key.kid, from: "2026-10", until: null, jwk: publicJwk(key.publicKey) }],
  witnesses: ["did:web:witness.example"],
};
```

- `funds` is your allow-list. You settle shares only to these.
- `minAmount` is your lever on gas. You pay the gas for every `exact` share transfer (totals are gross; processor-mode.md, "Fees"), so set it where one transfer is worth it.
- The key's `kid` is a DID URL on the log's host. Publish the key in a `did:web` document there (or a DNS TXT record), as attestation.md, "Signatures and keys", says. The reference code keeps the key in memory; where it comes from is up to you.

### 4. Serve it

`facilitatorFetchHandler` is a `(Request) => Promise<Response>` handler. It serves `POST /verify`, `POST /settle`, `GET /supported`, and the log's five read endpoints under the log's path. It runs wherever Request and Response exist. A node:http bridge, **untested** (the tests never open a socket):

```ts
import { createServer } from "node:http";
import { facilitatorFetchHandler } from "./integrations/x402-sdk/src/index.ts";

const handle = facilitatorFetchHandler({ facilitator, solidarity });
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const r = await handle(new Request(`https://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(4021);
```

The handler has no authentication, rate limits or body size limits. Put it behind whatever you use for those now.

The log's five read endpoints (attestation.md, "Publication"), all `GET`:

| Path | Returns |
| --- | --- |
| `<log>` | the descriptor |
| `<log>/statements/<period>` | `{statement, cosignatures}` |
| `<log>/lines/<period>` | the batch's lines, sorted, each followed by LF |
| `<log>/settlements/<period>` | the settlements file |
| `<log>/proofs/<id>` | `included` with the audit path, `queued`, `pending`, `uncollected`, or 404 |

### 5. What to tell sellers

`/supported` can say that you run a log (`"solidarity"` in `extensions`), but its `extensions` is a list of strings, so it cannot carry the log's URL (solidarity.md, "Open questions", 1). Tell your sellers the URL, conventionally `<your facilitator base URL>/solidarity`, or point them at the dynamic form in "For sellers" below.

### 6. Month close

At the start of each month, close the previous one:

```ts
const statement = await log.closePeriod("2026-10");
```

It claims what it is owed on any `batch-settlement` channels, builds the batch (an RFC 6962 tree over the sorted lines), writes the settlements file and signs a statement chained to the previous month. Witnesses and the fund then cosign it, and you add their cosignatures with `log.addCosignature(period, envelope)`. Owners check their shares with `/proofs/<id>` and the statement. `test/e2e.test.ts` does this with a mocked clock and verifies a receipt.

### Operating rules

- **Answer `/settle` with HTTP 200 for every SettleResponse, failed or not.** The SDK's HTTPFacilitatorClient throws on any other status, and the seller's SDK then rebuilds the failure without `extensions`, so the buyer loses the outcome. `facilitatorFetchHandler` does this; keep it if you write your own server.
- **Put `extensionResponses` in the EXTENSION-RESPONSES header** (base64 JSON) and leave it out of the body. That is where the seller's SDK reads it, and it never reaches the buyer.
- **Your own after-settle hooks must never throw.** In x402Facilitator a throwing after-settle hook turns a settled purchase into a failed settle. The kit's hook is total, and if a core field of the purchase's SettleResponse ever differs after it ran, it puts the field back and drops its entry.
- **Wait for `followUp` before you stop.** The response is not delayed for the share: an accepted `exact` share is submitted afterwards. Call `await solidarity.drain()` on shutdown, or pass `onFollowUp` to hand each one to a `waitUntil`.
- **Nothing persists.** `SolidarityLog` keeps its lines, held shares and channel state in memory. A restart loses queued shares and any statement not yet published. A real log needs storage behind it; the reference code does not have any.
- **`settlement_pending`.** When a purchase settle returns `settlement_pending`, its `exact` share is held. The seller's SDK settles once more; if that confirms, the kit resolves the held share. If the purchase is still pending after that, the share stays held and is reported `pending`; your own receipt watcher calls `solidarity.resolvePending(transaction, confirmed)` when it knows, and the result shows at `/proofs/<id>`.

### How the outcome reaches the buyer

x402Facilitator has no hook that returns an enriched SettleResponse: after-settle hooks return nothing, and `settle()` never builds `extensions` itself. It does return the very object it passed to the hooks as `ctx.result`. So the kit's hook writes `ctx.result.extensions.solidarity` (for the buyer) and `ctx.result.extensionResponses.solidarity` (for the seller). This is how 2.28.0 behaves, not a documented contract, which is why the versions are pinned and `facilitator.test.ts` has a canary for it.

If you would rather not rely on it, skip `attachSolidarity` and wrap your own `/settle`:

```ts
const solidarity = solidarityFacilitator({ log });
facilitator.registerExtension(solidarity);            // so /supported lists it
const r = await facilitator.settle(paymentPayload, paymentRequirements);
return (await solidarity.process(paymentPayload, paymentRequirements, r)).response;   // a new object
```

From there the outcome travels in `PAYMENT-RESPONSE` (the seller's SDK keeps `extensions` and strips `extensionResponses`), on a failed purchase's 402 as well, to the buyer's `onPaymentResponse` hook.

## For sellers

Register the extension once, and declare it on each route where you offer the slot:

```ts
import { solidarityServerExtension, declareSolidarityExtension } from "./integrations/x402-sdk/src/index.ts";

server.registerExtension(solidarityServerExtension());
const routes = {
  "GET /report": {
    accepts: { scheme: "exact", network: "eip155:84532", payTo, price: "$0.50", maxTimeoutSeconds: 60 },
    extensions: { solidarity: declareSolidarityExtension([{ network: "eip155:84532", scheme: "exact", log: "https://facilitator.example/solidarity" }]) },
  },
};
```

Your price does not change and you never pay the share. Your declaration carries `version` and `logs` only; the buyer adds the rest. The extension sets `dynamicInfoFields: ["logs"]`, so changing a route's logs between a 402 and the paid request does not fail the purchase.

To fill `logs` from your facilitator's `/supported` instead, declare `declareSolidarityExtension([])` on the route and register:

```ts
solidarityServerExtension({ server, logFor: () => conventionalLogUrl(facilitatorClient.url) });
```

A (network, scheme) then gets a log only when the facilitator serving it lists `"solidarity"`, after `initialize()`.

Do not give `solidarity` an `enrichSettlementResponse` of your own: x402ResourceServer assigns its return value over `extensions.solidarity`, which would replace the log's outcome before it reaches the buyer. You can read the status for your records in your own after-settle hook, at `ctx.result.extensionResponses.solidarity`.

## For buyers (agents)

```ts
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { CapCounter, createDescriptorCache, solidarityClientExtension } from "./integrations/x402-sdk/src/index.ts";

const policy = { version: 2, rate: "0.001", cap: { amount: "5000000", asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" },
  fund: "eip155:84532:0x000000000000000000000000000000000000f00d",   // placeholder: no fund exists
  logs: ["https://facilitator.example/solidarity"], refunds: "keep", since: "2026-10-22T09:00:00Z" };
const counter = new CapCounter(policy);
const descriptors = createDescriptorCache();
await descriptors.prefetch(policy.logs);   // at startup: a purchase never waits for a descriptor

const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(account));          // a viem LocalAccount
client.registerExtension(solidarityClientExtension({ policy, counter, signer: account, descriptors }));
const pay = wrapFetchWithPayment(fetch, client);
```

- Show the owner the rate, cap, fund and refund rule when they consent (`consentSummary(policy)`). The policy never goes on the wire.
- A share is added only when the seller declared a log for the purchase's network and scheme, the owner trusts that log, its descriptor is cached and lists the fund, the purchase is in the cap's asset, and the cap has room. Otherwise the purchase goes ahead exactly as plain x402.
- The cap counts a share when it is signed, even if the purchase later fails. The spec lets you release an `exact` share once its `validBefore` has passed and it was never executed (`counter.release`).
- Shares are signed outside x402Client's spend controls, which filter only the purchase's accepts. The owner's cap is the only limit on shares.
- The outcome you get is unsigned and passes through the seller. Proof is inclusion in a cosigned statement, which you fetch from `/proofs/<id>`. Pass `onOutcome` to see each outcome.

## What is simulated, and what a real deployment still needs

In the tests, `SimulatedChain` plays Base Sepolia's USDC behind a FacilitatorEvmSigner adapter (`test/harness.ts`): EIP-3009 signatures, time windows, nonces and balances are checked as the contract would, receipts carry the Transfer event the SDK checks, and transaction hashes are deterministic. Every key is generated for the run and thrown away. The fund is a placeholder address, and its "balance" is a number in memory.

A real deployment would still need:

- **A real fund** that has agreed to receive shares, on your allow-list, and that cosigns the statements naming it (attestation.md, "Witnesses and the fund"). None exists today.
- **Keys:** the log's statement key in a secret store, published in a `did:web` document or DNS, and a facilitator signer with gas for every share transfer.
- **Witnesses** that check and cosign each month's statement.
- **Chain reads** the reference code does not make: balances and nonce state before accepting a share, smart-wallet signatures (ERC-1271, ERC-6492), and `findExactTransfer` (an RPC client reading `AuthorizationUsed` and `Transfer` events), without which a share someone else submitted first is reported uncollected.
- **Storage** for lines, held shares, channel state and published statements.
- **Answers to the regulatory questions** in processor-mode.md, "Open questions" 3: passing other people's money to a third-party fund can be money transmission or remittance, and can need charitable-solicitation registration. Nothing here answers them.

## What it does not do

- Permit2, `upto` and `auth-capture` purchases are not exercised; the simulated signer models EIP-3009 `exact` only. The client code reads a Permit2 purchase window, but that path is untested.
- `batch-settlement` purchases never carry a share (the spec forbids it), and the kit's `batch-settlement` shares need channel support from `fallback`.
- The client gives up a channel share whose response never arrived after `staleChannelSeconds` (default 300) and relies on a `cumulative-mismatch` to resync. That path is untested.
- The descriptor cache trusts any `https` URL a seller declares unless the policy lists `logs`. Set `logs`.

## Appendix: trying it on Base Sepolia with test USDC (manual, testnet only)

Nothing in the tests, and no agent, runs these steps. They use the repository's existing `examples/live-base-sepolia/` script, not this kit's facilitator. Test USDC has no value. Any test USDC sent to the placeholder fund address is gone, because nobody controls it.

1. In the repository root, run `npm install`.
2. Check everything without funds and without sending anything:

   ```
   SIMULATE=1 RPC_URL=https://sepolia.base.org node examples/live-base-sepolia/index.ts
   ```

   This signs a purchase and its share with a throwaway key and runs both transfers against the deployed USDC contract with `eth_call`. It needs no funds and sends nothing.
3. Make a throwaway key for the testnet, in the repository root:

   ```
   node -e 'import("viem/accounts").then(({ generatePrivateKey, privateKeyToAccount }) => { const k = generatePrivateKey(); console.log("PRIVATE_KEY=" + k); console.log("address: " + privateKeyToAccount(k).address); })'
   ```

   Keep the key out of the repository and never send it anything of real value.
4. Request test USDC for that address on Base Sepolia from Circle's public testnet faucet (faucet.circle.com). Check its current limits and terms there. You need at least 1.001 test USDC.
5. Run once with `DRY_RUN=1`, which signs both payments and stops:

   ```
   PRIVATE_KEY=0x... RPC_URL=https://sepolia.base.org DRY_RUN=1 node examples/live-base-sepolia/index.ts
   ```

6. Only if you choose to broadcast: settle both through a facilitator that lists `exact` on `eip155:84532`, which pays the gas, so the key needs no ETH:

   ```
   PRIVATE_KEY=0x... RPC_URL=https://sepolia.base.org FACILITATOR_URL=https://x402.org/facilitator node examples/live-base-sepolia/index.ts
   ```

   This sends 1 test USDC from the key to itself (the purchase) and 0.001 test USDC to the placeholder address (the share). The 0.001 is lost.

Running this kit's own facilitator against Base Sepolia is a further step, also untested. Its signer key needs Base Sepolia ETH for gas, and the signer would be built from a viem wallet client roughly as below. That construction has not been checked against a live chain; verify it on your first testnet run.

```ts
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { toFacilitatorEvmSigner } from "@x402/evm";

const account = privateKeyToAccount(process.env.FACILITATOR_KEY as `0x${string}`);   // a testnet-only key
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(process.env.RPC_URL) }).extend(publicActions);
const signer = toFacilitatorEvmSigner({ ...wallet, address: account.address });
```

## License

Apache-2.0, the same as the repository.
