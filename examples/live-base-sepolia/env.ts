/**
 * Environment checks for the Base Sepolia example. Kept separate so tests can
 * check the refusal without ever running the script.
 */

export const PLACEHOLDER_FUND = "0x000000000000000000000000000000000000f00d";

export type LiveEnv =
  | { ok: false; message: string }
  | { ok: true; privateKey: `0x${string}`; rpcUrl: string; fundAddress: `0x${string}`; dryRun: boolean; placeholderFund: boolean };

export function checkEnv(env: Record<string, string | undefined>): LiveEnv {
  const missing = ["PRIVATE_KEY", "RPC_URL"].filter((k) => !env[k]);
  if (missing.length) {
    return {
      ok: false,
      message:
        `Refusing to run: set ${missing.join(" and ")}. This script settles on Base Sepolia (a testnet) only. ` +
        "It has not been run against a live chain. No fund exists; the default fund address is a placeholder.",
    };
  }
  const pk = env.PRIVATE_KEY as string;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return { ok: false, message: "Refusing to run: PRIVATE_KEY must be 0x followed by 64 hex digits." };
  const rpcUrl = env.RPC_URL as string;
  if (!/^https?:\/\//.test(rpcUrl)) return { ok: false, message: "Refusing to run: RPC_URL must be an http(s) URL." };
  const fund = env.FUND_ADDRESS ?? PLACEHOLDER_FUND;
  if (!/^0x[0-9a-fA-F]{40}$/.test(fund)) return { ok: false, message: "Refusing to run: FUND_ADDRESS must be an EVM address." };
  return {
    ok: true,
    privateKey: pk as `0x${string}`,
    rpcUrl,
    fundAddress: fund as `0x${string}`,
    dryRun: env.DRY_RUN === "1",
    placeholderFund: fund.toLowerCase() === PLACEHOLDER_FUND,
  };
}
