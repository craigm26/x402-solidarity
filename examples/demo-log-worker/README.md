# Solidarity demo log (Cloudflare Worker)

A solidarity log that runs on its own, as a Cloudflare Worker with one Durable Object. Every 6 hours it buys 1 test USDC from itself on Base Sepolia and hands the 0.001 USDC share to its log, which settles the share to a placeholder fund. Each month it publishes a signed statement over the month's lines, and a demo witness and a demo fund cosign it. It serves the log's five endpoints, did:web documents for its three keys, and a plain page at `/` that says what is going on.

Read this first:

- **A proposal.** The solidarity extension is a proposal for x402 (draft 2). It is not part of x402, and this demo is not affiliated with or endorsed by anyone.
- **Testnet only.** The purchases and shares are real Base Sepolia transactions in test USDC, which has no value, settled through the public x402 facilitator at `https://x402.org/facilitator` (it pays the gas). Every settlement reference can be checked on [sepolia.basescan.org](https://sepolia.basescan.org/).
- **No fund exists.** Shares go to the placeholder `0x000000000000000000000000000000000000f00d`, which nobody controls, so the test USDC sent there is gone.
- **Simulated roles.** The witness and the fund's cosignatures come from demo keys this Worker holds, next to the log's own key. The owner (the agent that pays) and the seller are both this Worker. The cosignatures show the checks a witness and a fund make, not that anyone independent made them.
- **Not deployed by this repository.** The commands to deploy are below, for the operator. What has run so far, two real cycles under `wrangler dev` among it, is listed under "What has run".
- **Written with AI assistance** (Claude Code).

## What it does

One Durable Object (`DemoLogObject`, named `log`) holds everything in its SQLite storage. Most of the code is in `engine.ts`, which has no Cloudflare imports, so the same engine runs in Node in the tests.

Every 6 hours (cron `0 */6 * * *`) a tick does two things, under one lock:

1. **Recorded work first**, even when paused or past `END_DATE`, since none of it signs a new authorization: finish an unfinished purchase, close any month that has ended, add missing cosignatures.
2. **One purchase**, if nothing stops it. It signs a 1 USDC `exact` purchase from the payer to itself (EIP-3009, valid for 300 seconds) and builds the share with the library's `buildShare` under the owner policy below: 0.001 USDC, `exact`, to `0x...f00d`, valid 300 seconds longer than the purchase. It records both, settles the purchase through `FACILITATOR_URL`, then calls `log.onSettled` and awaits `followUp`, exactly as `examples/live-base-sepolia/index.ts` does. The log settles the share through the same facilitator.

Owner policy: rate `0.001`, monthly cap 5 USDC, refunds `keep`, one fund, one log (this one). The descriptor lists one share kind: `exact` on `eip155:84532` for USDC, `minAmount` 1000, `maxTimeoutSeconds` 300.

**Monthly close.** The first tick after a month ends (normally 00:00 UTC on the 1st) closes it: `log.closePeriod`, then the demo witness cosigns (it checks the log's signature, that `previous` is the payload hash in its own stored cosignature for the month before, and that the published lines and settlements file reproduce root, size, totals and the settlements hash), then the demo fund. If the witness refuses, the refusal is recorded (`witness-refused`) and the log stops for good (degraded, below): the fund is not asked, and no later month is closed or cosigned, across restarts too. The fund reads every `exact:<transaction>` reference on Base Sepolia (receipt status success, exactly one USDC `Transfer` to the fund address of the listed amount, at least 12 confirmations) and cosigns only if every one checks out and none was listed in another month. If a check fails, the statement stays published with the witness's cosignature only, and the page says that the fund did not cosign and why. If the chain cannot be read until 14 days after the month ends, the fund gives up for that month and the page says so. The spec asks for a statement within 15 days after the month ends.

**Stop conditions**, checked in this order before anything is signed: the log is degraded (below); `PAUSED` is `"1"`; today is after `END_DATE` (default 2027-03-31, and a value that is not a real date stops it too); a purchase is unfinished; 3 purchases in a row failed (it waits 24 hours); `PAYER_KEY` is missing, malformed, not a valid secp256k1 key, or not the key of `PAYER_ADDRESS` and of the payer pinned when the log was created; the RPC endpoint is not on chain 84532; the payer holds less than 2 USDC. An RPC error (on the chain id, the balance or the block number) skips the tick. Only a purchase that was under way counts toward the 3 failures: a stop, an error before signing, or a transfer that is not readable yet (below) does not. While the last tick stopped for one of these reasons, the page's headline says "No purchases" and why, not "Running".

**Cost.** About 640 purchases until 2027-03-31. Each purchase pays the payer back, so the payer spends only the shares: about 0.64 test USDC of the 19.999 it holds. The facilitator pays the gas.

## Endpoints

| Path | What |
| --- | --- |
| `/` | The page: what is real and simulated, status, the latest statement, recent purchases with basescan links, how to check a month |
| `/solidarity` | The descriptor |
| `/solidarity/statements/<YYYY-MM>` | `{statement, cosignatures}` |
| `/solidarity/lines/<YYYY-MM>` | The month's lines |
| `/solidarity/settlements/<YYYY-MM>` | The settlements file |
| `/solidarity/proofs/<id>` | `included` with the audit path, `queued`, `uncollected`, or 404 for an id the log never accepted (a share accepted before a restart and still in flight answers `queued`) |
| `/.well-known/did.json` | `did:web:<host>`, the log's statement key |
| `/witness/did.json` | `did:web:<host>:witness`, the demo witness |
| `/fund/did.json` | `did:web:<host>:fund`, the demo fund's key |
| `/receipts/<id>` | A full version 2 receipt for an included share, ready for verify.py |
| `/status.json` | The data behind the page |

The five log endpoints are `SolidarityLog.handle` byte for byte (status, content type and body), with one addition: after a restart the unfinished tail purchase is not replayed until it is finished (below), so its share's proof is answered `queued` from the records (its share intent or result row) rather than 404. A closed month's lines and settlements are sent with `cache-control: public, max-age=86400, immutable`, the page and `/status.json` with `max-age=60`, everything else with `no-cache`. Nothing at Cloudflare's edge caches these responses (that would take Workers Caching, which this demo has not tried; the Cache API does not cache on a workers.dev host), so every request reaches the Durable Object. Everything is GET or HEAD; any other method gets 405. No route a visitor can reach starts a purchase, spends, or closes a month. With `MODE=sim` and an `ADMIN_TOKEN` secret, and only then, `POST /admin/tick?n=N` and `POST /admin/advance?seconds=S` move the simulated clock; they need the token as a bearer. Live mode has no admin route at all.

## Keys

| Key | Where it lives |
| --- | --- |
| Log, Ed25519, `did:web:<host>#log-1` | Generated once when the log is created, kept as a private JWK in the Durable Object's `keys` table |
| Demo witness, Ed25519, `did:web:<host>:witness#witness-1` | The same |
| Demo fund, ES256 (P-256), `did:web:<host>:fund#fund-1` | The same |
| Payer (`PAYER_KEY`) | A Worker secret. Read into memory only inside a purchase, never stored, logged or returned |

The three demo keys are not secrets in the usual sense (they protect test records), but this Durable Object is their only holder. Deleting the Worker, renaming the class or adding a `deleted_classes` migration destroys them and the log's records, and the log cannot continue: a new log would start again with new keys.

The three did:web documents are on the log's own host, so they show the shape, not independence. The library's default check accepts any did:web key on the log's host as the log's key (`kidOnLogHost`), so a verifier should pass the descriptor, or resolve `did:web:<host>` itself, rather than rely on the host alone.

## Records and replay

Every step is a row in an append-only `events` table, written before the step has any effect outside the Durable Object: `genesis`, `cycle` (the signed purchase and share, written before any network call), `intent` (a share is about to be submitted), `result`, `lookup`, `settled`, `cycle-end`, `close-intent`, `close` (the signed statement), `cosign`, `fund-check`, `fund-refused`, `witness-refused`. A second row with the same kind and key throws.

When the Durable Object wakes, the log is rebuilt by replaying the rows in order. Replay never submits, settles or signs anything:

- The log's chain is `JournalChain` (`journal.ts`), which answers `submitExact` and `findExactTransfer` from the recorded rows. It has no `verifyExact`, so the log checks the share's signature offline, as it did live.
- Every clock reading comes from the record: `onSettled` runs at the time the `settled` row was written, and a month is closed at its `close-intent` time with its recorded `issuedAt`.
- Statements and cosignatures are re-added from storage, never signed again: `closePeriod(period, issuedAt, {signed})` rebuilds the payload and checks that the stored JWS is the log key's signature over exactly those bytes. A stored cosignature is re-added only if its kid is the demo witness's or the demo fund's key for its role, its JWS signs exactly the stored statement's payload and verifies with that key, and its recorded payload hash is the statement's. So published files are byte-identical across restarts, the randomized ES256 fund signatures included, and no private key is read during replay.
- Each replayed decision is compared with the recorded `cycle-end`. Any difference, a stored statement or cosignature that does not check, a recorded witness refusal, or a `PUBLIC_ORIGIN` or `MODE` other than the one pinned at creation, leaves the log **degraded**: no purchases, closes or cosignatures, 503 on the log's endpoints, and the reason on the page. Nothing is rewritten; recovery is the operator's call.

Replay takes about 4.5 ms per purchase in Node on a Raspberry Pi 5 (measured by the tests), so about 3 seconds for the whole run, inside the 30-second limit of `blockConcurrencyWhile`.

## Crash safety

A network call that can move value always comes after a durable `intent` (or `cycle`) row and `storage.sync()`. A failed answer from the facilitator is never taken as final: the chain decides, once the authorization is used (USDC `authorizationState`) or has been expired for 30 seconds. When the chain says used, only the transfer itself is recorded: if the log search does not show it yet (a public RPC endpoint can answer `authorizationState` from a node whose log index is behind), nothing is recorded, the purchase stays unfinished, and the alarm (15 minutes later) or the next tick looks again. An authorization is sent again only when the chain shows it unused, at least 60 seconds after the last try, with at least 60 seconds left; an EIP-3009 nonce can execute once, so nothing is ever paid twice. Lookups search only the blocks from the one recorded before signing to a little past `validBefore`, in 200-block requests. While a purchase or share is in flight a Durable Object alarm is set for 30 seconds after its `validBefore`; the alarm only finishes recorded work.

`test/crash.test.ts` kills the object between each pair of steps (before the purchase is sent; after it ran but before its answer arrived; after `settled`; after the share's intent; after the share ran; before `cycle-end`; between the close intent and the statement; before each cosignature, including a restart after the next month ended; a failed storage write), runs a share that executed while the facilitator answered 502 and the log search lagged twice, and checks that the new instance rebuilds with no chain call and no private key, that no authorization runs twice, that a share whose transfer ran is never left out, and that a re-signed statement is byte for byte the one that was lost.

## Tests

The offline tests run with the repository's `npm test` (no network, no wrangler). They run the engine in Node over memory and the repository's simulated chain, with a simulated clock:

- 160 purchases from 2026-10-23 to 2026-12-02: every share collected; October and November closed and cosigned; statements, the chain and every receipt verified by the library; settlements match totals; the fund address received exactly the totals.
- A restart: every published body identical byte for byte, no chain call and no private-key read during replay (a chain double that throws, and keys that throw when read); then the log carries on and closes December.
- With `SOLIDARITY_SITE_DIR` set (see the repository README): the site's verify.py accepts the lines, settlements, statements, the chain of months and receipts, and merkle.js reproduces the roots and verifies receipts.
- The fund refusing a tampered transfer; an RPC endpoint that is down (deferred, then given up after 14 days); each stop condition, including a `PAYER_KEY` that is not a secp256k1 key and an RPC error on the block number; the demo witness refusing a month (no fund cosignature, kept across a restart, no later close) and keeping its memory in its own stored cosignatures; tampered statements, decisions and cosignatures; an RPC error whose text holds a credential URL (only a short reason is published); the routes and their cache headers; the `(kind, seq)` index in node:sqlite; the crash points above; and the fund's receipt parser against the recorded receipt of the 2026-10-22 share transaction (`test/fixtures/`).

## What has run

- **The offline tests** (above), in Node 24 on a Raspberry Pi 5.
- **`wrangler dev` 4.152.0, simulated mode**, on 2026-10-23: one cron tick through `/__scheduled`, then 40 simulated days through `/admin/tick`. All 41 purchases collected their shares; October and November closed inside workerd with both cosignatures; the site's verify.py accepted both months, the chain and a receipt, and merkle.js reproduced both roots and verified the receipt. After wrangler was stopped and started again on the same storage, all 93 published bodies (every endpoint, every proof and receipt, the did:web documents and the page) were byte for byte the same.
- **`wrangler dev` 4.152.0, live mode**, on 2026-10-23 (UTC): two real cycles on Base Sepolia through `https://x402.org/facilitator`, with the throwaway payer `0x425c543799fe6452BfCfc3197ccD249b4989ad0B`:

  | Cycle | Purchase, 1 test USDC to the payer itself | Share, 0.001 test USDC to `0x...f00d` |
  | --- | --- | --- |
  | 1 | [0xe9c2d7c9...28a7b7](https://sepolia.basescan.org/tx/0xe9c2d7c955fd7455155979a7fc714a4f660b4199f0211fc12a44f6cc5e28a7b7) | [0x9ee685b4...7a383e](https://sepolia.basescan.org/tx/0x9ee685b412de6b1f48edc3866f855c9bd25a425db4d3ba1b235355b2d27a383e) |
  | 2 | [0xdf289ef1...733563](https://sepolia.basescan.org/tx/0xdf289ef1475c82f689b7656511dd6622c03da4b9233d5de839d75110a6733563) | [0x7c71c89d...3190a8](https://sepolia.basescan.org/tx/0x7c71c89db7ffd6cd8d1c4eb1713267d33cb5b8baf5639e682f182fded63190a8) |

  Each share's receipt shows one USDC `Transfer` of 1000 units to `0x...f00d`. A restart between the two cycles left every published body the same. October was not closed: it has not ended. Instead a copy of that dev log's storage was replayed in Node, outside the Worker (no chain call and no key read during the replay), and October was closed in the copy under a clock set to 2026-11-01: both lines and both `exact:` references matched the transactions above, and the demo fund cosigned after reading both receipts on Base Sepolia. These two shares live only in that local dev log, whose origin is the placeholder `https://dev.solidarity-demo-log.invalid`; it was never published.
- **Changes after review**, on 2026-10-23 (UTC): the fixes for a transfer not yet readable, the witness refusal, stored cosignature checks, a queued proof after a restart, stop conditions, published error text, the page's wording and headline, the index and the cache headers. They were checked by the offline tests above and under `wrangler dev` 4.152.0 in simulated mode (41 ticks, October and November closed with both cosignatures, then a restart on the same storage with all 53 published bodies byte for byte the same), not on Base Sepolia: the two real cycles ran on the code before them.
- **Not run:** `wrangler deploy` and `wrangler secret put`; the cron and the alarm firing on their own in Cloudflare; a real month close; the free and paid plan limits on subrequests and CPU time in production.

## Run it locally

Run `npm install` at the repository root first. Both modes need a `.dev.vars` file next to `wrangler.jsonc`. It is in `.gitignore`; check with `git check-ignore -q .dev.vars` before writing it, and delete it when you are done. `PUBLIC_ORIGIN` must be an https origin because a statement's `log` must be an https URL; any placeholder works locally.

**Simulated** (no chain, no spending):

```
MODE=sim
PUBLIC_ORIGIN=https://dev.solidarity-demo-log.invalid
ADMIN_TOKEN=<any random string>
SIM_TICK_SECONDS=86400
```

```
npx wrangler@4.152.0 dev --port 8850 --test-scheduled --persist-to <a folder>
curl "http://127.0.0.1:8850/__scheduled?cron=0+*/6+*+*+*"
curl -X POST -H "authorization: Bearer <token>" "http://127.0.0.1:8850/admin/tick?n=40"
```

**Live** (real Base Sepolia transactions in test USDC): `MODE=live`, the same `PUBLIC_ORIGIN`, and `PAYER_KEY=0x...` for the key of `PAYER_ADDRESS`, with no `ADMIN_TOKEN`. `wrangler dev` does not fire the cron by itself; each `curl .../__scheduled` runs one tick, and `/__scheduled` exists only under `wrangler dev --test-scheduled`. A month that has not ended cannot be closed.

## Deploy (for the operator)

Not run by this repository.

- **Workers Paid.** On Workers Free each invocation gets 10 ms of CPU time and 50 external subrequests. Replaying the log when the Durable Object wakes takes seconds by the end of the run (about 3.8 to 4.5 ms per purchase in the tests, about 640 purchases), and a month-close tick reads up to 30 receipts on top of a cycle's reads and settles, so on Free the log would stop working (safely: nothing is spent twice, but nothing runs). Workers Paid allows 30 seconds of CPU per request by default and 15 minutes per cron invocation on a 6-hour schedule.
- **Set `PUBLIC_ORIGIN` first.** It is `https://solidarity-demo-log.craigm26.workers.dev` in `wrangler.jsonc`. If the account's workers.dev subdomain differs, change it to the URL the deploy will have before the first deploy: the first request or tick pins it in the log's genesis, and a different value later leaves the log degraded for good. The only reset is deleting the Durable Object class, which destroys the log (Keys, above).
- **`RPC_URL` must not carry a credential.** It is a plain variable, visible in the dashboard. Error texts are published only as a short reason with any URL removed, but a provider key belongs in a secret and a Worker that reads it from there, which this demo does not have.

From the repository root, then this folder (the bundle takes viem from the root `node_modules`; wrangler 4.152.0 is the version that ran here):

```
npm install
cd examples/demo-log-worker
npx wrangler@4.152.0 deploy
npx wrangler@4.152.0 secret put PAYER_KEY
```

- The log is created on the first request or tick after the deploy; its first month is that month. Without `PAYER_KEY` it creates itself and serves, but every tick stops before signing and the page's headline says "No purchases" with the reason, "PAYER_KEY is not set". The secret takes effect on the next tick.
- To pause: set `PAUSED` to `"1"` in `wrangler.jsonc` and deploy again. A purchase already signed still finishes, which can submit its share (at most 0.001 test USDC).
- Never set `ADMIN_TOKEN` or `MODE=sim` in production; the log refuses to switch modes on stored records anyway.
- Never rename `DemoLogObject` or delete it in a migration. It is safe to delete the Worker once the 2027-03 statement carries both cosignatures, but that ends the log: its URL stops answering and nothing marks the end.

## Limits

- The witness, the fund and the log are one Worker with three keys. Their cosignatures prove the checks were made, not that anyone independent made them.
- Base Sepolia reorgs deeper than 12 blocks after the fund cosigns would make a cosigned statement wrong. Not mitigated further on a testnet.
- If a share's transfer is mined after the log has recorded it uncollected (for example, the facilitator answered with an error and the transaction landed late), the fund receives the test USDC but the month has no line for it. Waiting for the authorization to expire before deciding makes this unlikely, not impossible.
- Lookups assume about 2-second blocks (with a 1.5x margin). A large change in block time could put a transaction outside the searched blocks. A used authorization whose transfer is outside them is never recorded uncollected: its purchase stays unfinished, retried every 15 minutes, and the log starts no purchase and closes no month until the operator looks.
- The public RPC endpoint and facilitator can rate-limit, change, or stop sponsoring gas. Failures are safe (the chain decides), but they stop the demo.
- After `END_DATE` the log keeps closing empty months while it exists. The spec has no way for a log to retire.
- Lines and settlement transactions link to the payer's address on chain. The payer is a throwaway key.

## What draft 3 of the spec could settle

Found while building this:

1. A log has no way to retire, or to publish a final statement.
2. No rule covers an `exact` share whose transfer executes after the log declared it uncollected.
3. A witness must keep the last hash it cosigned across restarts; a stateless witness skips the `previous` check.
4. Log key authorization by host prefix lets any `did:web:<host>:<path>` key pass as the log's key. Requiring the root document (`did:web:<host>`) would close that.
5. A log should record a statement payload durably before publishing it, so a restart cannot issue a different payload for the same month, with `issuedAt` fixed at that first write.
6. Whether a log may process a share for a purchase whose settle response was lost but which the chain shows as settled (this demo does, while the share is still valid).
7. A fund's memory of the references it has attested has no bound, and must persist across every log that pays it.
8. What a log does when a witness refuses its statement. The spec says only what a witness checks before cosigning; this demo stops the log for good and leaves recovery to its operator.
