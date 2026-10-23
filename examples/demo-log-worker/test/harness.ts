/**
 * Test rig for the demo log: the engine over MemoryStore and SimIO, with a
 * simulated clock. SIMULATED: nothing here touches a network or a chain.
 */

import type { SigningKey } from "../../../src/solidarity/index.ts";
import * as S from "../../../src/solidarity/index.ts";
import type { CycleReport, EngineConfig, TickReport } from "../engine.ts";
import { Engine } from "../engine.ts";
import type { ChainIO, ReceiptFacts, SettleAnswer, TransferFound } from "../io.ts";
import { SimIO, SimWorld } from "../io.ts";
import type { SimHooks } from "../io.ts";
import { MemoryStore } from "../store.ts";
import type { ExactEip3009Payload, PaymentRequirements } from "../../../src/solidarity/index.ts";

export const ORIGIN = "https://demo.example";
export const HOUR = 3600;
export const at = (iso: string): number => Date.parse(iso) / 1000;

export function simConfig(over: Partial<EngineConfig> = {}): EngineConfig {
  return { mode: "sim", origin: ORIGIN, paused: false, endDate: "2027-03-31", facilitatorUrl: "https://facilitator.invalid", rpcUrl: "https://rpc.invalid", ...over };
}

/** Throws on any private-key read while armed, and counts the reads. */
export class KeyGuard {
  armed = false;
  reads = 0;
  wrap = (key: SigningKey, name: string): SigningKey => {
    const guard = this;
    return {
      alg: key.alg,
      kid: key.kid,
      publicKey: key.publicKey,
      get privateKey() {
        if (guard.armed) throw new Error(`the ${name} private key was read during replay`);
        guard.reads++;
        return key.privateKey;
      },
    };
  };
}

/**
 * A ChainIO that throws on every call until it is given a target: the chain
 * double for replay. Boot must never call it.
 */
export class SwitchIO implements ChainIO {
  readonly kind = "sim" as const;
  target: ChainIO | undefined;
  blocked = 0;

  private t(): ChainIO {
    if (!this.target) {
      this.blocked++;
      throw new Error("chain called during replay");
    }
    return this.target;
  }

  now(): number {
    return this.t().now();
  }
  sleep(s: number): Promise<void> {
    return this.t().sleep(s);
  }
  chainId(): Promise<number> {
    return this.t().chainId();
  }
  blockNumber(): Promise<bigint> {
    return this.t().blockNumber();
  }
  balanceOf(h: string): Promise<bigint> {
    return this.t().balanceOf(h);
  }
  authorizationState(f: string, n: string): Promise<boolean> {
    return this.t().authorizationState(f, n);
  }
  settle(a: PaymentRequirements, p: ExactEip3009Payload): Promise<SettleAnswer> {
    return this.t().settle(a, p);
  }
  findTransfer(a: PaymentRequirements, p: ExactEip3009Payload, w: { fromBlock: bigint; toBlock: bigint }): Promise<TransferFound | undefined> {
    return this.t().findTransfer(a, p, w);
  }
  receipt(tx: string): Promise<ReceiptFacts | undefined> {
    return this.t().receipt(tx);
  }
}

export interface Rig {
  store: MemoryStore;
  world: SimWorld;
  io: SimIO;
  engine: Engine;
  keys: KeyGuard;
  alarms: number[];
  config: EngineConfig;
}

/** A new log, or (with `store` and `world`) the same log after a restart. */
export async function rig(opts: { start?: number; config?: Partial<EngineConfig>; store?: MemoryStore; world?: SimWorld; hooks?: SimHooks; payerKey?: () => string | undefined; persistWorld?: boolean } = {}): Promise<Rig> {
  const store = opts.store ?? new MemoryStore();
  const world = opts.world ?? new SimWorld(opts.start ?? at("2026-10-23T00:00:00Z"));
  if (opts.persistWorld) world.onOp = (t, op, body) => store.appendSimOp(t, op, body);
  const io = new SimIO(world, { hooks: opts.hooks, gate: () => store.gate() });
  const keys = new KeyGuard();
  const alarms: number[] = [];
  const config = simConfig(opts.config);
  const engine = new Engine({ store, io, config, payerKey: opts.payerKey, wrapKey: keys.wrap, setAlarm: (t) => void alarms.push(t) });
  await engine.boot();
  return { store, world, io, engine, keys, alarms, config };
}

/**
 * Restart over the same store and chain with the replay guards on: no chain
 * call, no private key and no payer key may be touched while the log is
 * rebuilt. Returns the rig with the guards off again.
 */
