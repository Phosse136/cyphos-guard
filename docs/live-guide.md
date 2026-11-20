# Running cyphos-guard on live Base Sepolia

Everything defaults to a local fork. To run on the real Base Sepolia testnet:

## 1. Configure `.env`

```sh
NETWORK=live
RPC_URL=https://sepolia.base.org                          # or your own Base Sepolia endpoint
NEXT_PUBLIC_BUNDLER_URL=https://public.pimlico.io/v2/84532/rpc   # public ERC-4337 bundler, no key needed
COSIGNER_PRIVATE_KEY=0x…                                  # optional: enables the co-signer (ADR 0005)
```

For a co-signer key, generate a fresh throwaway key (e.g. `cast wallet new`); never reuse a key that has held
funds. The CosignerEnforcer is already deployed on Base Sepolia at `0x0a2f40e9789235B6ce2a23668FD3F90cef5eefbf`.
On another chain, deploy it once with `pnpm contracts:deploy`.

## 2. Start

```sh
pnpm --filter @cyphos-guard/approver build   # one build works for fork and live (targets are read at runtime)
NETWORK=live pnpm dev                        # policy service + approver, no fork
```

Open http://localhost:3000. Use `localhost`, because the passkey is bound to that hostname.

## 3. Onboard

1. **Create passkey.**
2. The approver shows your **account address** and its live balance. Send it at least 0.0003 test ETH (more if your
   agent will pay with it) from your wallet or a faucet:
   [Coinbase CDP](https://portal.cdp.coinbase.com/products/faucet) or [Superchain](https://console.optimism.io/faucet).
   If you add a recovery address, do that **before** funding: it changes the account address.
3. **Create account.** Your passkey signs the deployment; the public bundler submits it, paid from the account's balance.
4. **Grant an agent.** The agent needs a little test ETH in its **own** address for gas.

## What runs where on live

| Action                     | Path                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| Account deployment, revoke | passkey-signed userOp → public bundler (`NEXT_PUBLIC_BUNDLER_URL`) |
| Grants, approvals          | passkey signatures only (no transaction)                           |
| Agent payments             | plain transactions from the agent's own key                        |
| Co-signing                 | policy service key, checked on-chain by the CosignerEnforcer       |

The fork-only dev relay and `/dev/fund` don't exist on live.

## Verified

`pnpm --filter @cyphos-guard/approver e2e:live` drives exactly this flow in Chromium with a virtual passkey against live
Base Sepolia. The results from 2026-11-20 are in the README's "Verified on Base Sepolia" section.
