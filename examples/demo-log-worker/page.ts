/**
 * The index page at "/": plain HTML rendered on the server, inline CSS, no
 * scripts and no external fonts. It says what is real and what is simulated
 * before anything else.
 */

import type { CycleView, Snapshot, StatementView } from "./engine.ts";
import { DEFAULT_FACILITATOR, usdc } from "./engine.ts";

const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const iso = (t: number | null | undefined): string => (t ? new Date(t * 1000).toISOString().replace(".000Z", "Z").replace("T", " ") : "");
const short = (h: string): string => (h.length > 18 ? `${h.slice(0, 10)}...${h.slice(-6)}` : h);

function txLink(s: Snapshot, tx: string | null | undefined): string {
  if (!tx) return "";
  if (s.mode === "sim") return `<code title="${esc(tx)}">${esc(short(tx))}</code> <span class="muted">(simulated)</span>`;
  return `<a href="https://sepolia.basescan.org/tx/${esc(tx)}"><code>${esc(short(tx))}</code></a>`;
}

function cycleRow(s: Snapshot, c: CycleView): string {
  const sum = c.summary;
  let status: string;
  if (!sum) status = c.purchase ? "settling the share" : "settling the purchase";
  else if (sum.status === "skipped") status = `skipped: ${esc(sum.reason)}`;
  else if (sum.state === "collected") status = "collected";
  else if (sum.state === "uncollected") status = `uncollected${c.shareError ? `: ${esc(c.shareError)}` : ""}`;
  else status = esc(sum.state ?? sum.status);
  const purchase = c.purchase ? (c.purchase.ok ? txLink(s, c.purchase.transaction) : `failed: ${esc(c.purchase.error)}`) : "pending";
  return `<tr>
  <td>${c.n}</td>
  <td>${esc(iso(c.at))}</td>
  <td>${purchase}</td>
  <td><a href="/solidarity/proofs/${esc(c.share.id)}"><code>${esc(c.share.id)}</code></a></td>
  <td>${esc(usdc(c.share.amount))}</td>
  <td>${status}</td>
  <td>${txLink(s, sum?.transaction)}</td>
</tr>`;
}

function statementBlock(s: Snapshot, st: StatementView): string {
  const totals = st.totals.length ? st.totals.map((t) => `${t.lines} lines, ${esc(usdc(t.amount))} USDC to <code>${esc(t.fund)}</code>`).join("; ") : "no lines (an empty month still gets a statement)";
  const chain = s.mode === "sim" ? "the repository's simulated chain" : "Base Sepolia";
  let fund: string;
  if (st.fund) fund = `the demo fund cosigned it: it read every listed transaction on ${chain} and found each transfer to the fund address.`;
  else if (st.fundRefused?.definitive) fund = `<strong>the demo fund did not cosign it.</strong> It checked the listed transactions and refused: ${esc(st.fundRefused.reason)}`;
  else if (st.fundRefused) fund = `<strong>the demo fund did not cosign it.</strong> ${esc(st.fundRefused.reason)}.`;
  else fund = s.mode === "sim" ? "the demo fund has not cosigned it yet (it waits for 12 confirmations on the simulated chain)." : "the demo fund has not cosigned it yet (it waits for 12 confirmations and a readable RPC endpoint).";
  return `<h3>${esc(st.period)}</h3>
<dl>
  <dt>Lines</dt><dd>${st.size}</dd>
  <dt>Totals</dt><dd>${totals}</dd>
  <dt>Root</dt><dd><code>${esc(st.root)}</code></dd>
  <dt>Issued</dt><dd>${esc(iso(st.issuedAt))}</dd>
  <dt>Previous</dt><dd>${st.previous ? `<code>${esc(st.previous)}</code>` : "none: this is the log's first month"}</dd>
  <dt>Witness</dt><dd>${st.witness ? "the demo witness cosigned it" : st.witnessRefused ? `<strong>the demo witness refused it:</strong> ${esc(st.witnessRefused)}. The statement stays as it is; a verifier that requires the witness rejects it and its receipts, and the log goes on.` : "not yet cosigned by the demo witness"}</dd>
  <dt>Fund</dt><dd>${fund}</dd>
</dl>
<p><a href="/solidarity/statements/${esc(st.period)}">statement</a> · <a href="/solidarity/lines/${esc(st.period)}">lines</a> · <a href="/solidarity/settlements/${esc(st.period)}">settlements</a></p>`;
}

