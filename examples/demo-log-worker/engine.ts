/**
 * The demo log's engine: a SolidarityLog that buys from itself every six
 * hours on Base Sepolia, records every step, closes each month with a
 * statement, and has a demo witness and a demo fund cosign it.
 *
 * What is real and what is not:
 * - Real: the Base Sepolia transactions (test USDC, which has no value),
 *   settled through an x402 facilitator.
 * - Simulated: the fund is the placeholder 0x...f00d, which nobody controls;
 *   the witness and the fund's key are demo keys this engine holds; the
 *   owner (the agent paying) and the seller are both this engine.
 *
 * It has no Cloudflare imports. worker.ts runs it in a Durable Object with
 * SqlStore and LiveIO (or SimIO), and the tests run it in Node with
 * MemoryStore and SimIO.
 *
 * Replay: on boot the log is rebuilt from the recorded events, with
 * JournalChain answering from the records, the recorded clock readings, and
 * the stored statements and cosignatures re-added instead of signed again.
 * Boot makes no network call and reads no private key.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as S from "../../src/solidarity/index.ts";
import type { ExactEip3009Payload, JwsEnvelope, LogDescriptor, OwnerPolicy, PaymentPayload, PaymentRequirements, SigningKey, SolidarityInfo, SolidarityOutcome } from "../../src/solidarity/index.ts";
import type { JwsAlg } from "../../src/solidarity/ledger.ts";
import { nextPeriod, periodOf, periodStart, previousPeriod, sameAccount } from "../../src/solidarity/utils.ts";
import type { DidRole } from "./did.ts";
import { didDocument, didOf, kidOf } from "./did.ts";
import type { FundCheck } from "./fundView.ts";
import { exactRefs, fundCheckOf, fundViewFrom } from "./fundView.ts";
import type { ChainIO } from "./io.ts";
import type { Body, EventRow, JournalBackend, Kind, LookupAnswer, Store, SubmitAnswer } from "./journal.ts";
import { JournalChain, toJson } from "./journal.ts";

export const NETWORK = S.USDC_BASE_SEPOLIA.network;
export const CHAIN_ID = S.USDC_BASE_SEPOLIA.chainId;
export const USDC_ADDRESS = S.USDC_BASE_SEPOLIA.address;
export const ASSET = USDC_ADDRESS.toLowerCase();
export const FUND_ADDRESS = "0x000000000000000000000000000000000000f00d";
export const FUND = `${NETWORK}:${FUND_ADDRESS}`;
export const PURCHASE_AMOUNT = "1000000"; // 1 USDC
export const RATE = "0.001";
export const CAP = "5000000"; // 5 USDC a month
export const MIN_BALANCE = 2_000_000n; // stop below 2 USDC
export const WINDOW_SECONDS = 300; // purchase validity, and the descriptor's maxTimeoutSeconds
export const FINAL_AFTER = 30; // an unused authorization is final this long after validBefore
export const RESUBMIT_GAP = 60;
export const MIN_VALIDITY = 60;
export const MAX_ATTEMPTS = 3;
export const FAILURES_BEFORE_BACKOFF = 3;
export const BACKOFF_SECONDS = 86400;
export const FUND_CONFIRMATIONS = 12n;
export const FUND_DEADLINE_SECONDS = 14 * 86400;
export const RECEIPTS_PER_RUN = 30;
export const SIM_FAUCET = 20_000_000n;
export const DEFAULT_FACILITATOR = "https://x402.org/facilitator";
export const DEFAULT_RPC = "https://sepolia.base.org";
export const DEFAULT_END_DATE = "2027-03-31";

export type Mode = "live" | "sim";

export interface EngineConfig {
  mode: Mode;
  /** PUBLIC_ORIGIN, no trailing slash. The log is <origin>/solidarity. */
  origin: string;
  /** Live: PAYER_ADDRESS, the address PAYER_KEY must belong to. */
  payerAddress?: string;
  paused: boolean;
  /** YYYY-MM-DD: no cycle starts after this day (UTC). */
  endDate: string;
  facilitatorUrl: string;
  rpcUrl: string;
  /** A problem with the variables themselves; the engine stays degraded while it is set. */
  problem?: string;
}

export function configFromEnv(env: Record<string, string | undefined>): EngineConfig {
  const mode = env.MODE === undefined || env.MODE === "" ? "live" : env.MODE;
  const origin = (env.PUBLIC_ORIGIN ?? "").replace(/\/+$/, "");
  let problem: string | undefined;
  if (mode !== "live" && mode !== "sim") problem = `MODE must be "live" or "sim", not "${mode}"`;
  else if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(origin)) problem = "PUBLIC_ORIGIN must be an https origin (the log URL must be https)";
  else if (mode === "live" && !/^0x[0-9a-fA-F]{40}$/.test(env.PAYER_ADDRESS ?? "")) problem = "PAYER_ADDRESS must be set to the payer's address";
  return {
    mode: mode === "sim" ? "sim" : "live",
    origin,
    payerAddress: env.PAYER_ADDRESS,
    paused: env.PAUSED === "1",
    endDate: env.END_DATE || DEFAULT_END_DATE,
    facilitatorUrl: env.FACILITATOR_URL || DEFAULT_FACILITATOR,
    rpcUrl: env.RPC_URL || DEFAULT_RPC,
    problem,
  };
}

