/**
 * The cyphos-guard SDK entry point.
 *
 *   const pw = createCyphosGuard({ accountAddress, policyServiceUrl, agent })   // agent side
 *   const result = await pw.execute({ to, value, reason })                     // auto-escalates
 *
 *   const pw = createCyphosGuard({ accountAddress, policyServiceUrl, owner })   // owner side (approver app)
 *   const grant = await pw.grantAgent({ policy })
 *   await pw.revoke(grant.id)
 *
 * Agent methods need `agent` (the agent's local key). Owner methods need `owner`: the owner's smart
 * account (passkey signer) plus a way to submit owner userOps, and a fetch that carries the session cookie.
 */

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
  type X402Context,
  x402VaultCap,
} from "@cyphos-guard/shared";
import type { Delegation, MetaMaskSmartAccount, SmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  erc20Abi,
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
import {
  encodeVaultSignature,
  grantVaultSalt,
  grantVaults,
  readVault,
  vaultDeployment,
  vaultSweepCalls,
} from "./vault.ts";
import {
  decodeX402Header,
  encodeX402Header,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
  selectRequirement,
  signExactEip3009,
  X402_HEADERS,
  X402Error,
} from "./x402.ts";

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

export type CyphosGuardOptions = {
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
  /** Internal: set by payX402 for top-ups, so the off-chain rules and the co-signer can check the seller. */
  x402?: X402Context;
};

export type WaitOptions = { timeoutMs?: number; pollMs?: number };
export type X402Result = {
  /** The final HTTP response (the paid resource on success). */
  response: Response;
  /** True when the server answered 2xx and its facilitator reported a successful settlement. */
  paid: boolean;
  /** Set when a payment was attempted. */
  payment?: { payTo: Address; asset: Address; amount: bigint; resource: string };
  settlement?: SettlementResponse;
  /** The account → agent top-up, if the agent's own balance didn't cover the payment. */
  topUp?: ExecutionResult;
};

export type ExecutionResult = {
  status: "executed";
  txHash: Hex;
  via: "grant" | "approval";
  grantId?: string;
  requestId?: string;
};

const x402Wire = (x?: X402Context) =>
  x ? { x402: { payTo: x.payTo, amount: x.amount.toString(), resource: x.resource } } : {};

export function createCyphosGuard(opts: CyphosGuardOptions): CyphosGuard {
  const chain: Chain = opts.chain ?? baseSepolia;
  if (chain.id !== SUPPORTED_CHAIN_IDS.baseSepolia && chain.id !== SUPPORTED_CHAIN_IDS.sepolia) {
    throw new Error(`chain ${chain.id} is not supported; cyphos-guard is testnet-only (Base Sepolia, Sepolia)`);
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
    // The gas estimate is the simulation: a caveat that fails reverts here with its reason, and nothing is
    // sent. Passing the estimate on saves sendTransaction a second, identical simulation.
    let gas: bigint;
    try {
      gas = await publicClient.estimateGas({ account: agent, to: environment.DelegationManager, data });
    } catch (e) {
      return { reason: revertReason(e) };
    }
    const wallet = createWalletClient({ account: agent, chain, transport: writeTransport });
    const hash = await wallet.sendTransaction({ to: environment.DelegationManager, data, gas });
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

  const knownAccount = opts.accountAddress ?? opts.owner?.account.address;
  /** The account the agent acts for, from grants already fetched (saves a round trip to the service). */
  function accountOf(grants: GrantJSON[]): Address {
    if (knownAccount) return knownAccount;
    const accounts = [...new Set(grants.map((g) => g.account.toLowerCase()))];
    if (accounts.length === 0) throw new PolicyViolation("no_grant", "this agent has no active grant", []);
    if (accounts.length > 1) throw new Error("agent has grants on several accounts; pass accountAddress");
    return accounts[0] as Address;
  }

  /** execute() with the agent's grants already fetched (payX402 reuses its own list). */
  async function executeWithin(
    grants: GrantJSON[],
    input: ExecuteInput,
    wait: boolean | WaitOptions | undefined,
  ): Promise<ExecutionResult> {
    const account = accountOf(grants);
    const exec = { to: input.to, value: input.value ?? 0n, data: input.data ?? ("0x" as Hex) };
    const violations: string[] = [];
    for (const grant of grants) {
      const policy = parsePolicy(grant.policy);
      for (const [i, delegation] of grant.delegations.entries()) {
        const permission = policy.permissions[i];
        const offchain = permission
          ? offchainCheck(permission, exec, input.x402 ? { x402: input.x402 } : {})
          : "unknown permission";
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
              ...x402Wire(input.x402),
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
            reason: input.reason,
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
        ...x402Wire(input.x402),
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
  }

  const pw: CyphosGuard = {
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
      return knownAccount ?? accountOf(await pw.getGrants());
    },

    /**
     * Do it within the agent's grants if possible; otherwise ask the owner.
     * Resolves when executed. Throws PolicyViolation (denied), ApprovalPending (asked; unless `wait`),
     * ApprovalRejected / ApprovalExpired (when waiting), ExecutionFailed.
     */
    async execute(input: ExecuteInput, { wait }: { wait?: boolean | WaitOptions } = {}): Promise<ExecutionResult> {
      return executeWithin(await pw.getGrants(), input, wait);
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

    /**
     * Fetch an x402-paywalled URL and pay it within the owner's x402 permission (HTTP 402, exact scheme,
     * EIP-3009 token). The agent's own balance is used first; any shortfall is topped up from the account
     * (within limits, or as an approval request, like execute()). Then the agent signs the payment.
     * Throws PolicyViolation / ApprovalPending (unless `wait`) / X402Error. `init.body` must be re-sendable
     * (a string, not a stream): the request is sent twice.
     */
    async payX402(
      url: string,
      init: RequestInit = {},
      { reason, maxAmount, wait }: { reason: string; maxAmount?: bigint; wait?: boolean | WaitOptions },
    ): Promise<X402Result> {
      const agent = needAgent("payX402");
      const first = await fetch(url, init);
      if (first.status !== 402) return { response: first, paid: false };
      const header = first.headers.get(X402_HEADERS.required);
      if (!header) throw new X402Error(`402 without a ${X402_HEADERS.required} header (only x402 v2 is supported)`);
      const required = decodeX402Header<PaymentRequired>(header);

      const grants = await pw.getGrants();
      const permissions = grants.flatMap((g) => {
        const policy = parsePolicy(g.policy);
        return policy.permissions.flatMap((p) => (p.kind === "x402" ? [{ ...p, cap: x402VaultCap(policy, p) }] : []));
      });
      const choice: PaymentRequirements | null = selectRequirement(required, {
        chainId,
        tokens: permissions.map((p) => p.token),
        sellers: permissions.flatMap((p) => p.sellers),
      });
      if (!choice) {
        throw new X402Error(
          `no payable option: need scheme "exact" (EIP-3009) on eip155:${chainId} in a token of an x402 permission`,
        );
      }
      const amount = BigInt(choice.amount);
      if (maxAmount !== undefined && amount > maxAmount) {
        throw new X402Error(`the API asks ${amount}, more than maxAmount ${maxAmount}`);
      }
      const payment = { payTo: choice.payTo, asset: choice.asset, amount, resource: required.resource?.url ?? url };
      const sameToken = permissions.filter((p) => p.token.toLowerCase() === choice.asset.toLowerCase());
      const perm =
        sameToken.find((p) => p.sellers.some((s) => s.toLowerCase() === choice.payTo.toLowerCase())) ?? sameToken[0];
      // Vault mode: the vault itself refuses unlisted sellers and amounts above its cap, so don't move money
      // (or ask the owner) for a payment that can't go through.
      if (perm?.vault) {
        if (!perm.sellers.some((s) => s.toLowerCase() === choice.payTo.toLowerCase())) {
          throw new X402Error(`seller ${choice.payTo} is not on this agent's x402 vault list; the owner can add it`);
        }
        if (amount > perm.cap)
          throw new X402Error(`the API asks ${amount}, above the vault's per-payment cap ${perm.cap}`);
      }
      const payer: Address = perm?.vault ?? agent.address;

      // Just-in-time: only the shortfall leaves the account (leftovers from a failed attempt are reused).
      const held = await publicClient.readContract({
        address: choice.asset,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [payer],
      });
      let topUp: ExecutionResult | undefined;
      if (held < amount) {
        topUp = await executeWithin(
          grants,
          {
            to: choice.asset,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [payer, amount - held] }),
            reason: `x402 payment to ${choice.payTo} for ${payment.resource}: ${reason}`,
            x402: { payTo: choice.payTo, amount, resource: payment.resource },
          },
          wait,
        );
      }

      const raw = await signExactEip3009(agent, choice, chainId, perm?.vault ? { from: perm.vault } : {});
      const signed = perm?.vault
        ? { authorization: raw.authorization, signature: encodeVaultSignature(raw.authorization, raw.signature) }
        : raw;
      const headers = new Headers(init.headers);
      headers.set(
        X402_HEADERS.signature,
        encodeX402Header({ x402Version: 2, resource: required.resource, accepted: choice, payload: signed }),
      );
      const response = await fetch(url, { ...init, headers });
      const settlementHeader = response.headers.get(X402_HEADERS.response);
      const settlement = settlementHeader ? decodeX402Header<SettlementResponse>(settlementHeader) : undefined;
      const paid = response.ok && settlement?.success === true;
      if (paid && settlement?.transaction) {
        await request("agent", "POST", "/agent/x402/paid", {
          account: accountOf(grants),
          txHash: settlement.transaction,
          asset: choice.asset,
          payTo: choice.payTo,
          amount: amount.toString(),
          resource: payment.resource,
          reason,
          payer,
        }).catch((e) => log.warn?.("could not report x402 payment", { error: String(e) }));
      } else if (!paid) {
        log.warn?.("x402 payment not settled; the topped-up amount stays with the payer for the next attempt", {
          status: response.status,
          error: settlement?.errorReason,
        });
      }
      return { response, paid, payment, ...(settlement ? { settlement } : {}), ...(topUp ? { topUp } : {}) };
    },

    /** Activity of this agent (agent signer) or of the whole account (owner). */
    async getActivity(): Promise<ActivityJSON[]> {
      if (opts.agent) return ok(await request<ActivityJSON[]>("agent", "GET", "/agent/activity"));
      return ok(await request<ActivityJSON[]>("owner", "GET", "/activity"));
    },

    // ================= owner =================

    /**
     * Grant an agent a policy. Passkey steps, in this order:
     *   1. sign each compiled delegation (one prompt per permission). Nothing is on-chain yet, so cancelling here
     *      changes nothing;
     *   2. ONE transaction that deploys the x402 vault(s) and revokes the agent's existing grant (so caps never
     *      stack), only if either is needed;
     * then the grant is registered. A retry after a failed or cancelled attempt reuses what that attempt already
     * did (vault deployed, old grant revoked) instead of doing it again.
     */
    async grantAgent({ policy: requested, onProgress }: GrantAgentArgs): Promise<GrantJSON> {
      const owner = needOwner("grantAgent");
      // Parsed with a placeholder vault for x402 permissions that don't name one yet: the schema requires a vault
      // or a co-signer, and the vault address is only derived below. The final policy is parsed again with it.
      const parsedRequest = parsePolicy({
        ...requested,
        permissions: requested.permissions.map((p) =>
          p.kind === "x402" && !p.vault ? { ...p, vault: VAULT_PLACEHOLDER } : p,
        ),
      });
      if (parsedRequest.chainId !== chainId) {
        throw new Error(`policy is for chain ${parsedRequest.chainId}, client is ${chainId}`);
      }
      const agentGrants = (await pw.getGrants()).filter(
        (g) => g.agent.toLowerCase() === parsedRequest.agent.toLowerCase(),
      );

      // x402 permissions get their own X402Vault (sellers + cap enforced on-chain). Its address goes into the
      // policy and the top-up delegation, so it is fixed before signing. The salt is derived from the number of
      // grants this agent already has: a retry of a failed attempt lands on the same address (already deployed →
      // reused), while the next successful grant gets a fresh vault.
      const vaults: { address: Address; call: { to: Address; data: Hex }; sellers: Address[] }[] = [];
      const input: PolicyInput = {
        ...requested,
        permissions: requested.permissions.map((perm, i) => {
          const parsed = parsedRequest.permissions[i];
          if (perm.kind !== "x402" || parsed?.kind !== "x402" || perm.vault) return perm;
          const salt = grantVaultSalt(agentGrants.length, i);
          const d = vaultDeployment({
            owner: owner.account.address,
            agent: parsedRequest.agent,
            token: parsed.token,
            maxPerPayment: x402VaultCap(parsedRequest, parsed),
            sellers: parsed.sellers,
            salt,
          });
          vaults.push({ ...d, sellers: parsed.sellers });
          return { ...perm, vault: d.address, vaultSalt: salt };
        }),
      };
      const policy = parsePolicy(input);

      const calls: { to: Address; data: Hex }[] = [];
      for (const v of vaults) {
        const code = await publicClient.getCode({ address: v.address });
        if (!code || code === "0x") {
          calls.push(v.call);
          continue;
        }
        // Already deployed (an earlier attempt, or someone front-ran it with the same calldata): CREATE2 commits
        // to the exact code and constructor args. Still check the seller list, which the owner can change.
        const state = await readVault(publicClient, v.address, v.sellers);
        if (!state.allSellersListed) {
          throw new Error(
            `x402 vault ${v.address} exists but no longer lists all sellers; add them or change the grant`,
          );
        }
      }
      const vaultDeploys = calls.length;
      // The agent's active grants must be revoked. One an earlier attempt already disabled on-chain is just
      // recorded (the service checks the chain); the rest are revoked in the same transaction as the vault.
      const toRevoke: GrantJSON[] = [];
      for (const g of agentGrants.filter((x) => x.status === "active")) {
        const r = await request("owner", "POST", `/grants/${g.id}/revoked`, {});
        if (r.status === 409) toRevoke.push(g);
        else ok(r);
      }
      for (const g of toRevoke) calls.push(...g.delegations.map((d) => revokeCall(environment, d as Delegation)));
      // Empty the agent's earlier vaults (active and revoked grants) into the account, in the same transaction:
      // a vault keeps approving agent-signed payments to its sellers, and the next grant gets a new one (#2).
      const newVaults = new Set(vaults.map((v) => v.address.toLowerCase()));
      const sweeps = await vaultSweepCalls(
        publicClient,
        agentGrants.flatMap((g) => grantVaults(g.policy)).filter((v) => !newVaults.has(v.address.toLowerCase())),
        owner.account.address,
      );
      calls.push(...sweeps);

      const now = Number((await publicClient.getBlock()).timestamp);
      const compiled = compilePolicy({ policy, delegator: owner.account.address, environment, now });
      const steps = compiled.length + (calls.length > 0 ? 1 : 0);
      const delegations = [];
      for (const [i, c] of compiled.entries()) {
        onProgress?.({
          step: i + 1,
          of: steps,
          action: "sign",
          label: `Sign permission ${i + 1} of ${compiled.length} (${PERMISSION_LABEL[c.permission.kind]})`,
        });
        delegations.push({
          ...c.delegation,
          signature: await owner.account.signDelegation({ delegation: c.delegation }),
        });
      }
      if (calls.length > 0) {
        const what = [
          vaultDeploys > 0 ? "set up the x402 vault" : "",
          toRevoke.length ? "replace the old grant" : "",
          sweeps.length ? "move what's left in the old x402 vault back to your account" : "",
        ]
          .filter(Boolean)
          .join(" and ");
        onProgress?.({ step: steps, of: steps, action: "transaction", label: `Confirm one transaction: ${what}` });
        const txHash = await owner.sendCalls(calls);
        for (const g of toRevoke) ok(await request("owner", "POST", `/grants/${g.id}/revoked`, { txHash }));
      }
      const grant = ok(await request<GrantJSON>("owner", "POST", "/grants", { policy: jsonSafe(input), delegations }));
      const replaced = agentGrants.filter((g) => g.status === "active").map((g) => g.id);
      log.info?.("agent granted", { grantId: grant.id, agent: grant.agent, replaced });
      return grant;
    },

    /** Revoke a grant on-chain (one passkey-signed userOp), then record it. */
    async revoke(grantId: string): Promise<{ txHash: Hex }> {
      const owner = needOwner("revoke");
      const grant = (await pw.getGrants()).find((g) => g.id === grantId);
      if (!grant) throw new PolicyServiceError(404, `no such grant ${grantId}`);
      // Disabling the delegations stops new top-ups, but the grant's x402 vault would keep approving agent-signed
      // payments from whatever is left in it. So the same transaction moves that rest back to the account (#2).
      const sweeps = await vaultSweepCalls(publicClient, grantVaults(grant.policy), owner.account.address);
      const txHash = await owner.sendCalls([
        ...grant.delegations.map((d) => revokeCall(environment, d as Delegation)),
        ...sweeps,
      ]);
      ok(await request("owner", "POST", `/grants/${grantId}/revoked`, { txHash }));
      log.info?.("grant revoked", { grantId, txHash, vaultsEmptied: sweeps.length });
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

/** The cyphos-guard client: agent methods need `agent`, owner methods need `owner` (see CyphosGuardOptions). */
/** One passkey step of grantAgent, for UI progress ("Passkey 2 of 3: …"). */
export type GrantProgress = { step: number; of: number; action: "sign" | "transaction"; label: string };

export type GrantAgentArgs = { policy: PolicyInput; onProgress?: (p: GrantProgress) => void };

const VAULT_PLACEHOLDER = "0x000000000000000000000000000000000000dEaD";

const PERMISSION_LABEL = {
  nativeTransfer: "send ETH",
  erc20Transfer: "send tokens",
  contractCall: "call a contract",
  x402: "pay x402 APIs",
} as const;

export interface CyphosGuard {
  /** The MetaMask Delegation Framework deployment for the chain. */
  environment: SmartAccountsEnvironment;
  publicClient: PublicClient;

  // ---- agent ----
  /** Active grants of this agent (for `accountAddress` if set), or all grants of the account (owner). */
  getGrants(): Promise<GrantJSON[]>;
  /** The account this agent acts for: `accountAddress`, or the account of its single active grant. */
  getAccount(): Promise<Address>;
  /** Do it within the grants if possible, otherwise ask the owner (see the implementation for the errors). */
  execute(input: ExecuteInput, options?: { wait?: boolean | WaitOptions }): Promise<ExecutionResult>;
  /** Fetch an x402-paywalled URL and pay it within the owner's x402 permission. */
  payX402(
    url: string,
    init: RequestInit | undefined,
    options: { reason: string; maxAmount?: bigint; wait?: boolean | WaitOptions },
  ): Promise<X402Result>;
  getRequest(id: string): Promise<ApprovalRequestJSON>;
  /** Poll until the owner decides, then execute. */
  waitForApproval(id: string, options?: WaitOptions): Promise<ExecutionResult>;
  /** Activity of this agent (agent signer) or of the whole account (owner). */
  getActivity(): Promise<ActivityJSON[]>;

  // ---- owner ----
  /** Grant an agent a policy: passkey-sign → one tx (vault + revoke old) → register. See the implementation. */
  grantAgent(args: GrantAgentArgs): Promise<GrantJSON>;
  /** Revoke a grant on-chain, then record it. */
  revoke(grantId: string): Promise<{ txHash: Hex }>;
  getRequests(status?: RequestStatus): Promise<ApprovalRequestJSON[]>;
  /** Approve with the owner's passkey: a one-shot delegation for exactly this request. */
  approve(req: ApprovalRequestJSON): Promise<ApprovalRequestJSON>;
  reject(requestId: string): Promise<ApprovalRequestJSON>;
}
