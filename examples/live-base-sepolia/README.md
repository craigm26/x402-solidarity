# Base Sepolia example (testnet only)

This script signs a 1 USDC `exact` purchase and its share, settles the purchase, and then hands the share to the same log code the offline example uses, which settles it on Base Sepolia.

Read this first:

- **Testnet only.** It refuses to run unless the RPC endpoint reports chain 84532 (Base Sepolia).
- **Checked against the deployed contract, not yet broadcast.** `SIMULATE=1` runs both transfers against the USDC contract deployed on Base Sepolia with `eth_call` (see below). That passed on 2026-10-22, and `test/live.test.ts` repeats it along with five ways it must fail. No transaction has been sent yet.
- **No fund exists.** Unless you set `FUND_ADDRESS`, the share goes to the placeholder `0x000000000000000000000000000000000000f00d`. Nobody controls that address, so any testnet USDC sent there is gone.
- **The purchase is real but goes to yourself.** It pays 1 USDC to `SELLER_ADDRESS`, which defaults to the key's own address, so it comes back. The share is 0.1% of it, 1000 atomic units (0.001 USDC), and the log handles it only after the purchase settles.
- **One key plays the agent.** The same throwaway key signs the purchase and the share.

## Modes

| Set | What happens | Needs |
| --- | --- | --- |
| `SIMULATE=1` | Signs both with a throwaway key and runs each `transferWithAuthorization` against the deployed USDC contract with `eth_call`, with a state override that gives the payer exactly the amount. Sends nothing. | `RPC_URL` only |
| `DRY_RUN=1` | Signs both and stops. | `PRIVATE_KEY`, `RPC_URL` |
| `FACILITATOR_URL` | Settles both through that x402 facilitator's `POST /settle`, which submits the transactions and pays the gas. | `PRIVATE_KEY` holding at least 1.001 test USDC, `RPC_URL` |
| none of these | Submits both from the key's own account. | `PRIVATE_KEY` holding test USDC and Base Sepolia ETH for gas, `RPC_URL` |

```
SIMULATE=1 RPC_URL=https://sepolia.base.org node examples/live-base-sepolia/index.ts

PRIVATE_KEY=0x... RPC_URL=https://sepolia.base.org \
  FACILITATOR_URL=https://x402.org/facilitator node examples/live-base-sepolia/index.ts
```

Optional: `FUND_ADDRESS` (defaults to the placeholder above) and `SELLER_ADDRESS` (defaults to the key's address).

The share's payment is an ordinary x402 `exact` payment whose `payTo` is the fund. So the log can hand it to any facilitator that lists `exact` on `eip155:84532` in `/supported`, with `paymentPayload = {x402Version: 2, accepted, payload}` and `paymentRequirements = accepted` (`facilitatorChain.ts`). The public facilitator at `https://x402.org/facilitator` lists it. Asked to `/verify` an unfunded share and purchase on 2026-10-22, it ran the transfer and refused each one with `invalid_exact_evm_insufficient_balance`, the check that comes after the signature, domain, recipient and time window.

## How SIMULATE checks the transfer

`simulate.ts` writes the payer's balance into USDC's storage for the length of one `eth_call`. FiatToken keeps balances in a mapping at slot 9, so the payer's entry is at `keccak256(abi.encode(payer, 9))`. It then reads `balanceOf` under the same override and stops if the value didn't take, so a wrong slot can't pass. It also checks with `authorizationState` that the nonce is unused, and then simulates `transferWithAuthorization`. That runs the contract's own signature recovery, EIP-712 domain, nonce and time-window checks, and the balance check. The test runs it against the deployed contract when `BASE_SEPOLIA_RPC_URL` is set. A good share must pass. A payer one unit short, a tampered amount, domain version `1` and an expired window must each fail.

USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, EIP-712 domain name `USDC`, version `2`, as listed in the x402 repository (`typescript/packages/mechanisms/evm/src/defaultAssets.ts`). Only `exact` shares are wired up here; `batch-settlement` channels and claims are not.
