/**
 * MCP server on a Base Sepolia fork: a real MCP client calls the tools; the policy service runs in-process with
 * a co-signer; the owner is a software-passkey account. Plus a stdio smoke test of the actual server binary.
 */
import { resolve } from "node:path";
import { createApp } from "@cyphos-guard/policy-service/app";
import { createChainAdapter } from "@cyphos-guard/policy-service/chain";
import { openStore } from "@cyphos-guard/policy-service/store";
import { setupSoftOwner } from "@cyphos-guard/policy-service/testing";
import { createCyphosGuard } from "@cyphos-guard/sdk";
import { ensureFork } from "@cyphos-guard/sdk/testing";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Chain, createPublicClient, erc20Abi, http, type PublicClient, parseEther, parseUnits, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCyphosGuardMcpServer, USDC } from "./tools.ts";

const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const chain: Chain = baseSepolia;
const SHOP = privateKeyToAddress(generatePrivateKey());
const MIXER = privateKeyToAddress(generatePrivateKey());
const agentKey = generatePrivateKey();
let anvil: Awaited<ReturnType<typeof ensureFork>>;
let service: ReturnType<typeof serve>;
let client: Client;
let owner: Awaited<ReturnType<typeof setupSoftOwner>>["owner"];
let publicClient: PublicClient;

type ToolResult = { content: { type: string; text: string }[]; structuredContent?: Record<string, string> };
const callTool = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as unknown as ToolResult;

beforeAll(async () => {
  anvil = await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
  publicClient = createPublicClient({ chain, transport: http(FORK) });
  const adapter = await createChainAdapter({ rpcUrl: FORK, network: "fork" });
  await adapter.ensureCosignerEnforcer();
  const cosigner = privateKeyToAccount(generatePrivateKey());
  service = serve({
    fetch: createApp({
      store: openStore(":memory:"),
      chain: adapter,
      config: {
        rpId: "localhost",
        rpName: "cyphos-guard",
        origins: ["http://localhost:3000"],
        sessionTtlSeconds: 3600,
        secureCookies: false,
        cosigner,
      },
    }).fetch,
    port: 0,
    hostname: "127.0.0.1",
  });
  await new Promise((r) => service.once("listening", r));
  const sa = service.address();
  const url = `http://127.0.0.1:${typeof sa === "object" && sa ? sa.port : 0}`;

  ({ owner } = await setupSoftOwner({ serviceUrl: url, publicClient }));
  const agent = privateKeyToAccount(agentKey);
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [agent.address, toHex(parseEther("1"))] as never,
  });
  const now = Number((await publicClient.getBlock()).timestamp);
  await owner.grantAgent({
    policy: {
      version: 1,
      chainId: 84532,
      agent: agent.address,
      validFrom: now - 60,
      expiresAt: now + 86_400,
      cosigner: cosigner.address,
      permissions: [
        {
          kind: "nativeTransfer",
          recipients: [SHOP],
          perPeriod: { amount: parseEther("0.001"), periodSeconds: 86_400 },
        },
        {
          kind: "erc20Transfer",
          token: USDC,
          recipients: [SHOP],
          perTx: parseUnits("2", 6),
          perPeriod: { amount: parseUnits("5", 6), periodSeconds: 86_400 },
        },
      ],
      forbidden: { targets: [MIXER] },
    },
  });

  const pw = createCyphosGuard({ policyServiceUrl: url, publicClient, agent });
  const server = createCyphosGuardMcpServer({ pw, publicClient });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientT);
});

afterAll(async () => {
  await client?.close();
  service?.close();
  anvil?.kill();
});

describe("cyphos-guard MCP server (fork)", () => {
  it("exposes the six tools with read-only / destructive hints", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "call_contract",
      "check_approval",
      "fetch_paid_api",
      "get_wallet_status",
      "list_activity",
      "pay",
    ]);
    expect(tools.find((t) => t.name === "pay")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "get_wallet_status")?.annotations?.readOnlyHint).toBe(true);
  });

  it("reports balances and limits", async () => {
    const r = await callTool("get_wallet_status");
    expect(r.content[0]?.text).toMatch(/100 USDC/);
    expect(r.content[0]?.text).toMatch(/max 2 per payment/);
  });

  it("pays within limits (ETH and co-signed USDC)", async () => {
    const eth = await callTool("pay", { to: SHOP, amount: "0.0005", token: "ETH", reason: "GPU credits" });
    expect(eth.structuredContent?.status).toBe("paid");
    const usdc = await callTool("pay", { to: SHOP, amount: "1.5", token: "USDC", reason: "API usage" });
    expect(usdc.structuredContent?.status).toBe("paid");
  });

  it("escalates above the per-payment limit; owner approves; check_approval pays", async () => {
    const big = await callTool("pay", { to: SHOP, amount: "3", token: "USDC", reason: "annual plan" });
    expect(big.structuredContent?.status).toBe("pending_approval");
    expect(big.content[0]?.text).toMatch(/check_approval/);
    const [req] = await owner.getRequests("pending");
    if (!req) throw new Error("no pending request");
    await owner.approve(req);
    const done = await callTool("check_approval", { request_id: big.structuredContent?.requestId, wait_seconds: 30 });
    expect(done.structuredContent?.status).toBe("paid");
    const bal = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [SHOP],
    });
    expect(bal).toBe(parseUnits("4.5", 6));
  });

  it("denies forbidden payments and tells the model not to retry", async () => {
    const r = await callTool("pay", { to: MIXER, amount: "0.0001", token: "ETH", reason: "trust me" });
    expect(r.structuredContent).toMatchObject({ status: "denied", reason: "forbidden" });
    expect(r.content[0]?.text).toMatch(/Do not retry/);
  });

  it("lists activity with decoded amounts", async () => {
    const r = await callTool("list_activity", { limit: 20 });
    expect(r.content[0]?.text).toMatch(/routine_executed 1\.5 USDC → /);
    expect(r.content[0]?.text).toMatch(/request_denied/);
  });
});

describe("stdio server binary", () => {
  it("starts over stdio and lists its tools (as Claude Desktop / Claude Code would)", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [resolve(import.meta.dirname, "server.ts")],
      env: { ...(process.env as Record<string, string>), CYPHOS_AGENT_PRIVATE_KEY: agentKey, NETWORK: "fork" },
      stderr: "ignore",
    });
    const c = new Client({ name: "stdio-test", version: "1.0.0" });
    await c.connect(transport);
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(6);
    await c.close();
  });
});
