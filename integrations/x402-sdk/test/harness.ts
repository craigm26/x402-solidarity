/**
 * Test harness: the real x402 SDK classes (x402Client through @x402/fetch,
 * x402HTTPResourceServer, x402Facilitator with @x402/evm's ExactEvmScheme)
 * in one Node process, with no sockets and no network.
 *
 * SIMULATED: SimulatedChain (src/sim/chain.ts) stands in for Base Sepolia
 * behind a FacilitatorEvmSigner adapter. Keys are throwaway, the fund address
 * is a placeholder (no fund exists), and nothing is sent anywhere.
 */

import { mock } from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAddress, serializeSignature, verifyTypedData } from "viem";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import type { ClientExtension } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient, HTTPAdapter, RoutesConfig } from "@x402/core/server";
import type { SettleResponse } from "@x402/core/types";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { ExactEvmScheme as ExactEvmFacilitator } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ExactEvmServer } from "@x402/evm/exact/server";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { SimulatedChain } from "../../../src/sim/chain.ts";
import { BASE_SEPOLIA, CapCounter, declareSolidarityExtension, generateSigningKey, readOutcome, SolidarityLog, USDC_BASE_SEPOLIA, verifyEip3009Signature } from "../../../src/solidarity/index.ts";
import type { ExactEip3009Payload, LogDescriptor, OwnerPolicy, ShareDecision, SigningKey, SolidarityOutcome } from "../../../src/solidarity/index.ts";
import { solidarityClientExtension } from "../src/client.ts";
import type { SolidarityClientOptions } from "../src/client.ts";
import { createDescriptorCache } from "../src/descriptors.ts";
import { attachSolidarity } from "../src/facilitator.ts";
import type { SolidarityFacilitator } from "../src/facilitator.ts";
import { facilitatorLogChain } from "../src/logChain.ts";
import { solidarityServerExtension } from "../src/resourceServer.ts";
import type { SolidarityServerOptions } from "../src/resourceServer.ts";

export const NET = BASE_SEPOLIA;
export const USDC = USDC_BASE_SEPOLIA.address as Hex;
export const LOG = "https://facilitator.example/solidarity";
/** Placeholders: no fund exists. */
export const FUND_ADDR = "0x000000000000000000000000000000000000f00d";
export const FUND = `${NET}:${FUND_ADDR}`;
export const OTHER_FUND_ADDR = "0x000000000000000000000000000000000000beef";
export const OTHER_FUND = `${NET}:${OTHER_FUND_ADDR}`;
/** The log's batch-settlement receiverAuthorizer, a placeholder address. */
export const AUTHORIZER = "0x3333333333333333333333333333333333333333";
/** 2026-10-22T12:00:00Z, the simulated clock's start. */
export const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
export const PRICE = "$0.50";
export const PRICE_ATOMIC = 500_000n;

// ---- clock ---------------------------------------------------------------------------

/**
 * The SDK reads Date.now() directly (the client's EIP-3009 window, the
 * facilitator's verify, the asset cache), and so does the log's default clock.
 * Only Date is mocked; setTimeout stays real.
 */
export function useSimulatedTime(ms = T0): void {
  mock.timers.enable({ apis: ["Date"], now: ms });
}
export function setSimulatedTime(ms: number): void {
  mock.timers.setTime(ms);
}
export function resetTime(): void {
  mock.timers.reset();
}
const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---- the facilitator's signer over SimulatedChain ----------------------------------------

const transferEvent = [
  { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] },
] as const;

export interface SimulatedSigner extends FacilitatorEvmSigner {
  readonly address: Hex;
  /** Every call, by method and function name. */
  readonly calls: string[];
  /** Every transfer executed through writeContract, in order. */
  readonly writes: Array<{ tx: string; token: string; from: string; to: string; value: bigint }>;
  /** The next n receipt waits time out, so the scheme reports settlement_pending. */
  failNextReceipt(n?: number): void;
  /** The next writeContract reverts with this message (a failed purchase settle). */
  revertNextWrite(message?: string): void;
}

/**
 * A FacilitatorEvmSigner over SimulatedChain, enough for ExactEvmScheme's
 * EIP-3009 verify and settle. Not modelled: Permit2, upto, batch-settlement
 * purchases, ERC-6492 deployment (sendTransaction throws) and the multicall
 * diagnosis after a failed simulation (it falls back to simulation_failed).
 */
