/**
 * cyphos-guard MCP server: lets any MCP-capable agent (Claude Desktop, Claude Code, …) spend from its owner's
 * smart account under cyphos-guard's three layers. The model can ASK to pay anything; cyphos-guard decides:
 * within limits → paid; above → the owner approves with a passkey; forbidden → denied.
 *
 * The agent's private key lives in this server process only (env); it is never part of any tool result.
 */
import {
  ApprovalExpired,
  ApprovalPending,
  ApprovalRejected,
  type CyphosGuard,
  ExecutionFailed,
  type ExecutionResult,
  PolicyServiceError,
  PolicyViolation,
} from "@cyphos-guard/sdk";
import { decodeErc20Transfer, parsePolicy } from "@cyphos-guard/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  type Hex,
  isAddress,
  isAddressEqual,
  type PublicClient,
  parseEther,
  parseUnits,
} from "viem";
import { z } from "zod";

/** Circle's test USDC on Base Sepolia. */
export const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export type ServerOptions = {
  pw: CyphosGuard;
  publicClient: PublicClient;
  /** Basescan links in results (live) or bare hashes (fork). */
  live?: boolean;
};

const outcomeShape = {
  status: z.enum(["paid", "pending_approval", "denied", "rejected", "expired", "failed"]),
  txHash: z.string().optional(),
  requestId: z.string().optional(),
  reason: z.string().optional(),
};
type Outcome = { status: z.infer<typeof outcomeShape.status>; txHash?: string; requestId?: string; reason?: string };

/** " 1.5 USDC → 0x…" / " 0.0005 ETH → 0x…" from a recorded execution. */
function describe(d: { value?: string; to?: Address; data?: Hex }): string {
  if (!d.to || d.value === undefined) return "";
  const t = d.data ? decodeErc20Transfer(d.data) : null;
  if (t && isAddressEqual(d.to, USDC)) return ` ${formatUnits(t.amount, 6)} USDC → ${t.recipient}`;
  if (t) return ` ${t.amount} units of token ${d.to} → ${t.recipient}`;
  return ` ${formatEther(BigInt(d.value))} ETH → ${d.to}${d.data && d.data !== "0x" ? " (contract call)" : ""}`;
}

