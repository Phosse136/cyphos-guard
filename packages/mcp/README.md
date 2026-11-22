# @cyphos-guard/mcp

An [MCP](https://modelcontextprotocol.io) server that lets any MCP-capable agent (Claude Code, Claude Desktop and
others) spend from your smart account **under cyphos-guard's rules**. The model can ask to pay anything; cyphos-guard
decides: within limits → paid, above → you approve with your passkey, forbidden → denied.

## Tools

| Tool                | What it does                                                                           |
| ------------------- | -------------------------------------------------------------------------------------- |
| `get_wallet_status` | Account, ETH/USDC balances and the agent's current limits (read-only)                  |
| `pay`               | Pay ETH or USDC with a reason → `paid` · `pending_approval` (+ `requestId`) · `denied` |
| `call_contract`     | Advanced: contract call (calldata, optional ETH) under the same rules                  |
| `fetch_paid_api`    | GET an x402 (HTTP 402) API, paying within the x402 limits; above them you're asked     |
| `check_approval`    | Check or wait (≤ 300 s) for your decision; executes the payment if approved            |
| `list_activity`     | The agent's recent payments, requests and denials (read-only)                          |

Results carry both readable text and `structuredContent` (`status`, `txHash`, `requestId`, `reason`). Payments are
serialized, so parallel tool calls can't race the agent's nonce. If the grant names a co-signer, the server fetches
co-signatures automatically.

## Setup

You need a policy service and an agent granted to your account:

1. **Owner:** sign up at the public testnet instance [app.cyphosguard.com](https://app.cyphosguard.com) with a passkey
   (or self-host, see [docs/live-guide.md](../../docs/live-guide.md)).
2. **Agent key:** `npx @cyphos-guard/cli agent new --env agent.env` creates the **agent's own throwaway testnet key**
   and prints its address. It pays its own gas (send it a little Base Sepolia ETH); the model never sees it.
3. **Grant:** in the app, grant that address an agent permission.

**Claude Code**

```sh
claude mcp add cyphos-guard \
  -e CYPHOS_AGENT_PRIVATE_KEY=0x… \
  -e CYPHOS_POLICY_SERVICE_URL=https://app.cyphosguard.com/api \
  -e NETWORK=live \
  -- npx -y @cyphos-guard/mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "cyphos-guard": {
      "command": "npx",
      "args": ["-y", "@cyphos-guard/mcp"],
      "env": {
        "CYPHOS_AGENT_PRIVATE_KEY": "0x…",
        "CYPHOS_POLICY_SERVICE_URL": "https://app.cyphosguard.com/api",
        "NETWORK": "live"
      }
    }
  }
}
```

For a local fork from a repo checkout (`pnpm dev`), use `CYPHOS_POLICY_SERVICE_URL=http://127.0.0.1:8787`,
`NETWORK=fork` and `node /path/to/cyphos-guard/packages/mcp/src/server.ts` (Node ≥ 24 runs the TypeScript directly).

Then ask your agent something like _"Pay 1.20 USDC to 0x… for this month's API usage"_. Above the limit you'll see the
request in the approver; after you approve, the agent calls `check_approval` and the payment goes through.

## Tests

`pnpm test:fork` includes `src/mcp.fork.test.ts`: a real MCP client against the server on a Base Sepolia fork. It covers
routine ETH and co-signed USDC payments, escalation → approval → `check_approval`, a forbidden payment, activity, and a
smoke test of the stdio binary.
