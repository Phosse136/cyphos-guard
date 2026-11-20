#!/usr/bin/env node
/**
 * cyphos-guard MCP server over stdio.
 *
 *   CYPHOS_AGENT_PRIVATE_KEY   the agent's own key (throwaway, testnet; it pays its own gas)   required
 *   CYPHOS_POLICY_SERVICE_URL  policy service                         default http://127.0.0.1:8787
 *   NETWORK                    fork | live                            default fork
 *   RPC_URL / FORK_RPC_URL     Base Sepolia RPC / local fork RPC
 *
 * stdout is the MCP channel: log to stderr only.
 */
import { createCyphosGuard } from "@cyphos-guard/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type Chain, createPublicClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createCyphosGuardMcpServer } from "./tools.ts";

const key = process.env.CYPHOS_AGENT_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("cyphos-guard MCP: set CYPHOS_AGENT_PRIVATE_KEY (0x + 64 hex) to the agent's throwaway testnet key");
  process.exit(1);
}
const live = (process.env.NETWORK ?? "fork") === "live";
const rpcUrl = live
  ? (process.env.RPC_URL ?? "https://sepolia.base.org")
  : (process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545");
const chain: Chain = baseSepolia;
const publicClient: PublicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 3 }) });
const pw = createCyphosGuard({
  policyServiceUrl: process.env.CYPHOS_POLICY_SERVICE_URL ?? "http://127.0.0.1:8787",
  publicClient,
  rpcUrl,
  agent: privateKeyToAccount(key as `0x${string}`),
  logger: { warn: (msg, data) => console.error(`[cyphos-guard] ${msg}`, data ?? "") },
});

const server = createCyphosGuardMcpServer({ pw, publicClient, live });
await server.connect(new StdioServerTransport());
console.error(
  `cyphos-guard MCP server ready (${live ? "Base Sepolia" : "local fork"}, agent ${privateKeyToAccount(key as `0x${string}`).address})`,
);
