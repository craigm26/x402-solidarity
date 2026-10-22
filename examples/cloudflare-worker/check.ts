/**
 * Cross-runtime check against the worker in this folder (see worker.ts).
 * Signatures made in workerd must verify in Node, signatures made in Node must
 * verify in workerd, and a tampered signature must fail in both.
 *
 *   node examples/cloudflare-worker/check.ts http://127.0.0.1:8787
 */

import { generateSigningKey, jwsSign, jwsVerify, publicJwk, publicKeyFromJwk } from "../../src/solidarity/index.ts";
import type { PublicJwk } from "../../src/solidarity/index.ts";

const base = process.argv[2];
if (!base) {
  console.error("usage: node examples/cloudflare-worker/check.ts <worker url>");
  process.exit(2);
}

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
};
const tamper = (jws: string) => {
  const [h, p, s] = jws.split(".");
  return `${h}.${p}.${s[0] === "A" ? "B" : "A"}${s.slice(1)}`;
};

const signed = (await (await fetch(new URL("/sign", base))).json()) as { alg: string; jws: string; jwk: PublicJwk; selfVerified: boolean }[] | { error: string };
if (!Array.isArray(signed)) {
  check(`worker /sign: ${signed.error}`, false);
  process.exit(1);
}
for (const s of signed) {
  check(`${s.alg}: signed and self-verified in workerd`, s.selfVerified);
  const key = publicKeyFromJwk(s.jwk);
  check(`${s.alg}: workerd signature verifies in Node`, key !== undefined && jwsVerify(s.jws, key));
  check(`${s.alg}: tampered workerd signature fails in Node`, key !== undefined && !jwsVerify(tamper(s.jws), key));
}

const payload = new TextEncoder().encode(JSON.stringify({ runtime: "node" }));
const fromNode = (["EdDSA", "ES256"] as const).map((alg) => {
  const key = generateSigningKey(alg, `did:web:node.example#${alg}`);
  return { alg, jws: jwsSign(payload, key), jwk: publicJwk(key.publicKey) };
});
const items = [...fromNode, ...fromNode.map((n) => ({ ...n, jws: tamper(n.jws) }))];
const verdicts = (await (await fetch(new URL("/verify", base), { method: "POST", body: JSON.stringify(items) })).json()) as boolean[];
fromNode.forEach((n, i) => {
  check(`${n.alg}: Node signature verifies in workerd`, verdicts[i] === true);
  check(`${n.alg}: tampered Node signature fails in workerd`, verdicts[i + fromNode.length] === false);
});

console.log(failed ? `${failed} failed` : "all ok");
process.exit(failed ? 1 : 0);
