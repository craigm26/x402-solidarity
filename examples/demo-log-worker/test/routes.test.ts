/**
 * The HTTP surface: read only, and no route a visitor can reach starts a
 * purchase, spends or closes a month.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Site } from "../routes.ts";
import { route } from "../routes.ts";
import { at, HOUR, rig, runUntil } from "./harness.ts";

function fakeSite(opts: { admin?: boolean; degraded?: string } = {}) {
  const calls: string[] = [];
  const site: Site = {
    degraded: () => opts.degraded,
    serveLog: (p) => {
      calls.push(`log:${p}`);
      return { status: 200, contentType: "text/plain; charset=utf-8", body: `served ${p}` };
    },
    did: (role) => ({ role }),
    receipt: (id) => (id.startsWith("known") ? { id } : undefined),
    page: () => "<!doctype html><title>x</title>",
    status: () => ({ ok: true }),
    admin: opts.admin
      ? {
          token: "s3cret-token",
          tick: async (n) => {
            calls.push(`tick:${n}`);
            return { n };
          },
          advance: async (s) => {
            calls.push(`advance:${s}`);
            return { s };
          },
        }
      : undefined,
  };
  return { site, calls };
}

const req = (path: string, init: RequestInit = {}) => new Request(`https://demo.example${path}`, init);

test("the log's five endpoints: the /solidarity prefix is stripped and the rest passed on unchanged", async () => {
  const { site, calls } = fakeSite();
  for (const [path, want] of [
    ["/solidarity", ""],
    ["/solidarity/", ""],
    ["/solidarity/statements/2026-10", "/statements/2026-10"],
    ["/solidarity/lines/2026-10", "/lines/2026-10"],
    ["/solidarity/settlements/2026-10", "/settlements/2026-10"],
    ["/solidarity/proofs/AAAAAAAAAAAAAAAAAAAAAA", "/proofs/AAAAAAAAAAAAAAAAAAAAAA"],
    ["/solidarity/nope", "/nope"],
  ]) {
    const r = await route(req(path), site);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), `served ${want}`);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  }
  assert.equal(calls.length, 7);
  assert.equal((await route(req("/solidarityx"), site)).status, 404);
});

test("did:web documents, receipts, the page and HEAD", async () => {
  const { site } = fakeSite();
  for (const [path, role] of [["/.well-known/did.json", "log"], ["/witness/did.json", "witness"], ["/fund/did.json", "fund"]]) {
    const r = await route(req(path), site);
    assert.equal(r.headers.get("content-type"), "application/json");
    assert.deepEqual(await r.json(), { role });
  }
  assert.equal((await route(req("/receipts/known-AAAAAAAAAAAAAAAAAA"), site)).status, 200);
  assert.equal((await route(req("/receipts/other-AAAAAAAAAAAAAAAAAA"), site)).status, 404);
  assert.equal((await route(req("/receipts/short"), site)).status, 404);
  const page = await route(req("/"), site);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const head = await route(req("/solidarity", { method: "HEAD" }), site);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("no method or path reaches a tick: every write method is refused, and admin routes exist only in simulated mode with the token", async () => {
  const live = fakeSite();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/", "/solidarity", "/solidarity/statements/2026-10", "/status.json", "/__scheduled", "/tick", "/admin/tick", "/admin/advance"]) {
      const r = await route(req(path, { method }), live.site);
      assert.ok([404, 405].includes(r.status), `${method} ${path} gave ${r.status}`);
    }
  }
  for (const path of ["/admin/tick?n=1", "/admin/advance?seconds=60", "/__scheduled?cron=0+*/6+*+*+*", "/cron", "/close"]) {
    assert.equal((await route(req(path), live.site)).status, 404, path);
    assert.ok([404, 405].includes((await route(req(path, { method: "POST", headers: { authorization: "Bearer s3cret-token" } }), live.site)).status), path);
  }
  assert.deepEqual(live.calls.filter((c) => !c.startsWith("log:")), []);

  const sim = fakeSite({ admin: true });
  assert.equal((await route(req("/admin/tick?n=2", { method: "POST" }), sim.site)).status, 401);
  assert.equal((await route(req("/admin/tick?n=2", { method: "POST", headers: { authorization: "Bearer wrong" } }), sim.site)).status, 401);
  assert.equal((await route(req("/admin/tick?n=2", { method: "GET", headers: { authorization: "Bearer s3cret-token" } }), sim.site)).status, 405);
  assert.deepEqual(sim.calls, []);
  assert.equal((await route(req("/admin/tick?n=2", { method: "POST", headers: { authorization: "Bearer s3cret-token" } }), sim.site)).status, 200);
  assert.equal((await route(req("/admin/tick?n=0", { method: "POST", headers: { authorization: "Bearer s3cret-token" } }), sim.site)).status, 400);
  assert.equal((await route(req("/admin/advance?seconds=86400", { method: "POST", headers: { authorization: "Bearer s3cret-token" } }), sim.site)).status, 200);
  assert.deepEqual(sim.calls, ["tick:2", "advance:86400"]);
});