/** The first second after END_DATE (UTC), or undefined if it is not a real YYYY-MM-DD date. */
export function endBoundary(endDate: string): number | undefined {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(endDate);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return undefined;
  return t / 1000 + 86400;
}

export interface EngineDeps {
  store: Store;
  io: ChainIO;
  config: EngineConfig;
  /** Live: the PAYER_KEY secret. Read only inside a cycle, never stored. */
  payerKey?: () => string | undefined;
  /** Arm the Durable Object alarm for this unix time, if it is earlier than the one set (live only). */
  setAlarm?: (at: number) => void | Promise<void>;
  /** Tests: wrap each signing key, for example to count private-key reads. */
  wrapKey?: (key: SigningKey, name: string) => SigningKey;
}

export interface Genesis {
  schema: 1;
  mode: Mode;
  origin: string;
  log: string;
  keyFrom: string;
  payer: string;
  fund: string;
  network: string;
  asset: string;
  policySince: string;
  kids: Record<DidRole, string>;
}

/** What the log decided for a cycle's share: stored in cycle-end and compared on every replay. */
export interface Summary {
  status: string | null;
  reason: string | null;
  period: string | null;
  amount: string | null;
  state: string | null;
  transaction: string | null;
}

export interface CycleReport {
  ran: boolean;
  stop?: string;
  n?: number;
  cycle?: string;
  summary?: Summary;
}

