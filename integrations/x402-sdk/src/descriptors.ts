/**
 * A cache of log descriptors for the buyer's side.
 *
 * "A client SHOULD cache log descriptors, MUST NOT delay a purchase to fetch
 * one, and leaves the share out when it has none for the chosen log (it MAY
 * fetch one for later purchases)" (solidarity.md, "Advertisement").
 *
 * So `get` is synchronous and never fetches. `refresh` fetches `GET <log>` in
 * the background; the client extension starts it without awaiting it when a
 * descriptor is missing, and an agent can `prefetch(policy.logs)` at startup.
 * An entry past its time to live is still returned (the purchase is never
 * delayed) and a refresh is started for it.
 */

import type { LogDescriptor } from "../../../src/solidarity/index.ts";

export interface DescriptorSource {
  /** The cached descriptor for this log URL, or undefined. Never fetches and never blocks. */
  get(log: string): LogDescriptor | undefined;
  /** Fetch (or re-fetch) the descriptor. The client extension starts it and never awaits it. */
  refresh?(log: string): Promise<void>;
}

export interface DescriptorCache extends DescriptorSource {
  refresh(log: string): Promise<void>;
  /** Fetch every listed log, for example `policy.logs` at agent startup. Never rejects. */
  prefetch(logs: readonly string[] | undefined): Promise<void>;
  /** Put a descriptor in the cache directly (for example one the operator handed over). It does not expire. */
  set(descriptor: LogDescriptor): void;
}

export interface DescriptorCacheOptions {
  /** The fetch used for `GET <log>`. Default: globalThis.fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** How long a fetched descriptor is fresh. Default 3600 seconds. */
  ttlSeconds?: number;
  /** Descriptors known in advance. They do not expire. */
  preload?: LogDescriptor[];
  /** Unix seconds. Default: the clock. */
  now?: () => number;
}

/** The shape a fetched descriptor must have before it is used. */
export function isUsableDescriptor(d: unknown, log: string): d is LogDescriptor {
  if (!d || typeof d !== "object") return false;
  const x = d as Partial<LogDescriptor>;
  return x.version === 2 && x.log === log && Array.isArray(x.funds) && Array.isArray(x.keys) && (x.accepts === undefined || Array.isArray(x.accepts));
}

export function createDescriptorCache(opts: DescriptorCacheOptions = {}): DescriptorCache {
  const ttl = opts.ttlSeconds ?? 3600;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const entries = new Map<string, { descriptor: LogDescriptor; expiresAt: number }>();
  const inFlight = new Map<string, Promise<void>>();

  const set = (descriptor: LogDescriptor) => {
    entries.set(descriptor.log, { descriptor: structuredClone(descriptor), expiresAt: Number.POSITIVE_INFINITY });
  };
  for (const d of opts.preload ?? []) set(d);

  const refresh = (log: string): Promise<void> => {
    const running = inFlight.get(log);
    if (running) return running;
    const doFetch = opts.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
    const p = (async () => {
      if (!/^https:\/\//.test(log)) throw new Error(`log URL is not https: ${log}`);
      const res = await doFetch(log, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`GET ${log} answered ${res.status}`);
      const body = (await res.json()) as unknown;
      if (!isUsableDescriptor(body, log)) throw new Error(`GET ${log} did not return a draft 2 descriptor for that log`);
      entries.set(log, { descriptor: body, expiresAt: now() + ttl });
    })().finally(() => inFlight.delete(log));
    inFlight.set(log, p);
    return p;
  };

  return {
    get(log: string) {
      const e = entries.get(log);
      if (!e) return undefined;
      // Stale while revalidating: an old descriptor is still used, and a refresh starts.
      if (now() >= e.expiresAt) refresh(log).catch(() => undefined);
      return e.descriptor;
    },
    refresh,
    async prefetch(logs) {
      await Promise.allSettled((logs ?? []).map((l) => refresh(l)));
    },
    set,
  };
}
