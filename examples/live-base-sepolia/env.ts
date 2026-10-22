/**
 * Environment checks for the Base Sepolia example. Kept separate so tests can
 * check the refusal without ever running the script.
 */

export const PLACEHOLDER_FUND = "0x000000000000000000000000000000000000f00d";

export type LiveEnv =
  | { ok: false; message: string }
  | {
      ok: true;
      /** Absent only with SIMULATE=1, which then signs with a throwaway key. */
      privateKey: `0x${string}` | undefined;
      rpcUrl: string;
      fundAddress: `0x${string}`;
      sellerAddress: `0x${string}` | undefined;
      facilitatorUrl: string | undefined;
      dryRun: boolean;
      simulate: boolean;
      placeholderFund: boolean;
    };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function checkEnv(env: Record<string, string | undefined>): LiveEnv {
  const simulate = env.SIMULATE === "1";
  const dryRun = env.DRY_RUN === "1";
  if (simulate && dryRun) return { ok: false, message: "Refusing to run: set DRY_RUN=1 or SIMULATE=1, not both." };
  const missing = (simulate ? ["RPC_URL"] : ["PRIVATE_KEY", "RPC_URL"]).filter((k) => !env[k]);
  if (missing.length) {
    return {
      ok: false,
      message:
        `Refusing to run: set ${missing.join(" and ")}. This script settles on Base Sepolia (a testnet) only. ` +
        "No fund exists; the default fund address is a placeholder.",
    };
  }
  const pk = env.PRIVATE_KEY;
  if (pk !== undefined && pk !== "" && !/^0x[0-9a-fA-F]{64}$/.test(pk)) return { ok: false, message: "Refusing to run: PRIVATE_KEY must be 0x followed by 64 hex digits." };
  const rpcUrl = env.RPC_URL as string;
  if (!/^https?:\/\//.test(rpcUrl)) return { ok: false, message: "Refusing to run: RPC_URL must be an http(s) URL." };
  const fund = env.FUND_ADDRESS ?? PLACEHOLDER_FUND;
  if (!ADDRESS.test(fund)) return { ok: false, message: "Refusing to run: FUND_ADDRESS must be an EVM address." };
  const seller = env.SELLER_ADDRESS;
  if (seller !== undefined && !ADDRESS.test(seller)) return { ok: false, message: "Refusing to run: SELLER_ADDRESS must be an EVM address." };
  const facilitatorUrl = env.FACILITATOR_URL;
  if (facilitatorUrl !== undefined && !/^https?:\/\//.test(facilitatorUrl)) return { ok: false, message: "Refusing to run: FACILITATOR_URL must be an http(s) URL." };
  return {
    ok: true,
    privateKey: pk ? (pk as `0x${string}`) : undefined,
    rpcUrl,
    fundAddress: fund as `0x${string}`,
    sellerAddress: seller as `0x${string}` | undefined,
    facilitatorUrl,
    dryRun,
    simulate,
    placeholderFund: fund.toLowerCase() === PLACEHOLDER_FUND,
  };
}