export interface TickReport {
  at: number;
  maintained: string[];
  cycle?: CycleReport;
  stop?: string;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Atomic units of USDC (6 decimals) as a decimal string: 1500000 gives "1.5". */
export function usdc(units: bigint | string): string {
  const v = BigInt(units);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / 1_000_000n}${frac ? `.${frac}` : ""}`;
}

function summarize(outcome: SolidarityOutcome | undefined, rec: { state?: string; exact?: { transaction?: string } } | undefined): Summary {
  return {
    status: outcome?.status ?? null,
    reason: outcome?.reason ?? null,
    period: outcome?.period ?? null,
    amount: outcome?.amount ?? null,
    state: rec?.state ?? null,
    transaction: rec?.exact?.transaction ?? null,
  };
}

export class Engine {
  readonly store: Store;
  readonly io: ChainIO;
  readonly config: EngineConfig;
  private readonly deps: EngineDeps;

  degraded: string | undefined;
  genesis: Genesis | undefined;
  log: S.SolidarityLog | undefined;
  descriptor: LogDescriptor | undefined;
  policy: OwnerPolicy | undefined;
  counter: S.CapCounter | undefined;
  journal: JournalChain | undefined;
  keys: Record<DidRole, SigningKey> | undefined;

  /** The newest clock reading recorded: the log clock never runs backwards. */
  private lastAt = 0;
  /** What the log's clock returns right now: a recorded reading, set for each step. */
  private logNow = 0;
  private cycles = 0;
  /** The cycle row without a cycle-end, if any. There is at most one. */
  private unfinished: EventRow | undefined;
  /** The cycle being run (live), for the journal's write-ahead rows. */
  private current: EventRow | undefined;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.io = deps.io;
    this.config = deps.config;
  }

  // ---- boot and replay ----------------------------------------------------------------

  /** Load or create genesis and keys, then replay every event. Never throws: a problem leaves the engine degraded. */
  async boot(): Promise<void> {
    this.degraded = undefined;
    try {
      await this.rebuild();
    } catch (e) {
      this.degraded = `the log could not be rebuilt from its records: ${msg(e)}`;
    }
  }

  private async rebuild(): Promise<void> {
    this.log = undefined;
    this.lastAt = 0;
    this.logNow = 0;
    this.cycles = 0;
    this.unfinished = undefined;
    this.current = undefined;
    if (this.config.problem) {
      this.degraded = this.config.problem;
      return;
    }
    const g = (this.store.get("genesis", "genesis") ?? (await this.createGenesis())).body as Genesis;
    this.genesis = g;
    if (g.origin !== this.config.origin) {
      this.degraded = `PUBLIC_ORIGIN is ${this.config.origin}, but this log was created at ${g.origin}; it never changes its URL`;
      return;
    }
    if (g.mode !== this.config.mode) {
      this.degraded = `MODE is ${this.config.mode}, but this log was created in ${g.mode} mode; simulated and real records never mix`;
      return;
    }
    this.keys = {
      log: this.loadKey("log", "EdDSA", g.kids.log),
      witness: this.loadKey("witness", "EdDSA", g.kids.witness),
      fund: this.loadKey("fund", "ES256", g.kids.fund),
    };
    this.descriptor = {
      version: 2,
      log: g.log,
      funds: [FUND],
      accepts: [{ network: NETWORK, asset: ASSET, scheme: "exact", maxTimeoutSeconds: WINDOW_SECONDS, minAmount: "1000", extra: { name: "USDC", version: "2" } }],
      keys: [{ kid: g.kids.log, from: g.keyFrom, until: null, jwk: S.publicJwk(this.keys.log.publicKey) }],
      witnesses: [didOf(g.origin, "witness")],
    };
    this.policy = { version: 2, rate: RATE, cap: { amount: CAP, asset: ASSET }, fund: FUND, logs: [g.log], refunds: "keep", since: g.policySince };
    this.counter = new S.CapCounter(this.policy);
    this.journal = new JournalChain(this.backend());
    this.log = new S.SolidarityLog({ descriptor: this.descriptor, key: this.keys.log, chain: this.journal, clock: () => this.logNow });

    const problems: string[] = [];
    const replayed = new Map<string, Summary>();
    for (const e of this.store.events()) {
      if (e.at > this.lastAt) this.lastAt = e.at;
      this.logNow = e.at;
      switch (e.kind) {
        case "cycle": {
          if (this.unfinished) problems.push(`cycle ${e.body.n} started while cycle ${this.unfinished.body.n} was unfinished`);
          const s = e.body.share;
          this.counter.commit({ id: s.id, amount: BigInt(s.amount), period: s.period, kind: "exact", validBefore: s.validBefore });
          this.unfinished = e;
          this.cycles = e.body.n;
          break;
        }
        case "settled": {
          // A settled cycle without its cycle-end is the tail: maintain() finishes it live.
          if (!this.store.get("cycle-end", e.key)) break;
          replayed.set(e.key, await this.applySettled(this.store.get("cycle", e.key) as EventRow, e));
          break;
        }
        case "cycle-end": {
          const got = replayed.get(e.key);
          if (!got || toJson(got) !== toJson(e.body.summary)) problems.push(`cycle ${e.key}: replay decided ${toJson(got ?? null)}, the record says ${toJson(e.body.summary)}`);
          if (this.unfinished?.key === e.key) this.unfinished = undefined;
          break;
        }
        case "close": {
          const pub = await this.log.closePeriod(e.body.period, e.body.issuedAt, { signed: { format: "jws", signature: e.body.jws } });
          if (S.statementHash(S.decodeStatement(pub.statement).payload) !== e.body.hash) problems.push(`statement ${e.body.period}: hash differs from the record`);
          break;
        }
        case "cosign":
          this.log.addCosignature(e.body.period, { format: "jws", signature: e.body.jws });
          break;
        default:
          break; // genesis, intent, result, lookup, close-intent, fund-check, fund-refused: read by key when needed
      }
    }
    problems.push(...this.journal.divergence);
    if (problems.length) throw new Error(problems.join("; "));
    this.journal.mode = "live";
  }

  private async createGenesis(): Promise<EventRow> {
    const now = this.io.now();
    const origin = this.config.origin;
    let payer: string;
    if (this.config.mode === "sim") {
      const hex = generatePrivateKey();
      payer = privateKeyToAccount(hex).address;
      this.store.putKey({ name: "sim-payer", alg: "secp256k1", kid: payer, jwk: JSON.stringify({ hex }), created: now });
    } else {
      payer = this.config.payerAddress as string;
    }
    const kids: Record<DidRole, string> = { log: kidOf(origin, "log"), witness: kidOf(origin, "witness"), fund: kidOf(origin, "fund") };
    this.loadKey("log", "EdDSA", kids.log, true);
    this.loadKey("witness", "EdDSA", kids.witness, true);
    this.loadKey("fund", "ES256", kids.fund, true);
    const g: Genesis = {
      schema: 1,
      mode: this.config.mode,
      origin,
      log: `${origin}/solidarity`,
      keyFrom: periodOf(now),
      payer,
      fund: FUND,
      network: NETWORK,
      asset: ASSET,
      policySince: new Date(now * 1000).toISOString(),
      kids,
    };
    const row = this.store.append("genesis", "genesis", now, g);
    await this.store.sync();
    // Simulated test tokens for the simulated payer. Nothing real.
    if (this.config.mode === "sim") await this.io.faucet?.(payer, SIM_FAUCET);
    return row;
  }

  /** A signing key from the keys table, created once (at genesis) if asked. */
  private loadKey(name: string, alg: JwsAlg, kid: string, create = false): SigningKey {
    let row = this.store.getKey(name);
    if (!row) {
      if (!create) throw new Error(`the ${name} key is missing from storage`);
      const k = S.generateSigningKey(alg, kid);
      row = { name, alg, kid, jwk: JSON.stringify(k.privateKey.export({ format: "jwk" })), created: this.io.now() };
      this.store.putKey(row);
    }
    if (row.kid !== kid || row.alg !== alg) throw new Error(`the stored ${name} key is ${row.alg} ${row.kid}, not ${alg} ${kid}`);
    const privateKey = createPrivateKey({ key: JSON.parse(row.jwk), format: "jwk" });
    const key: SigningKey = { alg, kid, privateKey, publicKey: createPublicKey(privateKey) };
    return this.deps.wrapKey ? this.deps.wrapKey(key, name) : key;
  }

  private paymentPayload(c: EventRow): PaymentPayload {
    const b = c.body;
    return { x402Version: 2, accepted: b.purchase.requirements, payload: b.purchase.payload, extensions: { [S.SOLIDARITY]: { info: b.share.info, schema: S.solidaritySchema } } };
  }

  /** log.onSettled and its follow-up for one cycle, at the recorded clock reading. */
  private async applySettled(c: EventRow, settled: EventRow): Promise<Summary> {
    const log = this.log as S.SolidarityLog;
    this.logNow = settled.at;
    const r = await log.onSettled(this.paymentPayload(c), c.body.purchase.requirements, settled.body.settleResponse);
    await r.followUp;
    return summarize(r.outcome, log.inspect(c.body.share.id) as { state?: string; exact?: { transaction?: string } } | undefined);
  }

  // ---- recording -------------------------------------------------------------------------

  /** Real time, but never earlier than a reading already recorded. */
  private liveNow(): number {
    const t = this.io.now();
    return t > this.lastAt ? t : this.lastAt;
  }

  private append(kind: Kind, key: string, at: number, body: unknown): EventRow {
    const row = this.store.append(kind, key, at, body);
    if (at > this.lastAt) this.lastAt = at;
    return row;
  }

  private async armAlarm(at: number): Promise<void> {
    if (this.config.mode === "live") await this.deps.setAlarm?.(at);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  // ---- the chain, write-ahead ---------------------------------------------------------------

  private backend(): JournalBackend {
    return {
      recorded: (kind, nonce) => this.store.get(kind, `${kind === "result" ? "submit" : "lookup"}:${nonce}`)?.body,
      submitShare: (accepted, payload) => this.submitShare(accepted, payload),
      lookupShare: (accepted, payload) => this.lookupShare(accepted, payload),
    };
  }

  /** The blocks an authorization signed in cycle `c` can have executed in: from the block read before signing to well past validBefore. */
  private windowFor(c: EventRow, payload: ExactEip3009Payload): { fromBlock: bigint; toBlock: bigint } {
    const fromBlock = BigInt(c.body.block);
    const span = Math.max(0, Number(payload.authorization.validBefore) - c.at);
    return { fromBlock, toBlock: fromBlock + BigInt(Math.ceil((1.5 * span) / 2)) + 100n };
  }

  /**
   * Submit an authorization and wait for a final answer. A failed answer is
   * never taken as final: the chain decides, once the authorization is used
   * or expired. Resubmission happens only when the chain shows it unused, at
   * least RESUBMIT_GAP after the last try, with MIN_VALIDITY left; EIP-3009
   * nonces make a second execution impossible anyway.
   */
  private async execute(accepted: PaymentRequirements, payload: ExactEip3009Payload, o: { intentAt: number; fresh: boolean; cycle: EventRow }): Promise<SubmitAnswer> {
    const a = payload.authorization;
    const validBefore = Number(a.validBefore);
    let attempts = 0;
    let answered = false;
    let lastTry = o.fresh ? Number.NEGATIVE_INFINITY : o.intentAt;
    let lastError: string | undefined;
    let check = !o.fresh;
    for (;;) {
      if (check && (await this.io.authorizationState(a.from, a.nonce))) {
        const t = await this.io.findTransfer(accepted, payload, this.windowFor(o.cycle, payload));
        if (t && sameAccount(t.to, a.to) && t.value === BigInt(a.value)) return { ok: true, transaction: t.transaction, via: "chain" };
        return { ok: false, error: "the authorization was used, but its transfer was not found in the expected blocks", via: "chain" };
      }
      check = true;
      const now = this.io.now();
      if (now > validBefore + FINAL_AFTER) return { ok: false, error: lastError ?? "not executed before validBefore", via: "chain" };
      const canTry = !answered && attempts < MAX_ATTEMPTS && validBefore - now >= MIN_VALIDITY;
      if (canTry && now - lastTry >= RESUBMIT_GAP) {
        attempts++;
        lastTry = now;
        const r = await this.io.settle(accepted, payload);
        if (r.ok) return { ok: true, transaction: r.transaction, via: "facilitator" };
        lastError = r.error;
        if (!r.transport) answered = true;
        continue;
      }
      const next = Math.min(now + 30, validBefore + FINAL_AFTER + 1, canTry ? lastTry + RESUBMIT_GAP : Number.POSITIVE_INFINITY);
      await this.io.sleep(Math.max(1, next - now));
    }
  }

  private async submitShare(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<SubmitAnswer> {
    const c = this.current as EventRow;
    const nonce = payload.authorization.nonce.toLowerCase();
    let intent = this.store.get("intent", `submit:${nonce}`);
    let fresh = false;
    if (!intent) {
      if (Number(payload.authorization.validBefore) - this.io.now() < MIN_VALIDITY) {
        // Never sent: nobody but this engine ever held it, so there is nothing to wait for.
        const a: SubmitAnswer = { ok: false, error: "not submitted before validBefore", via: "engine" };
        this.append("result", `submit:${nonce}`, this.liveNow(), { ...a, role: "share", cycle: c.key });
        return a;
      }
      intent = this.append("intent", `submit:${nonce}`, this.liveNow(), { cycle: c.key, role: "share" });
      await this.store.sync();
      await this.armAlarm(Number(payload.authorization.validBefore) + FINAL_AFTER);
      fresh = true;
    }
    const a = await this.execute(accepted, payload, { intentAt: intent.at, fresh, cycle: c });
    this.append("result", `submit:${nonce}`, this.liveNow(), { ...a, role: "share", cycle: c.key });
    return a;
  }

  private async lookupShare(accepted: PaymentRequirements, payload: ExactEip3009Payload): Promise<LookupAnswer> {
    const c = this.current as EventRow;
    const nonce = payload.authorization.nonce.toLowerCase();
    const w = this.windowFor(c, payload);
    const t = await this.io.findTransfer(accepted, payload, w);
    const answer: LookupAnswer = {
      found: t ? { transaction: t.transaction, token: t.token, to: t.to, value: t.value.toString() } : null,
      window: { fromBlock: w.fromBlock.toString(), toBlock: w.toBlock.toString() },
    };
    this.append("lookup", `lookup:${nonce}`, this.liveNow(), answer);
    return answer;
  }

  // ---- ticks ----------------------------------------------------------------------------------

  /** The cron's work: finish recorded work, then one cycle if nothing stops it. */
  tick(): Promise<TickReport> {
    return this.exclusive(async () => {
      const report: TickReport = { at: this.io.now(), maintained: [] };
      if (this.degraded) {
        report.stop = `degraded: ${this.degraded}`;
        return report;
      }
      try {
        report.maintained = await this.maintainInner();
        report.cycle = await this.cycleInner();
        this.store.setStatus("lastTick", { at: report.at, stop: report.cycle.stop ?? null, cycle: report.cycle.n ?? null, notes: report.maintained });
        return report;
      } catch (e) {
        await this.afterError(e);
        throw e;
      }
    });
  }

  /** The alarm's work: only what is already recorded (resume, close, cosign). Never a new cycle. */
  maintain(): Promise<string[]> {
    return this.exclusive(async () => {
      if (this.degraded) return [];
      try {
        return await this.maintainInner();
      } catch (e) {
        await this.afterError(e);
        throw e;
      }
    });
  }

  /** One cycle now, for tests (the same checks as a tick's). */
  cycle(): Promise<CycleReport> {
    return this.exclusive(async () => {
      try {
        return await this.cycleInner();
      } catch (e) {
        await this.afterError(e);
        throw e;
      }
    });
  }

  private async afterError(e: unknown): Promise<void> {
    try {
      this.store.setStatus("lastError", { at: this.io.now(), error: msg(e) });
      this.bumpFailures(false);
    } catch {
      // the store itself failed; the rebuild below will say so
    }
    // In-memory state may now be ahead of the records (for example a share the log marked
    // uncollected because the journal failed): rebuild it from what is recorded.
    await this.boot();
    try {
      await this.armAlarm(this.io.now() + 900);
    } catch {
      // the next cron tick retries anyway
    }
  }

  private bumpFailures(ok: boolean): void {
    if (ok) {
      this.store.setStatus("failures", 0);
      return;
    }
    const n = Number(this.store.status("failures") ?? 0) + 1;
    if (n >= FAILURES_BEFORE_BACKOFF) {
      this.store.setStatus("failures", 0);
      this.store.setStatus("backoffUntil", this.io.now() + BACKOFF_SECONDS);
    } else this.store.setStatus("failures", n);
  }

  private async maintainInner(): Promise<string[]> {
    const notes: string[] = [];
    if (this.unfinished) {
      const n = this.unfinished.body.n;
      await this.runCycle(this.unfinished, false);
      notes.push(`finished cycle ${n}`);
    }
    notes.push(...(await this.closeDue()));
    notes.push(...(await this.cosignPending()));
    return notes;
  }

  /** Why no cycle may start now, or undefined. Checked before anything is signed. */
  async stopReason(): Promise<string | undefined> {
    if (this.degraded) return `degraded: ${this.degraded}`;
    if (this.config.paused) return "paused (PAUSED is 1)";
    const end = endBoundary(this.config.endDate);
    if (end === undefined) return `END_DATE ${this.config.endDate} is not a YYYY-MM-DD date`;
    if (this.io.now() >= end) return `ended: END_DATE ${this.config.endDate} has passed`;
    if (this.unfinished) return `cycle ${this.unfinished.body.n} is unfinished`;
    const until = Number(this.store.status("backoffUntil") ?? 0);
    if (this.io.now() < until) return `${FAILURES_BEFORE_BACKOFF} cycles failed in a row; waiting until ${new Date(until * 1000).toISOString()}`;
    const hex = this.payerHex();
    if (!hex) return this.config.mode === "live" ? "PAYER_KEY is not set" : "the simulated payer key is missing";
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return "PAYER_KEY must be 0x followed by 64 hex digits";
    const address = privateKeyToAccount(hex as `0x${string}`).address;
    if (!sameAccount(address, (this.genesis as Genesis).payer)) return "PAYER_KEY is not the key of the payer this log was created with";
    if (this.config.mode === "live" && !sameAccount(address, this.config.payerAddress)) return "PAYER_KEY is not the key of PAYER_ADDRESS";
    try {
      const id = await this.io.chainId();
      if (id !== CHAIN_ID) return `the RPC endpoint reports chain ${id}, not Base Sepolia (${CHAIN_ID})`;
      const balance = await this.io.balanceOf(address);
      this.store.setStatus("lastBalance", { at: this.io.now(), balance: balance.toString() });
      if (balance < MIN_BALANCE) return `the payer holds ${usdc(balance)} USDC, below 2 USDC`;
    } catch (e) {
      return `the RPC endpoint did not answer: ${msg(e)}`;
    }
    return undefined;
  }

  private payerHex(): string | undefined {
    if (this.config.mode === "sim") {
      const row = this.store.getKey("sim-payer");
      return row ? (JSON.parse(row.jwk) as { hex: string }).hex : undefined;
    }
    return this.deps.payerKey?.();
  }

  private async cycleInner(): Promise<CycleReport> {
    const stop = await this.stopReason();
    if (stop) return { ran: false, stop };
    const account = privateKeyToAccount(this.payerHex() as `0x${string}`);
    const log = this.log as S.SolidarityLog;
    const now = this.liveNow();
    const real = this.io.now();
    const block = await this.io.blockNumber();
    const balance = String(this.store.status("lastBalance")?.balance ?? "");
    // A 1 USDC exact purchase from the payer to itself, signed as any x402 client signs one.
    const purchase: PaymentRequirements = { scheme: "exact", network: NETWORK, amount: PURCHASE_AMOUNT, asset: USDC_ADDRESS, payTo: account.address, maxTimeoutSeconds: WINDOW_SECONDS, extra: { name: "USDC", version: "2" } };
    const window = { validAfter: String(real - 60), validBefore: String(real + WINDOW_SECONDS) };
    const purchasePayload = await S.signEip3009(account, purchase, window);
    // Its share, as the owner's agent builds it (the cap counts it when it is signed).
    const decision = await S.buildShare(
      { policy: this.policy as OwnerPolicy, counter: this.counter as S.CapCounter, signer: account, descriptor: this.descriptor as LogDescriptor, now },
      { declared: { version: 2, logs: [{ network: NETWORK, scheme: "exact", log: log.descriptor.log }] }, accepted: purchase, purchaseWindow: window },
    );
    if (!decision.attached) return { ran: false, stop: decision.why };
    const info = decision.info as SolidarityInfo;
    const sharePayload = (info.payment as NonNullable<SolidarityInfo["payment"]>).payload as unknown as ExactEip3009Payload;
    const n = this.cycles + 1;
    const row = this.append("cycle", purchasePayload.authorization.nonce.toLowerCase(), now, {
      n,
      block: block.toString(),
      balance,
      purchase: { requirements: purchase, payload: purchasePayload },
      share: { id: info.id, amount: decision.amount.toString(), period: decision.period, validBefore: Number(sharePayload.authorization.validBefore), info },
    });
    this.cycles = n;
    this.unfinished = row;
    await this.store.sync();
    await this.armAlarm(row.body.share.validBefore + FINAL_AFTER);
    const summary = await this.runCycle(row, true);
    return { ran: true, n, cycle: row.key, summary };
  }

  /** Settle the purchase (unless recorded), hand the share to the log, and record what it decided. */
  private async runCycle(c: EventRow, fresh: boolean): Promise<Summary> {
    this.current = c;
    const b = c.body;
    const purchaseNonce = b.purchase.payload.authorization.nonce.toLowerCase();
    let settled = this.store.get("settled", c.key);
    if (!settled) {
      let res = this.store.get("result", `submit:${purchaseNonce}`);
      if (!res) {
        const a = await this.execute(b.purchase.requirements, b.purchase.payload, { intentAt: c.at, fresh, cycle: c });
        res = this.append("result", `submit:${purchaseNonce}`, this.liveNow(), { ...a, role: "purchase", cycle: c.key });
      }
      const payer = b.purchase.payload.authorization.from;
      const sr = res.body.ok
        ? { success: true, transaction: res.body.transaction, network: NETWORK, payer }
        : { success: false, errorReason: res.body.error, transaction: "", network: NETWORK, payer };
      settled = this.append("settled", c.key, this.liveNow(), { settleResponse: sr });
      await this.store.sync();
    }
    const journal = this.journal as JournalChain;
    journal.fault = undefined;
    const summary = await this.applySettled(c, settled);
    if (journal.fault) throw journal.fault;
    const rec = (this.log as S.SolidarityLog).inspect(b.share.id) as { exact?: { error?: string } } | undefined;
    this.append("cycle-end", c.key, this.liveNow(), { summary, error: rec?.exact?.error ?? null });
    this.unfinished = undefined;
    this.current = undefined;
    this.bumpFailures(summary.state === "collected");
    return summary;
  }

  // ---- month close ----------------------------------------------------------------------------

  private async closeDue(): Promise<string[]> {
    const notes: string[] = [];
    const g = this.genesis as Genesis;
    const log = this.log as S.SolidarityLog;
    let p = log.book.nextToClose ?? g.keyFrom;
    while (p < periodOf(this.liveNow()) && !this.unfinished && !this.degraded) {
      await this.closeOne(p);
      notes.push(`closed ${p}`);
      p = nextPeriod(p);
    }
    return notes;
  }

  private async closeOne(p: string): Promise<void> {
    const log = this.log as S.SolidarityLog;
    let intent = this.store.get("close-intent", p);
    if (!intent) {
      const now = this.liveNow();
      intent = this.append("close-intent", p, now, { period: p, issuedAt: Math.max(now, periodStart(nextPeriod(p))) });
      await this.store.sync();
    }
    if (!this.store.get("close", p)) {
      this.logNow = intent.at;
      const pub = await log.closePeriod(p, intent.body.issuedAt);
      // No await between closePeriod returning and this write.
      this.append("close", p, intent.at, { period: p, issuedAt: intent.body.issuedAt, jws: pub.statement.signature, hash: S.statementHash(S.decodeStatement(pub.statement).payload) });
    }
    await this.cosignWitness(p);
    await this.cosignFund(p);
  }

  private resolver(): S.KeyResolver {
    const k = this.keys as Record<DidRole, SigningKey>;
    return S.staticResolver({ [k.log.kid]: k.log.publicKey, [k.witness.kid]: k.witness.publicKey, [k.fund.kid]: k.fund.publicKey });
  }

  private closedPeriods(): string[] {
    const log = this.log as S.SolidarityLog;
    const out: string[] = [];
    const last = log.book.lastClosed?.period;
    if (!last) return out;
    for (let p = (this.genesis as Genesis).keyFrom; p <= last; p = nextPeriod(p)) if (log.book.get(p)) out.push(p);
    return out;
  }

  private async cosignPending(): Promise<string[]> {
    const notes: string[] = [];
    for (const p of this.closedPeriods()) {
      if (!this.store.get("cosign", `${p}:witness`)) await this.cosignWitness(p);
      if (!this.store.get("cosign", `${p}:fund`) && !this.store.get("fund-refused", p)) {
        await this.cosignFund(p);
        if (this.store.get("cosign", `${p}:fund`)) notes.push(`fund cosigned ${p}`);
      }
    }
    return notes;
  }

  /**
   * The demo witness. A fresh Witness remembers nothing across restarts, so the
   * engine enforces its memory: `previous` must be the hash of the statement it
   * cosigned for the month before (or null for the log's first month), and it
   * never cosigns a second payload for a month.
   */
  private async cosignWitness(p: string): Promise<void> {
    if (this.store.get("cosign", `${p}:witness`)) return;
    const log = this.log as S.SolidarityLog;
    const closed = log.book.get(p);
    if (!closed) throw new Error(`${p} is not closed`);
    const d = S.decodeStatement(closed.pub.statement);
    const g = this.genesis as Genesis;
    const prev = p === g.keyFrom ? undefined : log.book.get(previousPeriod(p));
    const want = p === g.keyFrom ? null : prev ? S.statementHash(prev.payload) : "missing";
    if (d.payload.previous !== want) {
      this.degraded = `the demo witness refuses ${p}: previous does not chain to the statement it cosigned for the month before`;
      return;
    }
    const k = this.keys as Record<DidRole, SigningKey>;
    let env: JwsEnvelope;
    try {
      env = new S.Witness(k.witness).cosign(closed.pub, { resolveKey: this.resolver(), descriptor: this.descriptor, files: { lines: closed.lines, settlements: closed.settlements } });
    } catch (e) {
      this.degraded = `the demo witness refuses ${p}: ${msg(e)}`;
      return;
    }
    this.append("cosign", `${p}:witness`, this.liveNow(), { period: p, role: "witness", kid: k.witness.kid, jws: env.signature, payloadHash: d.hash });
    log.addCosignature(p, env);
  }

  /**
   * The demo fund. It reads each exact:<transaction> reference on chain
   * (receipt status, one USDC Transfer to the fund of the listed amount, 12
   * confirmations), records what it read, and cosigns from those records.
   * If a check fails it refuses for good and the statement stays published
   * with the witness's cosignature only. If the chain cannot be read by 14
   * days after the month ends, it gives up and says so.
   */
  private async cosignFund(p: string): Promise<void> {
    if (this.store.get("cosign", `${p}:fund`) || this.store.get("fund-refused", p)) return;
    const log = this.log as S.SolidarityLog;
    const closed = log.book.get(p);
    if (!closed) throw new Error(`${p} is not closed`);
    const refuse = (reason: string, definitive: boolean) => this.append("fund-refused", p, this.liveNow(), { period: p, reason, definitive });
    let txs: string[];
    try {
      txs = exactRefs(S.parseFileBody(closed.settlements).map(S.parseSettlement));
    } catch (e) {
      refuse(msg(e), true);
      return;
    }
    // The fund's memory across statements: a transfer it attested for one month never counts for another.
    for (const q of this.closedPeriods()) {
      if (q === p) continue;
      const other = new Set(exactRefs(S.parseFileBody(log.book.get(q)?.settlements ?? "").map(S.parseSettlement)));
      const dup = txs.find((t) => other.has(t));
      if (dup) {
        refuse(`fund refuses: exact:${dup} is already listed for ${q}`, true);
        return;
      }
    }
    const missing = txs.filter((t) => !this.store.get("fund-check", t));
    if (missing.length) {
      try {
        if ((await this.io.chainId()) !== CHAIN_ID) throw new Error("the RPC endpoint is not on Base Sepolia");
        const latest = await this.io.blockNumber();
        for (const tx of missing.slice(0, RECEIPTS_PER_RUN)) {
          const r = await this.io.receipt(tx);
          if (!r || latest - r.blockNumber < FUND_CONFIRMATIONS) continue;
          this.append("fund-check", tx, this.liveNow(), fundCheckOf(tx, r, ASSET, FUND_ADDRESS));
        }
      } catch {
        // transient: no row is written, and the next tick or alarm tries again
      }
    }
    const checks = new Map<string, FundCheck>();
    for (const tx of txs) {
      const c = this.store.get("fund-check", tx);
      if (c) checks.set(tx, c.body as FundCheck);
    }
    if (checks.size < txs.length) {
      const deadline = periodStart(nextPeriod(p)) + FUND_DEADLINE_SECONDS;
      if (this.io.now() >= deadline) refuse(`the transfers could not be checked on Base Sepolia before ${new Date(deadline * 1000).toISOString().slice(0, 10)}`, false);
      else await this.armAlarm(this.io.now() + 3600);
      return;
    }
    const k = this.keys as Record<DidRole, SigningKey>;
    let env: JwsEnvelope;
    try {
      env = new S.FundCosigner({ fund: FUND, key: k.fund, view: fundViewFrom(checks), logAuthorizers: {} }).cosign(closed.pub, closed.settlements, { resolveKey: this.resolver(), descriptor: this.descriptor });
    } catch (e) {
      if (!/^fund refuses/.test(msg(e))) throw e;
      refuse(msg(e), true);
      return;
    }
    this.append("cosign", `${p}:fund`, this.liveNow(), { period: p, role: "fund", kid: k.fund.kid, jws: env.signature, payloadHash: S.decodeStatement(closed.pub.statement).hash });
    log.addCosignature(p, env);
  }

  // ---- reading ---------------------------------------------------------------------------------

  /** The log's five endpoints, exactly as SolidarityLog.handle serves them (503 while degraded). */
  serve(path: string): { status: number; contentType: string; body: string } {
    if (this.degraded || !this.log) return { status: 503, contentType: "application/json", body: JSON.stringify({ error: `the log is not serving: ${this.degraded ?? "not booted"}` }) };
    return this.log.handle(path);
  }

  receipt(id: string): unknown | undefined {
    if (this.degraded || !this.log) return undefined;
    return this.log.receipt(id);
  }

  didDocument(role: DidRole): Record<string, unknown> | undefined {
    if (!this.genesis || !this.keys || this.degraded) return undefined;
    return didDocument(this.genesis.origin, role, S.publicJwk(this.keys[role].publicKey));
  }

  /** Everything the index page shows, from memory and the records. */
  snapshot(): Snapshot {
    const g = this.genesis;
    const now = this.io.now();
    const end = endBoundary(this.config.endDate);
    const state = this.degraded ? "degraded" : this.config.paused ? "paused" : end !== undefined && now >= end ? "ended" : "running";
    const log = this.log;
    const cycles: CycleView[] = [];
    if (log && !this.degraded) {
      for (const c of this.store.recent("cycle", 20)) {
        const pr = this.store.get("result", `submit:${c.body.purchase.payload.authorization.nonce.toLowerCase()}`)?.body;
        const sr = this.store.get("result", `submit:${c.body.share.info.payment.payload.authorization.nonce.toLowerCase()}`)?.body;
        const ended = this.store.get("cycle-end", c.key)?.body;
        const settled = this.store.get("settled", c.key);
        cycles.push({
          n: c.body.n,
          at: c.at,
          purchase: pr ? { ok: !!pr.ok, transaction: pr.ok ? pr.transaction : null, error: pr.ok ? null : pr.error } : null,
          share: { id: c.body.share.id, amount: c.body.share.amount },
          settledAt: settled?.at ?? null,
          summary: ended?.summary ?? null,
          shareError: sr && !sr.ok ? sr.error : (ended?.error ?? null),
        });
      }
    }
    const statements: StatementView[] = [];
    if (log && !this.degraded) {
      for (const p of this.closedPeriods()) {
        const closed = log.book.get(p);
        if (!closed) continue;
        const refused = this.store.get("fund-refused", p)?.body;
        statements.push({
          period: p,
          size: closed.payload.size,
          root: closed.payload.root,
          totals: closed.payload.totals,
          issuedAt: closed.payload.issuedAt,
          previous: closed.payload.previous,
          witness: !!this.store.get("cosign", `${p}:witness`),
          fund: !!this.store.get("cosign", `${p}:fund`),
          fundRefused: refused ? { reason: refused.reason, definitive: refused.definitive } : null,
        });
      }
    }
    const lastBalance = this.store.status("lastBalance");
    return {
      mode: this.config.mode,
      state,
      degraded: this.degraded ?? null,
      paused: this.config.paused,
      endDate: this.config.endDate,
      now,
      origin: g?.origin ?? this.config.origin,
      log: g?.log ?? null,
      keyFrom: g?.keyFrom ?? null,
      payer: g?.payer ?? null,
      fund: FUND,
      facilitator: this.config.mode === "live" ? this.config.facilitatorUrl : null,
      balance: lastBalance ? { at: lastBalance.at, units: lastBalance.balance } : null,
      lastTick: this.store.status("lastTick") ?? null,
      lastError: this.store.status("lastError") ?? null,
      backoffUntil: Number(this.store.status("backoffUntil") ?? 0) > now ? Number(this.store.status("backoffUntil")) : null,
      unfinished: this.unfinished?.body.n ?? null,
      nextClose: periodStart(nextPeriod(periodOf(now))),
      logKeyHex: this.keys ? S.ed25519PublicKeyHex(this.keys.log.publicKey) : null,
      kids: g?.kids ?? null,
      cycles,
      statements: statements.reverse(),
    };
  }
}

export interface CycleView {
  n: number;
  at: number;
  purchase: { ok: boolean; transaction: string | null; error: string | null } | null;
  share: { id: string; amount: string };
  settledAt: number | null;
  summary: Summary | null;
  shareError: string | null;
}

export interface StatementView {
  period: string;
  size: number;
  root: string;
  totals: Array<{ fund: string; asset: string; lines: number; amount: string }>;
  issuedAt: number;
  previous: string | null;
  witness: boolean;
  fund: boolean;
  fundRefused: { reason: string; definitive: boolean } | null;
}

export interface Snapshot {
  mode: Mode;
  state: "running" | "paused" | "ended" | "degraded";
  degraded: string | null;
  paused: boolean;
  endDate: string;
  now: number;
  origin: string;
  log: string | null;
  keyFrom: string | null;
  payer: string | null;
  fund: string;
  facilitator: string | null;
  balance: { at: number; units: string } | null;
  lastTick: Body;
  lastError: Body;
  backoffUntil: number | null;
  unfinished: number | null;
  nextClose: number;
  logKeyHex: string | null;
  kids: Record<DidRole, string> | null;
  cycles: CycleView[];
  statements: StatementView[];
}