export async function restart(prev: { store: MemoryStore; world: SimWorld; config: EngineConfig }, opts: { hooks?: SimHooks; payerKey?: () => string | undefined; world?: SimWorld } = {}): Promise<Rig & { blockedCalls: number }> {
  const store = prev.store;
  const world = opts.world ?? prev.world;
  const sw = new SwitchIO();
  const keys = new KeyGuard();
  keys.armed = true;
  let payerArmed = true;
  const payerKey = opts.payerKey ? () => {
    if (payerArmed) throw new Error("the payer key was read during replay");
    return (opts.payerKey as () => string | undefined)();
  } : undefined;
  const origGetKey = store.getKey.bind(store);
  store.getKey = (name: string) => {
    if (payerArmed && name === "sim-payer") throw new Error("the simulated payer key was read during replay");
    return origGetKey(name);
  };
  const alarms: number[] = [];
  const engine = new Engine({ store, io: sw, config: prev.config, payerKey, wrapKey: keys.wrap, setAlarm: (t) => void alarms.push(t) });
  try {
    await engine.boot();
  } finally {
    keys.armed = false;
    payerArmed = false;
    store.getKey = origGetKey;
  }
  const io = new SimIO(world, { hooks: opts.hooks, gate: () => store.gate() });
  sw.target = io;
  return { store, world, io, engine, keys, alarms, config: prev.config, blockedCalls: sw.blocked };
}

/** Move the simulated clock and run one tick. */
export async function tickAfter(r: Rig, seconds: number): Promise<TickReport> {
  r.io.advance(seconds);
  return r.engine.tick();
}

/** Ticks every `step` seconds until the simulated clock reaches `until`. */
export async function runUntil(r: Rig, until: number, step = 6 * HOUR): Promise<TickReport[]> {
  const out: TickReport[] = [];
  while (r.world.now + step <= until) out.push(await tickAfter(r, step));
  return out;
}

export const collected = (c: CycleReport | undefined): boolean => c?.summary?.state === "collected";

/** Every published body the log serves, keyed by path: what must not change across a restart. */
export function published(r: { engine: Engine; store: MemoryStore }): Map<string, string> {
  const out = new Map<string, string>();
  const e = r.engine;
  const put = (path: string) => {
    const x = e.serve(path);
    out.set(`/solidarity${path}`, `${x.status} ${x.contentType}\n${x.body}`);
  };
  put("");
  const last = e.log?.book.lastClosed?.period;
  if (last && e.genesis) {
    for (let p = e.genesis.keyFrom; p <= last; p = S.nextPeriod(p)) for (const f of ["statements", "lines", "settlements"]) put(`/${f}/${p}`);
  }
  for (const c of r.store.events().filter((x) => x.kind === "cycle")) {
    put(`/proofs/${c.body.share.id}`);
    out.set(`/receipts/${c.body.share.id}`, JSON.stringify(e.receipt(c.body.share.id) ?? null));
  }
  for (const role of ["log", "witness", "fund"] as const) out.set(`did:${role}`, JSON.stringify(e.didDocument(role)));
  return out;
}

/** The invariants that must hold after any run, crash or restart. */
export function invariants(r: Rig): string[] {
  const problems: string[] = [];
  for (const [nonce, n] of r.world.executions) if (n > 1) problems.push(`nonce ${nonce} executed ${n} times`);
  const e = r.engine;
  const log = e.log;
  if (!log) return [...problems, "no log"];
  const cycles = r.store.events().filter((x) => x.kind === "cycle");
  let unfinished = 0;
  for (const c of cycles) {
    const rec = log.inspect(c.body.share.id);
    const end = r.store.get("cycle-end", c.key);
    if (!end) unfinished++;
    if (rec?.state === "collected") {
      const tx = rec.exact?.transaction as string;
      if (!r.world.receipts.has(tx)) problems.push(`share ${c.body.share.id} collected with ${tx}, which the chain does not have`);
      const receipt = r.world.receipts.get(tx);
      const to = receipt?.logs[0]?.topics[2];
      if (to && !to.endsWith("f00d")) problems.push(`share ${c.body.share.id}: its transfer did not go to the fund`);
    }
    // A share whose authorization executed on chain is never left out of the log.
    const shareNonce = c.body.share.info.payment.payload.authorization.nonce.toLowerCase();
    if (end && r.world.executions.get(shareNonce) && rec?.state !== "collected") problems.push(`share ${c.body.share.id} executed on chain but is ${rec?.state ?? "not recorded"}`);
  }
  if (unfinished > 1) problems.push(`${unfinished} cycles are unfinished`);
  return problems;
}
