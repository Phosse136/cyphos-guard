/**
 * The phoswallet SDK entry point.
 *
 *   const pw = createPhoswallet({ accountAddress, policyServiceUrl, agent })   // agent side
 *   const result = await pw.execute({ to, value, reason })                     // auto-escalates
 *
 *   const pw = createPhoswallet({ accountAddress, policyServiceUrl, owner })   // owner side (approver app)
 *   const grant = await pw.grantAgent({ policy })
 *   await pw.revoke(grant.id)
 *
 * Agent methods need `agent` (the agent's local key). Owner methods need `owner`: the owner's smart
 * account (passkey signer) plus a way to submit owner userOps, and a fetch that carries the session cookie.
 */
import type { Delegation, MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import {
  type ActivityJSON,
  AGENT_HEADERS,
  type ApprovalRequestJSON,
  agentAuthMessage,
  type EscalationRefusal,
  type GrantJSON,
  offchainCheck,
  type PolicyInput,
  parsePolicy,
  type RequestStatus,
  SUPPORTED_CHAIN_IDS,
} from "@phoswallet/shared";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  custom,
  type Hex,
  http,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { baseSepolia, sepolia } from "viem/chains";
import { buildApprovalDelegation } from "./approval.ts";
import { compilePolicy } from "./compile.ts";
import { type Cosignature, delegationCosigner, withCosignature } from "./cosigner.ts";
import { type Execution, encodeRedeem, revertReason, revokeCall } from "./delegations.ts";
import {
  ApprovalExpired,
  ApprovalPending,
  ApprovalRejected,
  ExecutionFailed,
  MissingSigner,
  PolicyServiceError,
  PolicyViolation,
} from "./errors.ts";

export type Logger = {
  debug?: (msg: string, data?: Record<string, unknown>) => void;
  info?: (msg: string, data?: Record<string, unknown>) => void;
  warn?: (msg: string, data?: Record<string, unknown>) => void;
};

export type OwnerConfig = {
  /** The owner's smart account with its (passkey) signer, e.g. from toMetaMaskSmartAccount(). */
  account: MetaMaskSmartAccount;
  /** Submits owner calls as a signed userOp (bundler on live, dev relay on a fork). Returns the tx hash. */
  sendCalls: (calls: { to: Address; data?: Hex; value?: bigint }[]) => Promise<Hex>;
  /** fetch that carries the owner's session (browser: default with credentials; Node: add the cookie). */
  fetch?: typeof fetch;
};

export type PhoswalletOptions = {
  /**
   * The owner's smart account. Optional: owner clients use `owner.account.address`; agent clients
   * resolve it from their (single) active grant, so an agent only needs its key and the service URL.
   */
  accountAddress?: Address;
  policyServiceUrl: string;
  /** Base Sepolia (default) or Sepolia. Mainnet is refused. */
  chain?: Chain;
  rpcUrl?: string;
  publicClient?: PublicClient;
  agent?: LocalAccount;
  owner?: OwnerConfig;
  retry?: { attempts?: number; baseDelayMs?: number };
  logger?: Logger;
};

export type ExecuteInput = Execution & {
  /** Shown to the owner if escalated. Treated as untrusted text. */
  reason: string;
};

export type WaitOptions = { timeoutMs?: number; pollMs?: number };

export type ExecutionResult = {
  status: "executed";
  txHash: Hex;
  via: "grant" | "approval";
  grantId?: string;
  requestId?: string;
};

export function createPhoswallet(opts: PhoswalletOptions) {
  const chain: Chain = opts.chain ?? baseSepolia;
  if (chain.id !== SUPPORTED_CHAIN_IDS.baseSepolia && chain.id !== SUPPORTED_CHAIN_IDS.sepolia) {
    throw new Error(`chain ${chain.id} is not supported; phoswallet is testnet-only (Base Sepolia, Sepolia)`);
  }
  const chainId = chain.id === sepolia.id ? sepolia.id : baseSepolia.id;
  const environment = getSmartAccountsEnvironment(chainId);
  const publicClient: PublicClient =
    opts.publicClient ?? createPublicClient({ chain, transport: http(opts.rpcUrl, { retryCount: 3 }) });
  // Writes MUST go to the same node as reads. (Bug found in e2e: with an injected publicClient and no
  // rpcUrl, a fresh http() transport silently fell back to the chain's public RPC, i.e. another network.)
  const writeTransport = opts.rpcUrl
    ? http(opts.rpcUrl, { retryCount: 3 })
    : custom({ request: (args) => publicClient.request(args as never) });
  const base = opts.policyServiceUrl.replace(/\/$/, "");
  const attempts = opts.retry?.attempts ?? 3;
  const baseDelay = opts.retry?.baseDelayMs ?? 300;
  const log = opts.logger ?? {};

  const needAgent = (method: string) => {
    if (!opts.agent) throw new MissingSigner("agent", method);
    return opts.agent;
  };
  const needOwner = (method: string) => {
    if (!opts.owner) throw new MissingSigner("owner", method);
    return opts.owner;
  };

  // ---------- HTTP with retries ----------
  /**
   * Retries network errors, 429 and 5xx with exponential backoff. 4xx are final. Agent requests are
   * re-signed per attempt (fresh timestamp + nonce). Note: a POST that timed out may have been processed;
   * the server tolerates a duplicate request (it shows twice to the owner) but never double-executes.
   */
  async function request<T>(role: "agent" | "owner", method: "GET" | "POST", path: string, body?: unknown) {
    const text = body === undefined ? "" : JSON.stringify(body);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        let doFetch: typeof fetch = fetch;
        if (role === "agent") {
          const agent = needAgent(path);
          const timestamp = Math.floor(Date.now() / 1000);
          const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          headers[AGENT_HEADERS.agent] = agent.address;
          headers[AGENT_HEADERS.timestamp] = String(timestamp);
          headers[AGENT_HEADERS.nonce] = nonce;
          headers[AGENT_HEADERS.signature] = await agent.signMessage({
            message: agentAuthMessage({ method, path, timestamp, nonce, body: text }),
          });
        } else {
          doFetch = needOwner(path).fetch ?? ((input, init) => fetch(input, { ...init, credentials: "include" }));
        }
        const res = await doFetch(base + path, { method, headers, ...(text ? { body: text } : {}) });
        const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
        if (res.status === 429 || res.status >= 500) {
          lastErr = new PolicyServiceError(res.status, data.error ?? `HTTP ${res.status}`);
        } else {
          return { status: res.status, data };
        }
      } catch (e) {
        if (e instanceof MissingSigner) throw e;
        lastErr = e;
      }
      if (attempt < attempts) {
        const delay = baseDelay * 2 ** (attempt - 1);
        log.warn?.("policy service request failed, retrying", { path, attempt, delay });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (lastErr instanceof PolicyServiceError) throw lastErr;
    throw new PolicyServiceError(null, `policy service unreachable: ${(lastErr as Error)?.message ?? lastErr}`);
  }
  const ok = <T>(r: { status: number; data: T & { error?: string } }, expect = [200, 201]) => {
    if (!expect.includes(r.status)) throw new PolicyServiceError(r.status, r.data.error ?? `HTTP ${r.status}`);
    return r.data as T;
  };

  // ---------- on-chain redemption (agent pays gas from its own EOA) ----------
  async function redeem(delegation: Delegation, exec: Execution): Promise<{ hash: Hex } | { reason: string }> {
    const agent = needAgent("execute");
    const data = encodeRedeem(delegation, exec);
    try {
      await publicClient.call({ account: agent, to: environment.DelegationManager, data });
    } catch (e) {
      return { reason: revertReason(e) };
    }
    const wallet = createWalletClient({ account: agent, chain, transport: writeTransport });
    const hash = await wallet.sendTransaction({ to: environment.DelegationManager, data });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.status === "success" ? { hash } : { reason: `reverted on-chain (${hash})` };
  }

  async function finishApproval(req: ApprovalRequestJSON): Promise<ExecutionResult> {
    if (req.status === "executed" && req.txHash)
      return { status: "executed", txHash: req.txHash, via: "approval", requestId: req.id };
    if (req.status === "rejected") throw new ApprovalRejected(req);
    if (req.status === "expired") throw new ApprovalExpired(req);
    if (req.status === "pending" || !req.delegation) throw new ApprovalPending(req);
    const r = await redeem(req.delegation as Delegation, { to: req.to, value: BigInt(req.value), data: req.data });
    if ("reason" in r) throw new ExecutionFailed(r.reason);
    ok(await request("agent", "POST", `/agent/requests/${req.id}/executed`, { txHash: r.hash }));
    log.info?.("approved action executed", { requestId: req.id, txHash: r.hash });
    return { status: "executed", txHash: r.hash, via: "approval", requestId: req.id };
  }

  const pw = {
    environment,
    publicClient,

    // ================= agent =================

    /** Active grants of this agent (for `accountAddress` if set), or all grants of the account (owner). */
    async getGrants(): Promise<GrantJSON[]> {
      if (opts.owner && !opts.agent) return ok(await request<GrantJSON[]>("owner", "GET", "/grants"));
      const all = ok(await request<GrantJSON[]>("agent", "GET", "/agent/grants"));
      const account = opts.accountAddress ?? opts.owner?.account.address;
      return account ? all.filter((g) => g.account.toLowerCase() === account.toLowerCase()) : all;
    },

    /** The account this agent acts for: `accountAddress`, or the account of its single active grant. */
    async getAccount(): Promise<Address> {
      const known = opts.accountAddress ?? opts.owner?.account.address;
      if (known) return known;
      const accounts = [...new Set((await pw.getGrants()).map((g) => g.account.toLowerCase()))];
      if (accounts.length === 0) throw new PolicyViolation("no_grant", "this agent has no active grant", []);
      if (accounts.length > 1) throw new Error("agent has grants on several accounts; pass accountAddress");
      return accounts[0] as Address;
    },

    /**
     * Do it within the agent's grants if possible; otherwise ask the owner.
     * Resolves when executed. Throws PolicyViolation (denied), ApprovalPending (asked; unless `wait`),
     * ApprovalRejected / ApprovalExpired (when waiting), ExecutionFailed.
     */
    async execute(input: ExecuteInput, { wait }: { wait?: boolean | WaitOptions } = {}): Promise<ExecutionResult> {
      const account = await pw.getAccount();
      const exec = { to: input.to, value: input.value ?? 0n, data: input.data ?? ("0x" as Hex) };
      const violations: string[] = [];
      for (const grant of await pw.getGrants()) {
        const policy = parsePolicy(grant.policy);
        for (const [i, delegation] of grant.delegations.entries()) {
          const permission = policy.permissions[i];
          const offchain = permission ? offchainCheck(permission, exec) : "unknown permission";
          if (offchain) {
            violations.push(offchain);
            continue;
          }
          // Co-signed grant: get a fresh cosignature for this exact call (the service re-checks the
          // off-chain rules and refuses if they fail; on-chain, the redemption can't happen without it).
          let toRedeem = delegation as Delegation;
          if (delegationCosigner(toRedeem)) {
            const cs = await request<Cosignature & { error?: string; message?: string }>(
              "agent",
              "POST",
              "/agent/cosign",
              {
                account,
                grantId: grant.id,
                delegationIndex: i,
                to: exec.to,
                value: exec.value.toString(),
                data: exec.data,
              },
            );
            if (cs.status !== 200) {
              violations.push(`co-signer refused: ${cs.data.message ?? cs.data.error ?? `HTTP ${cs.status}`}`);
              continue;
            }
            toRedeem = withCosignature(toRedeem, cs.data);
          }
          const r = await redeem(toRedeem, exec);
          if ("hash" in r) {
            await request("agent", "POST", "/agent/activity", {
              account,
              txHash: r.hash,
              to: exec.to,
              value: exec.value.toString(),
            }).catch((e) => log.warn?.("could not report activity", { error: String(e) }));
            log.info?.("executed within grant", { grantId: grant.id, txHash: r.hash });
            return { status: "executed", txHash: r.hash, via: "grant", grantId: grant.id };
          }
          violations.push(r.reason);
        }
      }
      log.debug?.("not covered by grants, escalating", { violations });

      const res = await request<ApprovalRequestJSON & { error?: EscalationRefusal; message?: string }>(
        "agent",
        "POST",
        "/agent/requests",
        {
          account,
          to: exec.to,
          value: exec.value.toString(),
          data: exec.data,
          reason: input.reason,
        },
      );
      if (res.status !== 201) {
        if (res.data.error && res.status < 500)
          throw new PolicyViolation(res.data.error, res.data.message ?? "", violations);
        throw new PolicyServiceError(res.status, res.data.error ?? `HTTP ${res.status}`);
      }
      log.info?.("approval requested", { requestId: res.data.id });
      if (!wait) throw new ApprovalPending(res.data, violations);
      return pw.waitForApproval(res.data.id, wait === true ? {} : wait);
    },

    async getRequest(id: string): Promise<ApprovalRequestJSON> {
      return ok(await request<ApprovalRequestJSON>("agent", "GET", `/agent/requests/${id}`));
    },

    /** Poll until the owner decides, then execute. Throws ApprovalRejected / ApprovalExpired / ApprovalPending (timeout). */
    async waitForApproval(
      id: string,
      { timeoutMs = 15 * 60_000, pollMs = 2000 }: WaitOptions = {},
    ): Promise<ExecutionResult> {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const req = await pw.getRequest(id);
        if (req.status !== "pending" || Date.now() >= until) return finishApproval(req);
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },

    /** Activity of this agent (agent signer) or of the whole account (owner). */
    async getActivity(): Promise<ActivityJSON[]> {
      if (opts.agent) return ok(await request<ActivityJSON[]>("agent", "GET", "/agent/activity"));
      return ok(await request<ActivityJSON[]>("owner", "GET", "/activity"));
    },

    // ================= owner =================

    /**
     * Grant an agent a policy: compile → passkey-sign each delegation → register.
     * Any existing active grant for the same agent is revoked on-chain first, so caps never stack.
     */
    async grantAgent({ policy: input }: { policy: PolicyInput }): Promise<GrantJSON> {
      const owner = needOwner("grantAgent");
      const policy = parsePolicy(input);
      if (policy.chainId !== chainId) throw new Error(`policy is for chain ${policy.chainId}, client is ${chainId}`);
      const existing = (await pw.getGrants()).filter(
        (g) => g.status === "active" && g.agent.toLowerCase() === policy.agent.toLowerCase(),
      );
      for (const g of existing) await pw.revoke(g.id);

      const now = Number((await publicClient.getBlock()).timestamp);
      const compiled = compilePolicy({ policy, delegator: owner.account.address, environment, now });
      const delegations = [];
      for (const c of compiled) {
        delegations.push({
          ...c.delegation,
          signature: await owner.account.signDelegation({ delegation: c.delegation }),
        });
      }
      const grant = ok(await request<GrantJSON>("owner", "POST", "/grants", { policy: jsonSafe(input), delegations }));
      log.info?.("agent granted", { grantId: grant.id, agent: grant.agent, replaced: existing.map((g) => g.id) });
      return grant;
    },

    /** Revoke a grant on-chain (one passkey-signed userOp), then record it. */
    async revoke(grantId: string): Promise<{ txHash: Hex }> {
      const owner = needOwner("revoke");
      const grant = (await pw.getGrants()).find((g) => g.id === grantId);
      if (!grant) throw new PolicyServiceError(404, `no such grant ${grantId}`);
      const txHash = await owner.sendCalls(grant.delegations.map((d) => revokeCall(environment, d as Delegation)));
      ok(await request("owner", "POST", `/grants/${grantId}/revoked`, { txHash }));
      log.info?.("grant revoked", { grantId, txHash });
      return { txHash };
    },

    async getRequests(status?: RequestStatus): Promise<ApprovalRequestJSON[]> {
      return ok(await request<ApprovalRequestJSON[]>("owner", "GET", `/requests${status ? `?status=${status}` : ""}`));
    },

    /**
     * Approve exactly the request object the owner was shown: the one-shot delegation is built from
     * these fields (not re-fetched), so what's displayed is what's signed. The server re-verifies the match.
     */
    async approve(req: ApprovalRequestJSON): Promise<ApprovalRequestJSON> {
      const owner = needOwner("approve");
      const unsigned = buildApprovalDelegation({
        environment,
        delegator: owner.account.address,
        agent: req.agent,
        execution: { to: req.to, value: BigInt(req.value), data: req.data },
        expiresAt: req.expiresAt,
      });
      const delegation = { ...unsigned, signature: await owner.account.signDelegation({ delegation: unsigned }) };
      return ok(await request<ApprovalRequestJSON>("owner", "POST", `/requests/${req.id}/approve`, { delegation }));
    },

    async reject(requestId: string): Promise<ApprovalRequestJSON> {
      return ok(await request<ApprovalRequestJSON>("owner", "POST", `/requests/${requestId}/reject`));
    },
  };
  return pw;
}

/** bigint → string so a PolicyInput built with bigints survives JSON. */
function jsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

export type Phoswallet = ReturnType<typeof createPhoswallet>;
