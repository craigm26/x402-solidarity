/**
 * The Cloudflare Worker: one Durable Object (DemoLogObject, addressed by the
 * name "log") holds the whole log in its SQLite storage. This is the only
 * file that imports cloudflare:workers; everything else runs in Node too.
 *
 * - fetch: every request goes to the Durable Object, then to routes.ts.
 * - scheduled (cron "0 *\/6 * * *"): one tick. Finish recorded work, close
 *   any month that has ended, then start one purchase if nothing stops it.
 * - alarm: set while a purchase or share is in flight, or a fund check
 *   waits. It only finishes recorded work and never starts a purchase.
 *
 * Secrets: PAYER_KEY (the throwaway Base Sepolia key; never in wrangler.jsonc
 * or the repository), and ADMIN_TOKEN only for MODE=sim under wrangler dev.
 */

import { DurableObject } from "cloudflare:workers";
import { configFromEnv, Engine } from "./engine.ts";
import type { TickReport } from "./engine.ts";
import { LiveIO, SimIO, SimWorld } from "./io.ts";
import type { ChainIO } from "./io.ts";
import { renderPage } from "./page.ts";
import { route } from "./routes.ts";
import type { Site } from "./routes.ts";
import { SqlStore } from "./store.ts";
import type { SqlStorageLike } from "./store.ts";

interface Stub {
  fetch(request: Request): Promise<Response>;
  tick(): Promise<unknown>;
}

export interface Env {
  LOG: { idFromName(name: string): unknown; get(id: unknown): Stub };
  MODE?: string;
  PUBLIC_ORIGIN?: string;
  PAYER_ADDRESS?: string;
  FACILITATOR_URL?: string;
  RPC_URL?: string;
  END_DATE?: string;
  PAUSED?: string;
  /** Secret. */
  PAYER_KEY?: string;
  /** Secret, MODE=sim only. */
  ADMIN_TOKEN?: string;
  /** MODE=sim: how far each tick moves the simulated clock (default 21600, six hours). */
  SIM_TICK_SECONDS?: string;
}

interface State {
  storage: SqlStorageLike & { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const brief = (r: TickReport | { error: string }) =>
  "error" in r ? r : { at: r.at, notes: r.maintained, cycle: r.cycle?.n ?? null, stop: r.stop ?? r.cycle?.stop ?? null, state: r.cycle?.summary?.state ?? null };

export class DemoLogObject extends DurableObject<Env> {
  private engine!: Engine;
  private sim: SimIO | undefined;
  private store!: SqlStore;
  private readonly st: State;

  constructor(ctx: State, env: Env) {
    super(ctx as never, env);
    this.st = ctx;
    ctx.blockConcurrencyWhile(() => this.load());
  }

  /** Rebuild the log from storage. No network call: replay answers from the records. */
  private async load(): Promise<void> {
    this.store = new SqlStore(this.st.storage);
    const config = configFromEnv(this.env as unknown as Record<string, string | undefined>);
    let io: ChainIO;
    if (config.mode === "sim") {
      // Simulated chain, rebuilt from its own ops. Virtual time: it moves only when a tick or sleep moves it.
      const start = Number(this.store.status("simNow") ?? Math.floor(Date.now() / 1000));
      const world = await SimWorld.fromOps(this.store.simOps(), start);
      world.onOp = (at, op, body) => this.store.appendSimOp(at, op, body);
      this.sim = new SimIO(world, { onClock: (t) => this.store.setStatus("simNow", t) });
      this.store.setStatus("simNow", world.now);
      io = this.sim;
    } else {
      io = new LiveIO({ rpcUrl: config.rpcUrl, facilitatorUrl: config.facilitatorUrl });
    }
    this.engine = new Engine({
      store: this.store,
      io,
      config,
      payerKey: () => this.env.PAYER_KEY,
      setAlarm: (at) => this.armAlarm(at),
    });
    await this.engine.boot();
  }

  private async armAlarm(at: number): Promise<void> {
    const want = at * 1000;
    const cur = await this.st.storage.getAlarm();
    if (cur === null || cur > want || cur < Date.now()) await this.st.storage.setAlarm(want);
  }

  private simStep(): number {
    const s = Number(this.env.SIM_TICK_SECONDS ?? "21600");
    return Number.isInteger(s) && s > 0 ? s : 21600;
  }

  /** The cron tick (also what /__scheduled runs under wrangler dev --test-scheduled). */
  async tick(): Promise<unknown> {
    if (this.sim) this.sim.advance(this.simStep());
    try {
      return brief(await this.engine.tick());
    } catch (e) {
      console.error("tick failed:", msg(e));
      return { error: msg(e) };
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.engine.maintain();
    } catch (e) {
      console.error("alarm failed:", msg(e));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const e = this.engine;
    const sim = this.sim;
    const token = this.env.ADMIN_TOKEN;
    const site: Site = {
      degraded: () => e.degraded,
      serveLog: (p) => e.serve(p),
      did: (role) => e.didDocument(role),
      receipt: (id) => e.receipt(id),
      page: () => renderPage(e.snapshot()),
      status: () => e.snapshot(),
      admin:
        sim && token
          ? {
              token,
              tick: async (n) => {
                const out: unknown[] = [];
                for (let i = 0; i < n; i++) {
                  sim.advance(this.simStep());
                  out.push(brief(await e.tick().catch((err) => ({ error: msg(err) }))));
                }
                return { simulatedNow: new Date(sim.now() * 1000).toISOString(), ticks: out };
              },
              advance: async (seconds) => {
                sim.advance(seconds);
                return { simulatedNow: new Date(sim.now() * 1000).toISOString() };
              },
            }
          : undefined,
    };
    return route(request, site);
  }
}

const stub = (env: Env): Stub => env.LOG.get(env.LOG.idFromName("log"));

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return stub(env).fetch(request);
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const r = await stub(env).tick();
    console.log("tick", JSON.stringify(r));
  },
};