export function simulatedFacilitatorSigner(chain: SimulatedChain, opts: { tokens?: Record<string, { name: string; version: string }> } = {}): SimulatedSigner {
  const tokens: Record<string, { name: string; version: string }> = {};
  for (const [k, v] of Object.entries(opts.tokens ?? { [USDC]: { name: "USDC", version: "2" } })) tokens[k.toLowerCase()] = v;
  const address = privateKeyToAccount(generatePrivateKey()).address;
  const calls: string[] = [];
  const writes: SimulatedSigner["writes"] = [];
  const executed = new Map<string, { token: Hex; from: Hex; to: Hex; value: bigint }>();
  let failReceipts = 0;
  let revert: string | undefined;
  const sync = () => {
    chain.now = nowSeconds();
  };

  const decode = (token: string, args: readonly unknown[]) => {
    const domain = tokens[token.toLowerCase()];
    if (!domain) throw new Error(`not modelled: token ${token}`);
    const [from, to, value, validAfter, validBefore, nonce, ...sig] = args as [Hex, Hex, bigint, bigint, bigint, Hex, ...unknown[]];
    let signature: Hex;
    if (sig.length === 1) signature = sig[0] as Hex;
    else {
      const [v, r, s] = sig as [bigint | number, Hex, Hex];
      signature = Number(v) >= 27 ? serializeSignature({ r, s, v: BigInt(v) }) : serializeSignature({ r, s, yParity: Number(v) });
    }
    const req = { scheme: "exact", network: chain.network, amount: value.toString(), asset: getAddress(token), payTo: to, maxTimeoutSeconds: 0, extra: { ...domain } };
    const payload: ExactEip3009Payload = { signature, authorization: { from, to, value: value.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce } };
    return { req, payload };
  };

  return {
    address,
    calls,
    writes,
    failNextReceipt(n = 1) {
      failReceipts = n;
    },
    revertNextWrite(message = "simulated revert") {
      revert = message;
    },
    getAddresses: () => [address],
    async getCode({ address: a }) {
      calls.push("getCode");
      return tokens[a.toLowerCase()] ? "0x6001" : "0x";
    },
    // verify's simulation: a dry run against SimulatedChain's public state, failing with the
    // chain's own messages (which the SDK's parseEip3009TransferError understands).
    async readContract({ address: a, functionName, args }) {
      calls.push(`readContract ${functionName}`);
      sync();
      if (functionName !== "transferWithAuthorization") throw new Error(`not modelled: ${functionName}`);
      const { req, payload } = decode(a, args ?? []);
      const auth = payload.authorization;
      if (!(await verifyEip3009Signature(req, payload))) throw new Error("invalid signature");
      if (!(BigInt(chain.now) > BigInt(auth.validAfter))) throw new Error("authorization is not yet valid");
      if (!(BigInt(chain.now) < BigInt(auth.validBefore))) throw new Error("authorization is expired");
      if (chain.authorizationState(a, auth.from, auth.nonce)) throw new Error("authorization is used or canceled");
      if (chain.balanceOf(a, auth.from) < BigInt(auth.value)) throw new Error("transfer amount exceeds balance");
      return undefined;
    },
    verifyTypedData: (p) => verifyTypedData(p as Parameters<typeof verifyTypedData>[0]),
    async writeContract({ address: a, functionName, args }) {
      calls.push(`writeContract ${functionName}`);
      sync();
      if (revert !== undefined) {
        const m = revert;
        revert = undefined;
        throw new Error(m);
      }
      if (functionName !== "transferWithAuthorization") throw new Error(`not modelled: ${functionName}`);
      const { req, payload } = decode(a, args);
      const r = await chain.transferWithAuthorization(req, payload);
      if (!r.ok) throw new Error(r.error);
      const auth = payload.authorization;
      const t = { token: getAddress(a), from: getAddress(auth.from), to: getAddress(auth.to), value: BigInt(auth.value) };
      executed.set(r.transaction, t);
      writes.push({ tx: r.transaction, ...t });
      return r.transaction as Hex;
    },
    async sendTransaction() {
      calls.push("sendTransaction");
      throw new Error("not modelled: ERC-6492 deployment");
    },
    async waitForTransactionReceipt({ hash }) {
      calls.push("waitForTransactionReceipt");
      if (failReceipts > 0) {
        failReceipts -= 1;
        throw new Error("simulated receipt timeout");
      }
      const t = executed.get(hash);
      if (!t) throw new Error("unknown transaction");
      const topics = encodeEventTopics({ abi: transferEvent, eventName: "Transfer", args: { from: t.from, to: t.to } });
      const data = encodeAbiParameters([{ type: "uint256" }], [t.value]);
      return {
        status: "success",
        logs: [{ address: t.token, topics, data, blockNumber: 1n, transactionHash: hash, logIndex: 0, blockHash: hash, transactionIndex: 0, removed: false }] as never,
      };
    },
  };
}

// ---- fixtures ---------------------------------------------------------------------------

export function makePolicy(over: Partial<OwnerPolicy> = {}): OwnerPolicy {
  return { version: 2, rate: "0.001", cap: { amount: "5000000", asset: USDC.toLowerCase() }, fund: FUND, logs: [LOG], refunds: "keep", since: "2026-10-01T00:00:00Z", ...over };
}