test("while degraded the log's endpoints answer 503 and the page explains", async () => {
  const { site, calls } = fakeSite({ degraded: "replay differs" });
  for (const path of ["/solidarity", "/solidarity/statements/2026-10", "/.well-known/did.json", "/receipts/known-AAAAAAAAAAAAAAAAAA"]) {
    const r = await route(req(path), site);
    assert.equal(r.status, 503, path);
    assert.match((await r.json()).error, /replay differs/);
  }
  assert.equal((await route(req("/"), site)).status, 200);
  assert.deepEqual(calls, []);
});

test("routes over a real engine: bodies are exactly what SolidarityLog.handle returns", async () => {
  const r = await rig({ start: at("2026-10-31T00:00:00Z") });
  await runUntil(r, at("2026-11-01T00:00:00Z"), 6 * HOUR);
  const e = r.engine;
  const site: Site = {
    degraded: () => e.degraded,
    serveLog: (p) => e.serve(p),
    did: (role) => e.didDocument(role),
    receipt: (id) => e.receipt(id),
    page: () => "",
    status: () => e.snapshot(),
  };
  const id = r.store.events().find((x) => x.kind === "cycle")?.body.share.id as string;
  for (const p of ["", "/statements/2026-10", "/lines/2026-10", "/settlements/2026-10", `/proofs/${id}`, "/statements/2026-09"]) {
    const res = await route(req(`/solidarity${p}`), site);
    const want = e.log?.handle(p) as { status: number; contentType: string; body: string };
    assert.equal(res.status, want.status, p);
    assert.equal(res.headers.get("content-type"), want.contentType, p);
    assert.equal(await res.text(), want.body, p);
  }
  const receipt = await route(req(`/receipts/${id}`), site);
  assert.equal(receipt.status, 200);
  assert.equal((await receipt.json()).version, 2);
  // Cache headers: a closed month's lines and settlements never change; the page and status.json for a minute;
  // everything that can still change (statements gain cosignatures, proofs move from queued), and every 404, no-cache.
  const cc = async (path: string) => (await route(req(path), site)).headers.get("cache-control");
  assert.equal(await cc("/solidarity/lines/2026-10"), "public, max-age=86400, immutable");
  assert.equal(await cc("/solidarity/settlements/2026-10"), "public, max-age=86400, immutable");
  assert.equal(await cc("/solidarity/lines/2026-11"), "no-cache", "not closed yet: 404");
  for (const path of ["/solidarity", "/solidarity/statements/2026-10", `/solidarity/proofs/${id}`, `/receipts/${id}`, "/.well-known/did.json"]) assert.equal(await cc(path), "no-cache", path);
  for (const path of ["/", "/status.json"]) assert.equal(await cc(path), "public, max-age=60", path);
});
