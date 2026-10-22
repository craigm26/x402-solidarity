# Base Sepolia example (testnet only, untested)

This script would sign one `exact` share and submit it to USDC on Base Sepolia, through the same client and log code the offline example uses.

Read this first:

- **Testnet only.** It refuses to run unless the RPC endpoint reports chain 84532 (Base Sepolia).
- **Untested against a live chain.** It has never been run. Every other part of this repository is tested offline against a simulated chain.
- **No fund exists.** Unless you set `FUND_ADDRESS`, the share goes to the placeholder `0x000000000000000000000000000000000000f00d`. Nobody controls that address, so any testnet USDC sent there is gone.
- **No purchase is made.** The share is computed on a notional 10 USDC purchase. A real log processes a share only after the purchase it rides on has settled.
- **One key plays every part.** The same account signs the share as the agent and submits it as the log, so it pays the gas too.

It refuses to start without both variables:

```
PRIVATE_KEY=0x...   a throwaway testnet key holding Base Sepolia ETH and test USDC
RPC_URL=https://... a Base Sepolia RPC endpoint
FUND_ADDRESS=0x...  optional; defaults to the placeholder above
DRY_RUN=1           optional; sign the share and stop before sending anything
```

```
PRIVATE_KEY=0x... RPC_URL=https://... node examples/live-base-sepolia/index.ts
```

USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, EIP-712 domain name `USDC`, version `2`, as listed in the x402 repository (`typescript/packages/mechanisms/evm/src/defaultAssets.ts`). Only `exact` shares are wired up here; `batch-settlement` channels and claims are not.