export function makeDescriptor(kid: string, over: Partial<LogDescriptor> = {}): LogDescriptor {
  return {
    version: 2,
    log: LOG,
    funds: [FUND],
    accepts: [
      { network: NET, asset: USDC.toLowerCase(), scheme: "exact", maxTimeoutSeconds: 60, minAmount: "100", extra: { name: "USDC", version: "2" } },
      { network: NET, asset: USDC.toLowerCase(), scheme: "batch-settlement", maxTimeoutSeconds: 60, extra: { receiverAuthorizer: AUTHORIZER, withdrawDelay: 86400, name: "USDC", version: "2" } },
    ],
    keys: [{ kid, from: "2026-10", until: null }],
    ...over,
  };
}

/** In-process FacilitatorClient with a JSON round trip each way, as on the wire. */
export function inProcessFacilitatorClient(f: x402Facilitator, record?: { settles: SettleResponse[] }): FacilitatorClient {
  const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  return {
    verify: async (p, r) => wire(await f.verify(wire(p), wire(r))),
    settle: async (p, r) => {
      const res = wire(await f.settle(wire(p), wire(r)));
      record?.settles.push(wire(res));
      return res;
    },
    getSupported: async () => wire(f.getSupported()) as Awaited<ReturnType<FacilitatorClient["getSupported"]>>,
  };
}

/** A seller app, (Request) => Response, over x402HTTPResourceServer. */
export function sellerApp(http: x402HTTPResourceServer): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url);
    const adapter: HTTPAdapter = {
      getHeader: (n) => req.headers.get(n) ?? undefined,
      getMethod: () => req.method,
      getPath: () => url.pathname,
      getUrl: () => req.url,
      getAcceptHeader: () => req.headers.get("accept") ?? "",
      getUserAgent: () => req.headers.get("user-agent") ?? "",
    };
    const ctx = { adapter, path: url.pathname, method: req.method };
    const result = await http.processHTTPRequest(ctx);
    if (result.type === "no-payment-required") return new Response("free", { status: 200 });
    if (result.type === "payment-error") {
      return new Response(JSON.stringify(result.response.body ?? {}), { status: result.response.status, headers: result.response.headers as Record<string, string> });
    }
    const settled = await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: ctx });
    if (!settled.success) {
      return new Response(JSON.stringify(settled.response.body ?? {}), { status: settled.response.status, headers: { ...settled.headers, ...(settled.response.headers as Record<string, string>) } });
    }
    return new Response(JSON.stringify({ report: "ok" }), { status: 200, headers: { "content-type": "application/json", ...settled.headers } });
  };
}

// ---- a whole world ----------------------------------------------------------------------

export interface WorldOptions {
  /** Attach the kit to the facilitator (default true). */
  kitFacilitator?: boolean;
  /** The seller declares solidarity on its route (default true). */
  sellerDeclares?: boolean;
  /** Register solidarityServerExtension with these options (default {}), or not at all (false). */
  sellerExtension?: SolidarityServerOptions | false;
  /** Replace the route's extensions. */
  routeExtensions?: Record<string, unknown>;
  /** The buyer registers the kit's client extension (default true). */
  buyerKit?: boolean;
  clientOptions?: Partial<SolidarityClientOptions>;
  /** Client extensions registered after the kit's (for tampering tests). */
  extraClientExtensions?: ClientExtension[];
  policy?: Partial<OwnerPolicy>;
  /** The facilitator's descriptor overrides. */
  descriptor?: Partial<LogDescriptor>;
  /** What the client has cached (default: the facilitator's descriptor). */
  clientDescriptors?: LogDescriptor[];
  buyerKey?: Hex;
  sellerAddress?: Hex;
  price?: string;
  /** Build the seller's FacilitatorClient (default: in-process with a JSON round trip). */
  facilitatorClient?: (parts: { facilitator: x402Facilitator; solidarity?: SolidarityFacilitator }) => FacilitatorClient;
}

export interface BuyResult {
  status: number;
  body: string;
  /** The decoded PAYMENT-RESPONSE header, when present. */
  paymentResponse?: SettleResponse & { extensionResponses?: unknown };
  outcome?: SolidarityOutcome;
}

