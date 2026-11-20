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
| `check_approval`    | Check or wait (≤ 300 s) for your decision; executes the payment if approved            |
| `list_activity`     | The agent's recent payments, requests and denials (read-only)                          |

Results carry both readable text and `structuredContent` (`status`, `txHash`, `requestId`, `reason`). Payments are
serialized, so parallel tool calls can't race the agent's nonce. If the grant names a co-signer, the server fetches
co-signatures automatically.

## Setup

You need a running policy service (`pnpm dev` at the repo root, or `NETWORK=live pnpm dev`, see
[docs/live-guide.md](../../docs/live-guide.md)), and an agent granted in the approver. The agent key below is the
**agent's own throwaway testnet key** (`pnpm demo:setup` generates one): it pays its own gas, and the model never sees it.
Node ≥ 24 runs the TypeScript entry point directly.

**Claude Code**

```sh
claude mcp add cyphos-guard \
  -e CYPHOS_AGENT_PRIVATE_KEY=0x… \
  -e CYPHOS_POLICY_SERVICE_URL=http://127.0.0.1:8787 \
  -e NETWORK=fork \
  -- node /path/to/cyphos-guard/packages/mcp/src/server.ts
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "cyphos-guard": {
      "command": "node",
      "args": ["/path/to/cyphos-guard/packages/mcp/src/server.ts"],
      "env": {
        "CYPHOS_AGENT_PRIVATE_KEY": "0x…",
        "CYPHOS_POLICY_SERVICE_URL": "http://127.0.0.1:8787",
        "NETWORK": "fork"
      }
    }
  }
}
```

Use `NETWORK=live` (and optionally `RPC_URL`) for Base Sepolia.

Then ask your agent something like _"Pay 1.20 USDC to 0x… for this month's API usage"_. Above the limit you'll see the
request in the approver; after you approve, the agent calls `check_approval` and the payment goes through.

## Tests

`pnpm test:fork` includes `src/mcp.fork.test.ts`: a real MCP client against the server on a Base Sepolia fork. It covers
routine ETH and co-signed USDC payments, escalation → approval → `check_approval`, a forbidden payment, activity, and a
smoke test of the stdio binary.
