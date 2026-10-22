/**
 * Cloudflare Workers check: JWS signing and verification (EdDSA and ES256)
 * inside workerd, through the package's public exports.
 *
 * GET  /sign    signs with a fresh key per alg and returns {alg, jws, jwk, selfVerified}
 * POST /verify  takes [{jws, jwk}] signed elsewhere and returns [true|false]
 *
 * Run with `npx wrangler dev` in this folder, then `node check.ts <url>`.
 */

import { generateSigningKey, jwsSign, jwsVerify, publicJwk, publicKeyFromJwk } from "../../src/solidarity/index.ts";
import type { PublicJwk } from "../../src/solidarity/index.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/sign") {
        const payload = new TextEncoder().encode(JSON.stringify({ runtime: "workerd" }));
        return json(
          (["EdDSA", "ES256"] as const).map((alg) => {
            const key = generateSigningKey(alg, `did:web:worker.example#${alg}`);
            const jws = jwsSign(payload, key);
            return { alg, jws, jwk: publicJwk(key.publicKey), selfVerified: jwsVerify(jws, key.publicKey) };
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/verify") {
        const items = (await request.json()) as { jws: string; jwk: PublicJwk }[];
        return json(items.map(({ jws, jwk }) => {
          const key = publicKeyFromJwk(jwk);
          return key !== undefined && jwsVerify(jws, key);
        }));
      }
      return json({ error: "GET /sign or POST /verify" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, 500);
    }
  },
};