export async function makeWorld(opts: WorldOptions = {}) {
  const chain = new SimulatedChain({ network: NET, now: nowSeconds() });
  const signer = simulatedFacilitatorSigner(chain);
  const exact = new ExactEvmFacilitator(signer);
  const facilitator = new x402Facilitator();
  facilitator.register(NET, exact);

  const logKey: SigningKey = generateSigningKey("EdDSA", "did:web:facilitator.example#solidarity-1");
  const descriptor = makeDescriptor(logKey.kid, opts.descriptor);
  const log = new SolidarityLog({ descriptor, key: logKey, chain: facilitatorLogChain(exact, { fallback: chain }) });
  const facilitatorErrors: Array<{ error: unknown; where: string }> = [];
  const solidarity = opts.kitFacilitator === false ? undefined : attachSolidarity(facilitator, { log, onError: (error, where) => facilitatorErrors.push({ error, where }) });

  const record = { settles: [] as SettleResponse[] };
  const facilitatorClient = opts.facilitatorClient ? opts.facilitatorClient({ facilitator, solidarity }) : inProcessFacilitatorClient(facilitator, record);

  // Seller.
  const sellerAddress = opts.sellerAddress ?? privateKeyToAccount(generatePrivateKey()).address;
  const server = new x402ResourceServer(facilitatorClient);
  server.register(NET, new ExactEvmServer());
  if (opts.sellerExtension !== false) server.registerExtension(solidarityServerExtension({ ...(opts.sellerExtension ?? {}) }));
  const sellerSaw: unknown[] = [];
  server.onAfterSettle(async (ctx) => {
    sellerSaw.push((ctx.result as SettleResponse & { extensionResponses?: unknown }).extensionResponses);
  });
  const extensions = opts.routeExtensions ?? (opts.sellerDeclares === false ? undefined : { solidarity: declareSolidarityExtension([{ network: NET, scheme: "exact", log: LOG }]) });
  const routes: RoutesConfig = {
    "GET /report": {
      accepts: { scheme: "exact", network: NET, payTo: sellerAddress, price: opts.price ?? PRICE, maxTimeoutSeconds: 60 },
      description: "a simulated report",
      ...(extensions ? { extensions } : {}),
    },
  };
  const http = new x402HTTPResourceServer(server, routes);
  await http.initialize();
  const app = sellerApp(http);

  // Buyer.
  const account = privateKeyToAccount(opts.buyerKey ?? generatePrivateKey());
  chain.mint(USDC, account.address, 10_000_000n);
  const policy = makePolicy(opts.policy);
  const counter = new CapCounter(policy);
  const descriptors = createDescriptorCache({ preload: opts.clientDescriptors ?? [descriptor] });
  const decisions: ShareDecision[] = [];
  const outcomes: Array<SolidarityOutcome | undefined> = [];
  const clientErrors: unknown[] = [];
  const client = new x402Client();
  client.register(NET, new ExactEvmClient(account));
  if (opts.buyerKit !== false) {
    client.registerExtension(
      solidarityClientExtension({
        policy,
        counter,
        signer: account,
        descriptors,
        onDecision: (d) => decisions.push(d),
        onOutcome: (o) => outcomes.push(o),
        onError: (e) => clientErrors.push(e),
        ...opts.clientOptions,
      }),
    );
  }
  for (const e of opts.extraClientExtensions ?? []) client.registerExtension(e);
  const pay = wrapFetchWithPayment((input: string | URL | Request, init?: RequestInit) => app(new Request(input, init)), client);

  async function buy(path = "/report"): Promise<BuyResult> {
    const res = await pay(`https://books.example${path}`);
    const header = res.headers.get("PAYMENT-RESPONSE");
    const paymentResponse = header ? (decodePaymentResponseHeader(header) as BuyResult["paymentResponse"]) : undefined;
    return { status: res.status, body: await res.text(), paymentResponse, outcome: paymentResponse ? readOutcome(paymentResponse as { extensions?: Record<string, unknown> }) : undefined };
  }

  const fundBalance = () => chain.balanceOf(USDC, FUND_ADDR);
  const balanceOf = (a: string) => chain.balanceOf(USDC, a);

  return {
    chain,
    signer,
    exact,
    facilitator,
    log,
    logKey,
    descriptor,
    solidarity,
    facilitatorErrors,
    facilitatorClient,
    settles: record.settles,
    server,
    http,
    app,
    sellerAddress,
    sellerSaw,
    account,
    client,
    policy,
    counter,
    descriptors,
    decisions,
    outcomes,
    clientErrors,
    pay,
    buy,
    fundBalance,
    balanceOf,
  };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

/** The seven fields x402 treats as the facilitator's own, as JSON, for byte comparison. */
export function coreBytes(r: Partial<SettleResponse> | undefined): string {
  const x = (r ?? {}) as Record<string, unknown>;
  return JSON.stringify(["success", "transaction", "network", "amount", "payer", "errorReason", "errorMessage"].map((k) => [k, x[k] ?? null]));
}

/** The share id the buyer attached in its last decision. */
export function lastShareId(w: World): string | undefined {
  const d = [...w.decisions].reverse().find((x) => x.attached);
  return d && d.attached ? (d.info.id as string) : undefined;
}
