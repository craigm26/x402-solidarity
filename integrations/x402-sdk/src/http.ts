/**
 * A facilitator's HTTP surface as a fetch-style handler:
 *
 *   const handle = facilitatorFetchHandler({ facilitator, solidarity });
 *   // (req: Request) => Promise<Response>
 *
 * - POST /verify    -> facilitator.verify(paymentPayload, paymentRequirements)
 * - POST /settle    -> facilitator.settle(...), HTTP 200 for every SettleResponse
 * - GET  /supported -> facilitator.getSupported()
 * - GET  <log path>, <log path>/statements/<p>, /lines/<p>, /settlements/<p>,
 *   /proofs/<id> -> the log's five read endpoints (attestation.md, "Publication")
 *
 * Two rules matter for the solidarity outcome, and apply to any server an
 * operator writes instead:
 * - /settle answers 200 even when `success` is false. HTTPFacilitatorClient
 *   throws on any other status, and the seller's SDK then rebuilds the failure
 *   without `extensions`, so the buyer would never see the outcome.
 * - `extensionResponses` goes in the EXTENSION-RESPONSES header (base64 JSON)
 *   and is removed from the body. HTTPFacilitatorClient reads it from there
 *   for the seller; the buyer never sees it.
 *
 * A settle that throws (nothing recovered it) is answered as a failed
 * SettleResponse with HTTP 200, and its share gets `purchase-not-final`, as
 * for a settle the scheme returned as failed.
 *
 * The SDK ships no facilitator server, so this is the kit's own. It runs in
 * any runtime with Request and Response (Node 24, Workers, Deno, Bun). It has
 * no authentication, rate limits or body size limits: put it behind whatever
 * the operator already uses for those. On node:http, `fetchRequestFromNode`
 * builds the Request from a fixed origin, never from the Host header.
 */

import type { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { SolidarityFacilitator } from "./facilitator.ts";

export interface FacilitatorHandlerOptions {
  facilitator: Pick<x402Facilitator, "verify" | "settle" | "getSupported">;
  /** The attached solidarity extension: the log's read endpoints, and the outcome of a settle that threw. */
  solidarity?: Pick<SolidarityFacilitator, "log"> & Partial<Pick<SolidarityFacilitator, "afterSettle">>;
  /** A path prefix for /verify, /settle and /supported, such as "/x402". Default "". */
  basePath?: string;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

async function readBody(req: Request): Promise<{ paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } | undefined> {
  try {
    const body = (await req.json()) as { paymentPayload?: unknown; paymentRequirements?: unknown };
    if (!body || typeof body.paymentPayload !== "object" || body.paymentPayload === null) return undefined;
    if (typeof body.paymentRequirements !== "object" || body.paymentRequirements === null) return undefined;
    return { paymentPayload: body.paymentPayload as PaymentPayload, paymentRequirements: body.paymentRequirements as PaymentRequirements };
  } catch {
    return undefined;
  }
}

export function facilitatorFetchHandler(opts: FacilitatorHandlerOptions): (req: Request) => Promise<Response> {
  const base = (opts.basePath ?? "").replace(/\/+$/, "");
  const log = opts.solidarity?.log;
  const logPath = log ? new URL(log.descriptor.log).pathname.replace(/\/+$/, "") : undefined;

  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;

    if (req.method === "POST" && path === `${base}/verify`) {
      const body = await readBody(req);
      if (!body) return json(400, { error: "expected {x402Version, paymentPayload, paymentRequirements}" });
      try {
        return json(200, await opts.facilitator.verify(body.paymentPayload, body.paymentRequirements));
      } catch (e) {
        return json(500, { error: (e as Error)?.message ?? "verify failed" });
      }
    }

    if (req.method === "POST" && path === `${base}/settle`) {
      const body = await readBody(req);
      if (!body) return json(400, { error: "expected {x402Version, paymentPayload, paymentRequirements}" });
      let result: SettleResponse;
      try {
        result = await opts.facilitator.settle(body.paymentPayload, body.paymentRequirements);
      } catch (e) {
        // Still a SettleResponse with HTTP 200, so the seller's SDK handles it as a failed settle.
        const message = (e as Error)?.message ?? "settle failed";
        result = { success: false, errorReason: "unexpected_settle_error", errorMessage: message, transaction: "", network: body.paymentRequirements.network } as SettleResponse;
        // No after-settle hook ran: the share gets its purchase-not-final here (afterSettle is total).
        await opts.solidarity?.afterSettle?.({ paymentPayload: body.paymentPayload, requirements: body.paymentRequirements, result });
      }
      const { extensionResponses, ...rest } = result as SettleResponse & { extensionResponses?: Record<string, unknown> };
      const headers: Record<string, string> = {};
      if (extensionResponses && Object.keys(extensionResponses).length > 0) headers["EXTENSION-RESPONSES"] = b64(JSON.stringify(extensionResponses));
      return json(200, rest, headers);
    }

    if (req.method === "GET" && path === `${base}/supported`) {
      return json(200, opts.facilitator.getSupported());
    }

    if (log && logPath !== undefined && req.method === "GET" && (path === logPath || path.startsWith(`${logPath}/`))) {
      const r = log.handle(path.slice(logPath.length));
      return new Response(r.body, { status: r.status, headers: { "content-type": r.contentType } });
    }

    return json(404, { error: "not found" });
  };
}

/** The parts of a node:http IncomingMessage that `fetchRequestFromNode` reads. */
export interface NodeRequestLike extends AsyncIterable<Uint8Array | string> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * A fetch Request for a node:http request, built against a fixed origin such
 * as "https://facilitator.example". The Host header is never used to build the
 * URL: a client-chosen Host such as "facilitator.example/settle?" would
 * otherwise route a request for one path to another, past a proxy that guards
 * /settle or /verify by path. Returns undefined, for a 400, unless the request
 * target is a path ("/...") that URL parsing leaves exactly as sent (no dot
 * segments), so the handler routes on the path the proxy saw.
 */
export async function fetchRequestFromNode(req: NodeRequestLike, origin: string): Promise<Request | undefined> {
  const target = req.url ?? "";
  if (!target.startsWith("/")) return undefined;
  const base = new URL(origin).origin;
  let url: URL;
  try {
    url = new URL(base + target);
  } catch {
    return undefined;
  }
  if (url.origin !== base || url.pathname !== target.split(/[?#]/, 1)[0]) return undefined;
  const method = (req.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.append(k, v);
    else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
  }
  let body: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Uint8Array[] = [];
    for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method, headers, body });
}