export function createCyphosGuardMcpServer({ pw, publicClient, live = false }: ServerOptions) {
  const server = new McpServer({ name: "cyphos-guard", version: "0.1.0" });
  const tx = (h: string) => (live ? `https://sepolia.basescan.org/tx/${h}` : h);

  // MCP clients may call tools in parallel; transactions from the agent's single key must not race for a nonce.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const reply = (o: Outcome, text: string) => ({
    content: [{ type: "text" as const, text }],
    structuredContent: o,
  });
  const fromResult = (r: ExecutionResult, prefix: string) =>
    reply(
      { status: "paid", txHash: r.txHash },
      `${prefix} PAID (${r.via === "grant" ? "within the agent's limits" : "approved by the owner"}). tx ${tx(r.txHash)}`,
    );
  const fromError = (e: unknown) => {
    if (e instanceof ApprovalPending) {
      return reply(
        { status: "pending_approval", requestId: e.request.id },
        `PENDING_APPROVAL request_id=${e.request.id}. This is above the agent's limits. The owner has been asked to ` +
          "approve it with their passkey in the cyphos-guard approver app. Tell the user, then call check_approval.",
      );
    }
    if (e instanceof PolicyViolation) {
      return reply(
        { status: "denied", reason: e.reason },
        `DENIED (${e.reason}): ${e.message}. The owner's policy does not allow this. Do not retry or work around it.`,
      );
    }
    if (e instanceof ApprovalRejected) return reply({ status: "rejected" }, "REJECTED by the owner. Do not pay this.");
    if (e instanceof ApprovalExpired) return reply({ status: "expired" }, "EXPIRED: nobody approved in time.");
    if (e instanceof ExecutionFailed || e instanceof PolicyServiceError) {
      return reply({ status: "failed", reason: e.message }, `FAILED: ${e.message}`);
    }
    throw e;
  };

  server.registerTool(
    "get_wallet_status",
    {
      title: "Wallet status",
      description:
        "The owner's smart account this agent spends from: balances (ETH, USDC) and the agent's current limits. " +
        "Use before paying to see what is possible without approval.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const account = await pw.getAccount();
      const [eth, usdc, grants] = await Promise.all([
        publicClient.getBalance({ address: account }),
        publicClient
          .readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] })
          .catch(() => 0n),
        pw.getGrants(),
      ]);
      const limits = grants.flatMap((g) =>
        parsePolicy(g.policy).permissions.map((p) => {
          if (p.kind === "nativeTransfer") {
            return `ETH: up to ${formatEther(p.perPeriod.amount)} per ${p.perPeriod.periodSeconds / 3600}h to ${p.recipients.join(", ")}`;
          }
          if (p.kind === "erc20Transfer") {
            const unit = isAddressEqual(p.token, USDC) ? "USDC" : `token ${p.token}`;
            const perTx = p.perTx !== undefined ? `, max ${formatUnits(p.perTx, 6)} per payment` : "";
            return `${unit}: up to ${formatUnits(p.perPeriod.amount, 6)} per ${p.perPeriod.periodSeconds / 3600}h${perTx} to ${p.recipients.join(", ")}`;
          }
          return `contract calls to ${p.target}: ${p.functions.map((f) => f.signature).join(", ")}`;
        }),
      );
      const text = [
        `account ${account}`,
        `balances: ${formatEther(eth)} ETH, ${formatUnits(usdc, 6)} USDC`,
        limits.length
          ? `limits (anything above needs the owner's approval):\n- ${limits.join("\n- ")}`
          : "no active grant",
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "pay",
    {
      title: "Pay",
      description:
        "Pay ETH or USDC from the owner's account. Within the agent's limits it executes immediately (status paid). " +
        "Above them the owner is asked to approve (status pending_approval: tell the user and call check_approval). " +
        "Payments the owner's policy forbids return status denied and must not be retried.",
      inputSchema: {
        to: z.string().describe("Recipient address (0x…)"),
        amount: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe("Decimal amount, e.g. 1.50"),
        token: z.enum(["ETH", "USDC"]),
        reason: z.string().min(1).max(300).describe("Why; shown to the owner if approval is needed"),
      },
      outputSchema: outcomeShape,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ to, amount, token, reason }) => {
      if (!isAddress(to))
        return reply({ status: "failed", reason: "invalid address" }, "FAILED: invalid recipient address");
      const exec =
        token === "ETH"
          ? { to, value: parseEther(amount) }
          : {
              to: USDC,
              data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, parseUnits(amount, 6)] }),
            };
      return serialized(async () => {
        try {
          return fromResult(await pw.execute({ ...exec, reason }), `${amount} ${token} to ${to}`);
        } catch (e) {
          return fromError(e);
        }
      });
    },
  );

  server.registerTool(
    "call_contract",
    {
      title: "Call a contract",
      description:
        "Advanced: send a contract call (calldata) from the owner's account, under the same rules as pay: " +
        "executes within limits, otherwise needs the owner's approval, or is denied.",
      inputSchema: {
        to: z.string().describe("Contract address"),
        data: z
          .string()
          .regex(/^0x([0-9a-fA-F]{2})*$/)
          .describe("ABI-encoded calldata"),
        value_eth: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .optional()
          .describe("ETH to send with the call, default 0"),
        reason: z.string().min(1).max(300),
      },
      outputSchema: outcomeShape,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ to, data, value_eth, reason }) => {
      if (!isAddress(to))
        return reply({ status: "failed", reason: "invalid address" }, "FAILED: invalid contract address");
      return serialized(async () => {
        try {
          const r = await pw.execute({ to, data: data as Hex, value: parseEther(value_eth ?? "0"), reason });
          return fromResult(r, `call to ${to}`);
        } catch (e) {
          return fromError(e);
        }
      });
    },
  );

  server.registerTool(
    "check_approval",
    {
      title: "Check approval",
      description:
        "Check (and optionally wait for) the owner's decision on a pending payment. If approved, the payment executes " +
        "and the status is paid.",
      inputSchema: {
        request_id: z.string(),
        wait_seconds: z.number().int().min(0).max(300).default(0).describe("How long to wait for a decision (0-300)"),
      },
      outputSchema: outcomeShape,
      annotations: { openWorldHint: true },
    },
    async ({ request_id, wait_seconds }) =>
      serialized(async () => {
        try {
          return fromResult(
            await pw.waitForApproval(request_id, { timeoutMs: wait_seconds * 1000, pollMs: 1500 }),
            "approved payment",
          );
        } catch (e) {
          return fromError(e);
        }
      }),
  );

  server.registerTool(
    "list_activity",
    {
      title: "Recent activity",
      description: "This agent's recent payments, approval requests and denials.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) => {
      const items = (await pw.getActivity()).slice(0, limit);
      const text = items.length
        ? items
            .map((a) => {
              const d = a.detail as { value?: string; to?: Address; data?: Hex; code?: string };
              return `${new Date(a.createdAt * 1000).toISOString()} ${a.kind}${describe(d)}${d.code ? ` (${d.code})` : ""}${a.txHash ? ` tx ${tx(a.txHash)}` : ""}`;
            })
            .join("\n")
        : "no activity yet";
      return { content: [{ type: "text" as const, text }] };
    },
  );

  return server;
}
