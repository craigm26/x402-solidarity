/**
 * HTTP routes. Read only: GET and HEAD, and nothing a visitor can do starts
 * a purchase, spends, or closes a month. The only other routes are the
 * simulation's admin routes, which exist only with MODE=sim and an
 * ADMIN_TOKEN secret, and need that token as a bearer.
 *
 *   /                         the index page
 *   /status.json              the data behind the page
 *   /solidarity[/...]         the log's five endpoints, exactly as SolidarityLog.handle serves them
 *   /.well-known/did.json     did:web:<host>          (the log's key)
 *   /witness/did.json         did:web:<host>:witness  (the demo witness)
 *   /fund/did.json            did:web:<host>:fund     (the demo fund's key)
 *   /receipts/<id>            a full receipt for an included share
 *   POST /admin/tick?n=N, POST /admin/advance?seconds=S   (MODE=sim with ADMIN_TOKEN only)
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { DidRole } from "./did.ts";

export interface Site {
  /** Why the log is not serving, or undefined. */
  degraded(): string | undefined;
  serveLog(path: string): { status: number; contentType: string; body: string };
  did(role: DidRole): unknown | undefined;
  receipt(id: string): unknown | undefined;
  page(): string;
  status(): unknown;
  /** Present only in simulated mode with ADMIN_TOKEN set. */
  admin?: { token: string; tick(n: number): Promise<unknown>; advance(seconds: number): Promise<unknown> };
}

const READ_HEADERS = { "access-control-allow-origin": "*", "cache-control": "no-cache" };
/** A closed month's lines and settlements never change. */
const IMMUTABLE = { "cache-control": "public, max-age=86400, immutable" };
/** The page and its data change at most every tick (6 hours) or alarm. */
const SHORT = { "cache-control": "public, max-age=60" };

function respond(method: string, status: number, contentType: string, body: string, extra: Record<string, string> = {}): Response {
  return new Response(method === "HEAD" ? null : body, { status, headers: { "content-type": contentType, ...READ_HEADERS, ...extra } });
}

const json = (method: string, status: number, v: unknown) => respond(method, status, "application/json", JSON.stringify(v));

function sameToken(given: string, want: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

const DID_PATHS: Record<string, DidRole> = { "/.well-known/did.json": "log", "/witness/did.json": "witness", "/fund/did.json": "fund" };

export async function route(request: Request, site: Site): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/admin/tick" || path === "/admin/advance") {
    if (!site.admin) return json("GET", 404, { error: "not found" });
    if (method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const auth = request.headers.get("authorization") ?? "";
    const m = /^Bearer (.+)$/.exec(auth);
    if (!m || !sameToken(m[1], site.admin.token)) return json("POST", 401, { error: "a bearer token is required" });
    if (path === "/admin/tick") {
      const n = Number(url.searchParams.get("n") ?? "1");
      if (!Number.isInteger(n) || n < 1 || n > 200) return json("POST", 400, { error: "n must be 1 to 200" });
      return json("POST", 200, await site.admin.tick(n));
    }
    const s = Number(url.searchParams.get("seconds") ?? "0");
    if (!Number.isInteger(s) || s < 1 || s > 400 * 86400) return json("POST", 400, { error: "seconds must be 1 to 34560000" });
    return json("POST", 200, await site.admin.advance(s));
  }

  if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });

  if (path === "/" || path === "/index.html") return respond(method, 200, "text/html; charset=utf-8", site.page(), SHORT);
  if (path === "/status.json") return respond(method, 200, "application/json", JSON.stringify(site.status()), SHORT);

  const down = site.degraded();
  if (path === "/solidarity" || path.startsWith("/solidarity/")) {
    if (down) return json(method, 503, { error: `the log is not serving: ${down}` });
    const rest = path.slice("/solidarity".length);
    const r = site.serveLog(rest === "/" ? "" : rest);
    const fixed = r.status === 200 && /^\/(lines|settlements)\/[0-9]{4}-[0-9]{2}$/.test(rest);
    return respond(method, r.status, r.contentType, r.body, fixed ? IMMUTABLE : {});
  }
  if (path in DID_PATHS) {
    if (down) return json(method, 503, { error: `the log is not serving: ${down}` });
    const doc = site.did(DID_PATHS[path]);
    return doc ? respond(method, 200, "application/json", JSON.stringify(doc)) : json(method, 404, { error: "not found" });
  }
  const m = /^\/receipts\/([A-Za-z0-9_-]{22,128})$/.exec(path);
  if (m) {
    if (down) return json(method, 503, { error: `the log is not serving: ${down}` });
    const r = site.receipt(m[1]);
    return r ? json(method, 200, r) : json(method, 404, { error: "no receipt: the share is not in a published statement" });
  }
  return json(method, 404, { error: "not found" });
}