export function renderPage(s: Snapshot): string {
  const sim = s.mode === "sim";
  let state: string;
  if (s.state === "degraded") state = `<p class="warn"><strong>Stopped.</strong> The log found a problem in its own records or settings and serves nothing until its operator looks: ${esc(s.degraded)}</p>`;
  else if (s.state === "retired") state = `<p><strong>Retired.</strong> No purchases started after ${esc(s.endDate)}, and the log has retired: its statement for ${esc(s.finalPeriod)} is its final one, its descriptor lists no current key, and it closes no more months. Everything it published is still served.</p>`;
  else if (s.state === "paused") state = `<p class="warn"><strong>Paused.</strong> No new purchases start. Recorded work (an unfinished purchase, a month close) still finishes.</p>`;
  else if (s.state === "ended") state = `<p><strong>Ended.</strong> No purchases start after ${esc(s.endDate)}. The log retires once its last month with a share is closed and cosigned.</p>`;
  else if (s.state === "waiting") state = `<p class="warn"><strong>No purchases.</strong> The last tick, at ${esc(iso(s.lastTick?.at))}, started no purchase: ${esc(s.waiting)}. Each tick, every 6 hours, checks again. Recorded work (an unfinished purchase, a month close) still finishes.</p>`;
  else state = `<p><strong>Running.</strong> A purchase every 6 hours until ${esc(s.endDate)}.</p>`;
  const latest = s.statements[0];
  const period = latest?.period ?? s.keyFrom ?? "2026-10";
  const exampleId = s.cycles[0]?.share.id ?? "<id>";
  const balance = s.balance ? `${esc(usdc(s.balance.units))} ${sim ? "simulated" : "test"} USDC (read ${esc(iso(s.balance.at))})` : "not read yet";
  const lastTick = s.lastTick ? `${esc(iso(s.lastTick.at))}${s.lastTick.stop ? `: no purchase (${esc(s.lastTick.stop)})` : s.lastTick.cycle ? `: purchase ${esc(s.lastTick.cycle)}` : ""}` : "none yet";
  const real = sim
    ? `<p class="warn"><strong>This copy runs in simulated mode.</strong> Nothing here touched any chain: the transactions below are on the repository's simulated chain, and their hashes exist nowhere else.</p>`
    : `<p>The purchases and shares below are real <strong>Base Sepolia</strong> transactions in test USDC, which has no value, settled through ${s.facilitator === DEFAULT_FACILITATOR ? `the public x402 facilitator at <code>${esc(s.facilitator)}</code>, which pays the gas` : `the x402 facilitator at <code>${esc(s.facilitator)}</code>`}. Every settlement reference (<code>exact:&lt;transaction&gt;</code>) can be opened on <a href="https://sepolia.basescan.org/">sepolia.basescan.org</a>.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Solidarity demo log</title>
<style>
:root { --bg: #fbfaf7; --fg: #1d1d1b; --muted: #6a6a64; --line: #deddd6; --accent: #1f5f8b; --warn: #8a4b00; --code: #f0efe9; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #e8e7e2; --muted: #a09f98; --line: #34332f; --accent: #7fb6e0; --warn: #f0b060; --code: #23221f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 60rem; margin: 0 auto; padding: 2rem 16px 4rem; }
h1 { font-size: 1.6rem; margin: 0 0 .5rem; } h2 { font-size: 1.2rem; margin-top: 2.2rem; border-top: 1px solid var(--line); padding-top: 1.2rem; } h3 { font-size: 1rem; margin-bottom: .3rem; }
a { color: var(--accent); } code, pre { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: .85em; background: var(--code); border-radius: 3px; }
code { padding: 0 .2em; overflow-wrap: anywhere; } pre { padding: .8rem; overflow-x: auto; }
.muted { color: var(--muted); } .warn { color: var(--warn); }
.table { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: .9rem; } th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; } th { color: var(--muted); font-weight: 600; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; margin: .4rem 0; } dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
ul { padding-left: 1.2rem; }
</style>
</head>
<body>
<main>
<h1>Solidarity demo log</h1>
<p>A working demo of a <em>solidarity log</em> from the draft 3 solidarity proposal for x402: an agent's owner gives a small, fixed share of what the agent spends to a fund, each share becomes a line in a public log, and each month the log publishes a signed statement that a witness and the fund cosign. It is a proposal, not part of x402, and not affiliated with or endorsed by anyone. It was written with AI assistance.</p>
${state}

<h2>What is real</h2>
${real}

<h2>What is simulated</h2>
<ul>
<li><strong>The fund.</strong> Shares go to the placeholder address <code>0x000000000000000000000000000000000000f00d</code>, which nobody controls. No fund exists; test USDC sent there is gone.</li>
<li><strong>The witness and the fund's cosignatures.</strong> Both are demo keys held by this Worker, next to the log's own key. They show the checks a witness and a fund make, not that anyone independent made them.</li>
<li><strong>The owner and the seller.</strong> Both are this Worker. Every 6 hours it buys 1 ${sim ? "simulated" : "test"} USDC from itself (the purchase goes from the payer to the payer) and gives a 0.1% share, 0.001 USDC, to the placeholder fund.</li>
</ul>

<h2>Status</h2>
<dl>
  <dt>Log</dt><dd><a href="/solidarity">${esc(s.log ?? `${s.origin}/solidarity`)}</a></dd>
  <dt>First month</dt><dd>${esc(s.keyFrom ?? "")}</dd>
  <dt>Payer</dt><dd>${s.payer ? (sim ? `<code>${esc(s.payer)}</code> (simulated)` : `<a href="https://sepolia.basescan.org/address/${esc(s.payer)}"><code>${esc(s.payer)}</code></a>`) : ""}</dd>
  <dt>Payer balance</dt><dd>${balance}</dd>
  <dt>Last tick</dt><dd>${lastTick}</dd>
  ${s.unfinished !== null ? `<dt>Unfinished</dt><dd>purchase ${s.unfinished} is still being settled; it resumes on the next tick or alarm</dd>` : ""}
  ${s.backoffUntil ? `<dt>Waiting</dt><dd>3 purchases in a row failed; the next one starts after ${esc(iso(s.backoffUntil))}</dd>` : ""}
  ${s.finalPeriod ? `<dt>Final statement</dt><dd>${esc(s.finalPeriod)}</dd>` : `<dt>Next close</dt><dd>${esc(iso(s.nextClose))} (the month before is closed on the first tick after it)</dd>`}
  <dt>Log key</dt><dd>Ed25519 <code>${esc(s.logKeyHex ?? "")}</code>, <code>${esc(s.kids?.log ?? "")}</code></dd>
</dl>

<h2>The log's endpoints</h2>
<ul>
<li><a href="/solidarity">/solidarity</a>: the descriptor (funds, accepted share kind, keys, witnesses)</li>
<li><a href="/solidarity/statements/${esc(period)}">/solidarity/statements/${esc(period)}</a>: the signed statement and its cosignatures</li>
<li><a href="/solidarity/lines/${esc(period)}">/solidarity/lines/${esc(period)}</a>: the month's lines</li>
<li><a href="/solidarity/settlements/${esc(period)}">/solidarity/settlements/${esc(period)}</a>: the settlements file</li>
<li><a href="/solidarity/proofs/${esc(exampleId)}">/solidarity/proofs/${esc(exampleId)}</a>: one share's inclusion proof (or queued, uncollected, 404)</li>
<li>did:web documents: <a href="/.well-known/did.json">the log</a>, <a href="/witness/did.json">the demo witness</a>, <a href="/fund/did.json">the demo fund's key</a></li>
<li><a href="/receipts/${esc(exampleId)}">/receipts/&lt;id&gt;</a>: a full receipt for an included share, ready for verify.py</li>
</ul>

<h2>Latest statement</h2>
${latest ? statementBlock(s, latest) : `<p>None yet. The first statement, for ${esc(s.keyFrom ?? "the first month")}, appears on the first tick after that month ends.</p>`}
${s.statements.slice(1, 6).map((st) => statementBlock(s, st)).join("\n")}

<h2>Recent purchases</h2>
${s.cycles.length ? `<div class="table"><table>
<thead><tr><th>#</th><th>Signed (UTC)</th><th>Purchase, 1 USDC</th><th>Share id</th><th>Share</th><th>Status</th><th>Share transfer</th></tr></thead>
<tbody>
${s.cycles.map((c) => cycleRow(s, c)).join("\n")}
</tbody></table></div>` : "<p>None yet.</p>"}

<h2>How to check a month</h2>
<p>Fetch <a href="https://craigmerry.com/solidarity-levy/verify.py">verify.py</a> and <a href="https://craigmerry.com/solidarity-levy/merkle.js">merkle.js</a> from craigmerry.com/solidarity-levy/. verify.py needs Python 3 (signatures are checked when the <code>cryptography</code> package is installed).</p>
<pre>L=${esc(s.log ?? `${s.origin}/solidarity`)}
P=${esc(period)}
curl -fsS $L/lines/$P -o lines.txt
curl -fsS $L/settlements/$P -o settlements.txt
curl -fsS $L/statements/$P -o s-$P.json
python3 verify.py --lines lines.txt --statement s-$P.json --settlements settlements.txt

# two months in a row chain by "previous"
python3 verify.py --chain s-2026-10.json s-2026-11.json

# one share: its receipt, with the log's Ed25519 public key
curl -fsS ${esc(s.origin)}/receipts/&lt;id&gt; -o receipt.json
python3 verify.py receipt.json --key ${esc(s.logKeyHex ?? "")}</pre>
<p>merkle.js recomputes the same root in a browser or Node (<code>buildBatch(lines)</code> gives root, size and totals; <code>verifyReceipt</code> checks a receipt). ${sim ? "" : "Each <code>exact:&lt;transaction&gt;</code> in a settlements file can be opened on sepolia.basescan.org: it is a USDC transfer of the listed amount to <code>0x...f00d</code>."}</p>

<p class="muted">Source: examples/demo-log-worker in the x402-solidarity repository. Apache-2.0.</p>
</main>
</body>
</html>
`;
}
