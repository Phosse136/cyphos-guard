# demo-agent

A Claude accounts-payable agent that pays its owner's AI-infrastructure invoices through cyphos-guard. One run
shows all three layers:

| Invoice                               | Amount     | What happens                                                                                         |
| ------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| INV-1041 Inference API, monthly usage | 1.20 USDC  | **Routine.** Within limits, paid by the agent alone                                                  |
| INV-1042 GPU spot credits             | 0.0005 ETH | **Routine.** Within limits, paid by the agent alone                                                  |
| INV-1043 Inference API, annual prepay | 4.00 USDC  | **Big.** Above the 2 USDC per-payment limit, so the owner approves with a passkey and the agent pays |
| INV-1044 "DataHarvest" dataset fee    | 0.0003 ETH | **Forbidden.** The vendor is on the owner's denylist; the agent tries and cyphos-guard blocks it     |

The agent doesn't know the denylist or the limits. It just calls `pay`, and cyphos-guard decides.

## Run it with your own passkey (local fork)

```sh
# .env: ANTHROPIC_API_KEY=...   (Claude API key)
pnpm dev                 # terminal 1: fork + policy service + approver
#   → http://localhost:3000: create passkey, create account (the fork funds it with ETH + test USDC)
pnpm demo:setup          # terminal 2: agent key + gas, prints a link that prefills the grant
#   → open the link, check the values, "Grant (sign with passkey)"
pnpm demo:agent          # Claude pays the invoices; approve INV-1043 in the approver when it appears
```

## Headless checks

```sh
pnpm demo:selftest                # real Claude, scripted owner who approves INV-1043 only
pnpm demo:selftest --fake-model   # no API key needed: scripted stand-in for the Messages API
pnpm e2e:demo                     # the interactive flow above in Chromium (virtual passkey), scripted model
```

`--fake-model` replays a fixed tool-call script against the real SDK tool runner, tools and wallet stack. It
proves the wiring, not Claude's judgement. The checks are on-chain balances, so they hold however the model phrases things.

## How it's built

- `agent.ts`: Messages API tool runner (`client.beta.messages.toolRunner`, `claude-opus-5-5`, effort `medium`,
  server-side refusal fallbacks `fallbacks: "default"`). The tool runner uses message threads, so only new
  messages are sent each turn. Tools run in this process; the agent key never leaves it.
- `tools.ts`: `list_invoices`, `get_balances`, `pay`, `wait_for_approval` on top of `@cyphos-guard/sdk`. Typed SDK
  errors become short status strings for the model (`PAID`, `PENDING_APPROVAL`, `DENIED`). Payments are
  serialized, because the tool runner executes parallel tool calls concurrently and they share one EOA nonce.
- `scenario.ts`: invoices, vendor addresses (derived from fixed labels) and the demo policy.
