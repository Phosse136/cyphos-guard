/**
 * Agent-side client (Phase 2 shape; Phase 3 turns this into the polished `createPhoswallet` API).
 *
 * execute(): try every active grant's delegation (simulate → send). If none fits, ask the policy
 * service for owner approval instead of failing silently. The owner's passkey then signs a one-shot
 * delegation, which `waitForApproval` + `redeemApproval` turn into a transaction.
 */
import type { Delegation, SmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import {
  AGENT_HEADERS,
  type ApprovalRequestJSON,
  agentAuthMessage,
  type EscalationRefusal,
  type GrantJSON,
} from "@phoswallet/shared";
import type { Account, Address, Chain, Hex, LocalAccount, PublicClient, Transport, WalletClient } from "viem";
import { type Execution, encodeRedeem, revertReason } from "./delegations.ts";

export type ExecuteResult =
  | { status: "executed"; txHash: Hex; via: "grant"; grantId: string }
  | { status: "pending"; request: ApprovalRequestJSON; violations: string[] }
  | { status: "denied"; code: EscalationRefusal | "error"; message: string; violations: string[] };

export type AgentClientOptions = {
  agent: LocalAccount;
  /** The owner's smart account this agent acts for. */
  account: Address;
  policyServiceUrl: string;
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  environment: SmartAccountsEnvironment;
};

export function createAgentClient(opts: AgentClientOptions) {
  const { agent, account, publicClient, walletClient, environment } = opts;
  const base = opts.policyServiceUrl.replace(/\/$/, "");

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const signature = await agent.signMessage({
      message: agentAuthMessage({ method, path, timestamp, nonce, body: text }),
    });
    const res = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        [AGENT_HEADERS.agent]: agent.address,
        [AGENT_HEADERS.timestamp]: String(timestamp),
        [AGENT_HEADERS.nonce]: nonce,
        [AGENT_HEADERS.signature]: signature,
      },
      ...(text ? { body: text } : {}),
    });
    return { status: res.status, data: (await res.json()) as T };
  }

  /** Simulate, then broadcast a redemption from the agent's EOA. Returns tx hash or the revert reason. */
  async function redeem(delegation: Delegation, execution: Execution): Promise<{ hash: Hex } | { reason: string }> {
    const data = encodeRedeem(delegation, execution);
    try {
      await publicClient.call({ account: agent, to: environment.DelegationManager, data });
    } catch (e) {
      return { reason: revertReason(e) };
    }
    const hash = await walletClient.sendTransaction({
      account: agent,
      to: environment.DelegationManager,
      data,
      chain: walletClient.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.status === "success" ? { hash } : { reason: `reverted on-chain (${hash})` };
  }

  return {
    async grants(): Promise<GrantJSON[]> {
      const { data } = await call<GrantJSON[]>("GET", "/agent/grants");
      return data.filter((g) => g.account.toLowerCase() === account.toLowerCase());
    },

    async execute(execution: Execution & { reason: string }): Promise<ExecuteResult> {
      const violations: string[] = [];
      for (const grant of await this.grants()) {
        for (const delegation of grant.delegations) {
          const r = await redeem(delegation as Delegation, execution);
          if ("hash" in r) {
            await call("POST", "/agent/activity", {
              account,
              txHash: r.hash,
              to: execution.to,
              value: String(execution.value ?? 0n),
            });
            return { status: "executed", txHash: r.hash, via: "grant", grantId: grant.id };
          }
          violations.push(r.reason);
        }
      }
      const { status, data } = await call<ApprovalRequestJSON & { error?: EscalationRefusal; message?: string }>(
        "POST",
        "/agent/requests",
        {
          account,
          to: execution.to,
          value: String(execution.value ?? 0n),
          data: execution.data ?? "0x",
          reason: execution.reason,
        },
      );
      if (status === 201) return { status: "pending", request: data, violations };
      return { status: "denied", code: data.error ?? "error", message: data.message ?? `HTTP ${status}`, violations };
    },

    async getRequest(id: string) {
      return (await call<ApprovalRequestJSON>("GET", `/agent/requests/${id}`)).data;
    },

    /** Poll until the owner decides or the request expires. */
    async waitForApproval(id: string, { pollMs = 2000, timeoutMs = 15 * 60_000 } = {}) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const req = await this.getRequest(id);
        if (req.status !== "pending") return req;
        if (Date.now() > until) return req;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },

    /** Redeem an approved request's one-shot delegation and report the tx to the policy service. */
    async redeemApproval(req: ApprovalRequestJSON): Promise<{ hash: Hex } | { reason: string }> {
      if (req.status !== "approved" || !req.delegation) return { reason: `request is ${req.status}` };
      const r = await redeem(req.delegation as Delegation, { to: req.to, value: BigInt(req.value), data: req.data });
      if ("hash" in r) await call("POST", `/agent/requests/${req.id}/executed`, { txHash: r.hash });
      return r;
    },
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
