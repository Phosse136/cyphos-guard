import { buildApprovalDelegation, cosignerCaveat, cosignerEnforcerAddress, cosignTypedData } from "@cyphos-guard/sdk";
import { createSoftPasskey } from "@cyphos-guard/sdk/testing";
import type { ApprovalRequestJSON } from "@cyphos-guard/shared";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { type Address, encodeFunctionData, erc20Abi, type Hex, parseEther, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import type { ChainAdapter } from "./chain.ts";
import { openStore } from "./store.ts";
import { agentRequest, authenticationResponse, registrationResponse } from "./testing.ts";

const env = getSmartAccountsEnvironment(84532);
const ACCOUNT = "0x4444444444444444444444444444444444444444" as Address;
const SHOP = privateKeyToAddress(generatePrivateKey());
const MIXER = privateKeyToAddress(generatePrivateKey());

function setup(overrides: Partial<ChainAdapter> = {}, extraConfig: { setupCode?: string } = {}) {
  let chainTime = 1_800_000_000;
  const chain: ChainAdapter = {
    chainId: 84532,
    isFork: false,
    environment: env,
    now: async () => chainTime,
    simulateRedeem: async () => null,
    isDisabled: async () => true,
    verifiedRedeem: async () => null, // overridden per test
    accountHasPasskey: async () => true,
    ensureCosignerEnforcer: async () => true,
    erc20Transferred: async () => null, // overridden per test
    readX402Vault: async () => null, // overridden per test
    ...overrides,
  };
  const store = openStore(":memory:");
  const cosigner = privateKeyToAccount(generatePrivateKey());
  const app = createApp({
    store,
    chain,
    config: {
      rpId: "localhost",
      rpName: "test",
      origins: ["http://localhost:3000"],
      sessionTtlSeconds: 3600,
      secureCookies: false,
      cosigner,
      ...extraConfig,
    },
  });
  const passkey = createSoftPasskey({ rpId: "localhost", origin: "http://localhost:3000" });
  const agent = privateKeyToAccount(generatePrivateKey());
  let cookie = "";
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

  const owner = {
    async register(setupCode?: string) {
      const o = (await (await app.request("/auth/register/options", json({ setupCode }))).json()) as {
        challengeId: string;
        options: { challenge: string };
      };
      const res = await app.request(
        "/auth/register/verify",
        json({ challengeId: o.challengeId, response: registrationResponse(passkey, o.options.challenge) }),
      );
      cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      return res;
    },
    async login() {
      const o = (await (await app.request("/auth/login/options", { method: "POST" })).json()) as {
        challengeId: string;
        options: { challenge: string };
      };
      const res = await app.request(
        "/auth/login/verify",
        json({ challengeId: o.challengeId, response: authenticationResponse(passkey, o.options.challenge) }),
      );
      cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      return res;
    },
    get: (path: string) => app.request(path, { headers: { cookie } }),
    post: (path: string, body: unknown = {}) => app.request(path, json(body)),
    put: (path: string, body: unknown) => app.request(path, { ...json(body), method: "PUT" }),
    logout: () => {
      cookie = "";
    },
  };
  const asAgent = async (method: string, path: string, body?: unknown) =>
    app.request(path, await agentRequest(agent, method, path, body));

  const policy = {
    version: 1,
    chainId: 84532,
    agent: agent.address,
    expiresAt: chainTime + 86_400,
    permissions: [{ kind: "nativeTransfer", recipients: [SHOP], perPeriod: { amount: "1000", periodSeconds: 86_400 } }],
    escalation: {
      enabled: true,
      approvalTtlSeconds: 600,
      hardMax: [{ token: "native", amount: parseEther("1").toString() }],
    },
    forbidden: { targets: [MIXER] },
  };
  const fakeDelegation = {
    delegate: agent.address,
    delegator: ACCOUNT,
    authority: `0x${"f".repeat(64)}`,
    caveats: [],
    salt: "0x01",
    signature: "0x01",
  };

  /** Registered owner with linked account and one grant. */
  const ready = async () => {
    await owner.register();
    await owner.put("/me/account", { accountAddress: ACCOUNT });
    const res = await owner.post("/grants", { policy, delegations: [fakeDelegation] });
    expect(res.status).toBe(201);
  };
  const requestApproval = async (value = parseEther("0.5"), to: Address = SHOP) =>
    asAgent("POST", "/agent/requests", { account: ACCOUNT, to, value: value.toString(), reason: "pay invoice #42" });
  const approvalFor = (req: ApprovalRequestJSON, override: Partial<{ value: bigint; expiresAt: number }> = {}) => ({
    ...buildApprovalDelegation({
      environment: env,
      delegator: ACCOUNT,
      agent: agent.address,
      execution: { to: req.to, value: override.value ?? BigInt(req.value), data: req.data },
      expiresAt: override.expiresAt ?? req.expiresAt,
    }),
    signature: "0x1234",
  });

  return {
    app,
    store,
    cosigner,
    owner,
    asAgent,
    agent,
    ready,
    requestApproval,
    approvalFor,
    advance: (s: number) => (chainTime += s),
  };
}

describe("owner passkey auth", () => {
  it("first passkey registers and gets a session; registration then closes", async () => {
    const t = setup();
    expect((await t.owner.register()).status).toBe(200);
    expect(((await (await t.owner.get("/me")).json()) as { owner: unknown }).owner).not.toBeNull();
    expect((await t.app.request("/auth/register/options", { method: "POST" })).status).toBe(403);
  });

  it("with a setup code configured, registration needs the code (public deployments)", async () => {
    const t = setup({}, { setupCode: "s3cret-code" });
    expect(((await (await t.app.request("/me")).json()) as { setupCodeRequired: boolean }).setupCodeRequired).toBe(
      true,
    );
    const attempt = (body?: unknown) =>
      t.app.request("/auth/register/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    expect((await attempt()).status).toBe(403);
    expect((await attempt({ setupCode: "wrong" })).status).toBe(403);
    expect((await attempt({ setupCode: "s3cret-cod" })).status).toBe(403);
    expect((await t.owner.register(" s3cret-code ")).status).toBe(200); // pasted with whitespace is fine
    expect((await attempt({ setupCode: "s3cret-code" })).status).toBe(403); // closed after the owner exists
  });

  it("logs in with a valid assertion and rejects a reused challenge", async () => {
    const t = setup();
    await t.owner.register();
    t.owner.logout();
    expect((await t.owner.get("/grants")).status).toBe(401);
    expect((await t.owner.login()).status).toBe(200);
    expect((await t.owner.get("/activity")).status).toBe(409); // logged in, no account yet

    const o = (await (await t.app.request("/auth/login/options", { method: "POST" })).json()) as {
      challengeId: string;
      options: { challenge: string };
    };
    const body = {
      challengeId: o.challengeId,
      response: authenticationResponse(createSoftPasskey(), o.options.challenge),
    };
    const res = await t.app.request("/auth/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401); // unknown passkey
  });

  it("links an account only if the chain confirms the passkey is a signer", async () => {
    const t = setup({ accountHasPasskey: async () => false });
    await t.owner.register();
    expect((await t.owner.put("/me/account", { accountAddress: ACCOUNT })).status).toBe(400);
  });
});

describe("agent auth", () => {
  it("rejects missing, forged and replayed signatures", async () => {
    const t = setup();
    await t.ready();
    expect((await t.app.request("/agent/grants")).status).toBe(401);
    const req = await agentRequest(t.agent, "GET", "/agent/grants");
    const forged = { ...req, headers: { ...req.headers, "x-cyphos-agent": privateKeyToAddress(generatePrivateKey()) } };
    expect((await t.app.request("/agent/grants", forged)).status).toBe(401);
    expect((await t.app.request("/agent/grants", req)).status).toBe(200);
    expect((await t.app.request("/agent/grants", req)).status).toBe(401); // replay
  });

  it("rejects a signature over a different body", async () => {
    const t = setup();
    await t.ready();
    const req = await agentRequest(t.agent, "POST", "/agent/requests", {
      account: ACCOUNT,
      to: SHOP,
      value: "1",
      reason: "x",
    });
    const res = await t.app.request("/agent/requests", {
      ...req,
      body: JSON.stringify({ account: ACCOUNT, to: SHOP, value: "999", reason: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("escalation queue", () => {
  it("creates a pending request within policy, denies forbidden / over hard max / no grant", async () => {
    const t = setup();
    await t.ready();
    const ok = await t.requestApproval();
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as ApprovalRequestJSON).status).toBe("pending");

    const forbidden = await t.requestApproval(1n, MIXER);
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: string }).error).toBe("forbidden");

    const tooBig = await t.requestApproval(parseEther("2"));
    expect(((await tooBig.json()) as { error: string }).error).toBe("over_hard_max");

    const res = await t.asAgent("POST", "/agent/requests", { account: SHOP, to: SHOP, value: "1", reason: "x" });
    expect(res.status).toBe(404);

    const pending = (await (await t.owner.get("/requests?status=pending")).json()) as ApprovalRequestJSON[];
    expect(pending).toHaveLength(1);
    const kinds = ((await (await t.owner.get("/activity")).json()) as { kind: string }[]).map((a) => a.kind);
    expect(kinds.filter((k) => k === "request_denied")).toHaveLength(2); // no_grant is not logged to a foreign account
  });

  it("approve → agent sees the signed one-shot delegation → executed", async () => {
    const t = setup({
      verifiedRedeem: async () => ({ delegator: ACCOUNT, to: SHOP, value: parseEther("0.5"), data: "0x" }),
    });
    await t.ready();
    const req = (await (await t.requestApproval()).json()) as ApprovalRequestJSON;
    const approve = await t.owner.post(`/requests/${req.id}/approve`, { delegation: t.approvalFor(req) });
    expect(approve.status).toBe(200);
    expect((await t.owner.post(`/requests/${req.id}/approve`, { delegation: t.approvalFor(req) })).status).toBe(409);

    const seen = (await (await t.asAgent("GET", `/agent/requests/${req.id}`)).json()) as ApprovalRequestJSON;
    expect(seen.status).toBe("approved");
    expect(seen.delegation?.signature).toBe("0x1234");

    const done = await t.asAgent("POST", `/agent/requests/${req.id}/executed`, { txHash: `0x${"ab".repeat(32)}` });
    expect(((await done.json()) as ApprovalRequestJSON).status).toBe("executed");
  });

  it("won't mark executed if the on-chain execution differs from the request", async () => {
    const t = setup({
      verifiedRedeem: async () => ({ delegator: ACCOUNT, to: SHOP, value: parseEther("0.4"), data: "0x" }),
    });
    await t.ready();
    const req = (await (await t.requestApproval()).json()) as ApprovalRequestJSON;
    await t.owner.post(`/requests/${req.id}/approve`, { delegation: t.approvalFor(req) });
    const res = await t.asAgent("POST", `/agent/requests/${req.id}/executed`, { txHash: `0x${"ab".repeat(32)}` });
    expect(res.status).toBe(400);
  });

  it("records routine activity from the chain, and only for the account the tx spent from", async () => {
    let delegator: Address = ACCOUNT;
    const t = setup({
      verifiedRedeem: async () => ({ delegator, to: SHOP, value: 123n, data: "0x" }),
    });
    await t.ready();
    // The agent claims a different recipient/value; the service records what the chain says.
    const claim = { account: ACCOUNT, txHash: `0x${"cd".repeat(32)}`, to: MIXER, value: "999", reason: "GPU credits" };
    expect((await t.asAgent("POST", "/agent/activity", claim)).status).toBe(201);
    const [entry] = (await (await t.owner.get("/activity")).json()) as {
      kind: string;
      detail: { to: string; value: string };
    }[];
    expect(entry?.kind).toBe("routine_executed");
    expect(entry?.detail).toMatchObject({ to: SHOP, value: "123", reason: "GPU credits" });
    delegator = SHOP; // tx actually spent from another account
    expect((await t.asAgent("POST", "/agent/activity", { ...claim, txHash: `0x${"ef".repeat(32)}` })).status).toBe(400);
  });

  it("refuses approvals that don't match the request exactly", async () => {
    const t = setup();
    await t.ready();
    const req = (await (await t.requestApproval()).json()) as ApprovalRequestJSON;
    const bigger = await t.owner.post(`/requests/${req.id}/approve`, {
      delegation: t.approvalFor(req, { value: BigInt(req.value) + 1n }),
    });
    expect(bigger.status).toBe(400);
    const tooLong = await t.owner.post(`/requests/${req.id}/approve`, {
      delegation: t.approvalFor(req, { expiresAt: req.expiresAt + 3600 }),
    });
    expect(tooLong.status).toBe(400);
    const { caveats, ...rest } = t.approvalFor(req);
    const noLimit = await t.owner.post(`/requests/${req.id}/approve`, {
      delegation: { ...rest, caveats: caveats.slice(0, 1) },
    });
    expect(noLimit.status).toBe(400);
  });

  it("refuses an approval the chain says would not execute (e.g. bad passkey signature)", async () => {
    const t = setup({ simulateRedeem: async () => "InvalidERC1271Signature()" });
    await t.ready();
    const req = (await (await t.requestApproval()).json()) as ApprovalRequestJSON;
    const res = await t.owner.post(`/requests/${req.id}/approve`, { delegation: t.approvalFor(req) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/InvalidERC1271Signature/);
  });

  it("reject is final; expired requests can't be approved", async () => {
    const t = setup();
    await t.ready();
    const a = (await (await t.requestApproval()).json()) as ApprovalRequestJSON;
    expect((await t.owner.post(`/requests/${a.id}/reject`)).status).toBe(200);
    expect((await t.owner.post(`/requests/${a.id}/approve`, { delegation: t.approvalFor(a) })).status).toBe(409);

    const b = (await (await t.requestApproval()).json()) as ApprovalRequestJSON;
    t.advance(601);
    expect((await t.owner.post(`/requests/${b.id}/approve`, { delegation: t.approvalFor(b) })).status).toBe(409);
    const seen = (await (await t.asAgent("GET", `/agent/requests/${b.id}`)).json()) as ApprovalRequestJSON;
    expect(seen.status).toBe("expired");
  });

  it("won't mark executed without a real successful redemption", async () => {
    const t = setup({ verifiedRedeem: async () => null });
    await t.ready();
    const req = (await (await t.requestApproval()).json()) as ApprovalRequestJSON;
    await t.owner.post(`/requests/${req.id}/approve`, { delegation: t.approvalFor(req) });
    const res = await t.asAgent("POST", `/agent/requests/${req.id}/executed`, { txHash: `0x${"ab".repeat(32)}` });
    expect(res.status).toBe(400);
  });
});

describe("grants and revocation", () => {
  it("rejects delegations for another account and marks revoked only when disabled on-chain", async () => {
    let disabled = false;
    const t = setup({ isDisabled: async () => disabled });
    await t.ready();
    const grants = (await (await t.owner.get("/grants")).json()) as { id: string; policy: unknown }[];
    const g = grants[0];
    if (!g) throw new Error("no grant");

    const wrong = await t.owner.post("/grants", {
      policy: g.policy,
      delegations: [
        { delegate: t.agent.address, delegator: SHOP, authority: "0x00", caveats: [], salt: "0x01", signature: "0x01" },
      ],
    });
    expect(wrong.status).toBe(400);

    expect((await t.owner.post(`/grants/${g.id}/revoked`)).status).toBe(409);
    disabled = true;
    expect((await t.owner.post(`/grants/${g.id}/revoked`)).status).toBe(200);
    const after = (await (await t.asAgent("GET", "/agent/grants")).json()) as unknown[];
    expect(after).toHaveLength(0);
  });

  it("allows only one active grant per agent (caps must not stack)", async () => {
    const t = setup();
    await t.ready();
    const [g] = (await (await t.owner.get("/grants")).json()) as {
      id: string;
      policy: unknown;
      delegations: unknown[];
    }[];
    if (!g) throw new Error("no grant");
    const again = await t.owner.post("/grants", { policy: g.policy, delegations: g.delegations });
    expect(again.status).toBe(409);
    await t.owner.post(`/grants/${g.id}/revoked`);
    expect((await t.owner.post("/grants", { policy: g.policy, delegations: g.delegations })).status).toBe(201);
  });

  it("lets an agent read its own activity", async () => {
    const t = setup();
    await t.ready();
    await t.requestApproval();
    const items = (await (await t.asAgent("GET", "/agent/activity")).json()) as { kind: string }[];
    expect(items.map((i) => i.kind)).toContain("request_created");
  });

  it("has no dev relay/funding endpoints unless running against a fork", async () => {
    const t = setup();
    await t.ready();
    expect((await t.owner.post("/dev/fund", { address: SHOP })).status).toBe(404);
    expect((await t.owner.post("/dev/relay", { userOp: {} })).status).toBe(404);
  });
});

describe("co-signer (ADR 0005)", () => {
  const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
  /** Owner with account and a co-signed ERC-20 grant (≤2 per payment) for the test agent. */
  const cosignedGrant = async (t: ReturnType<typeof setup>, cosignerAddr: Address, withCaveat = true) => {
    await t.owner.register();
    await t.owner.put("/me/account", { accountAddress: ACCOUNT });
    const policy = {
      version: 1,
      chainId: 84532,
      agent: t.agent.address,
      expiresAt: 1_800_086_400,
      cosigner: cosignerAddr,
      permissions: [
        {
          kind: "erc20Transfer",
          token: TOKEN,
          recipients: [SHOP],
          perTx: "2000000",
          perPeriod: { amount: "5000000", periodSeconds: 86_400 },
        },
      ],
    };
    const delegation = {
      delegate: t.agent.address,
      delegator: ACCOUNT,
      authority: `0x${"f".repeat(64)}`,
      caveats: withCaveat ? [cosignerCaveat(cosignerAddr)] : [],
      salt: "0x01",
      signature: "0x01",
    };
    return t.owner.post("/grants", { policy, delegations: [delegation] });
  };
  const transfer = (amount: bigint) =>
    encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SHOP, amount] });

  it("publishes its co-signer address and the enforcer", async () => {
    const t = setup();
    const info = (await (await t.app.request("/cosigner")).json()) as {
      enabled: boolean;
      address: string;
      enforcer: string;
    };
    expect(info).toEqual({ enabled: true, address: t.cosigner.address, enforcer: cosignerEnforcerAddress });
  });

  it("rejects grants naming another co-signer or missing the caveat", async () => {
    const other = setup();
    expect((await cosignedGrant(other, privateKeyToAddress(generatePrivateKey()))).status).toBe(400);
    const missing = setup();
    expect((await cosignedGrant(missing, missing.cosigner.address, false)).status).toBe(400);
  });

  it("co-signs an in-policy call (signature recovers to the co-signer) and refuses an off-chain violation", async () => {
    const t = setup();
    const res = await cosignedGrant(t, t.cosigner.address);
    expect(res.status).toBe(201);
    const grant = (await res.json()) as { id: string; delegations: unknown[] };
    const ask = (amount: bigint) =>
      t.asAgent("POST", "/agent/cosign", {
        account: ACCOUNT,
        grantId: grant.id,
        delegationIndex: 0,
        to: TOKEN,
        value: "0",
        data: transfer(amount),
      });

    const ok = await ask(1_500_000n);
    expect(ok.status).toBe(200);
    const cs = (await ok.json()) as { salt: Hex; deadline: string; signature: Hex };
    const typed = cosignTypedData({
      chainId: 84532,
      delegationManager: env.DelegationManager,
      delegation: grant.delegations[0] as never,
      redeemer: t.agent.address,
      execution: { to: TOKEN, value: 0n, data: transfer(1_500_000n) },
      salt: cs.salt,
      deadline: BigInt(cs.deadline),
    });
    expect(await recoverTypedDataAddress({ ...typed, signature: cs.signature })).toBe(t.cosigner.address);
    expect(BigInt(cs.deadline)).toBe(1_800_000_000n + 300n);

    const refused = await ask(3_000_000n);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("offchain_rule");
  });

  it("won't co-sign for another agent's grant or a revoked grant", async () => {
    const t = setup();
    const grant = (await (await cosignedGrant(t, t.cosigner.address)).json()) as { id: string };
    const body = { account: ACCOUNT, grantId: grant.id, delegationIndex: 0, to: TOKEN, value: "0", data: transfer(1n) };
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect(
      (await t.app.request("/agent/cosign", await agentRequest(stranger, "POST", "/agent/cosign", body))).status,
    ).toBe(404);
    await t.owner.post(`/grants/${grant.id}/revoked`);
    expect((await t.asAgent("POST", "/agent/cosign", body)).status).toBe(404);
  });
});

describe("history endpoints", () => {
  it("pages activity backwards with limit + before", async () => {
    const t = setup();
    await t.ready();
    for (let i = 0; i < 5; i++) await t.requestApproval(BigInt(i + 1));
    const first = (await (await t.owner.get("/activity?limit=3")).json()) as { id: number }[];
    expect(first).toHaveLength(3);
    const last = first.at(-1)?.id ?? 0;
    const next = (await (await t.owner.get(`/activity?limit=3&before=${last}`)).json()) as { id: number }[];
    expect(next.length).toBeGreaterThan(0);
    expect(next.every((a) => a.id < last)).toBe(true);
    expect((await t.owner.get("/activity?limit=0")).status).toBe(400);
  });

  it("lists all requests regardless of status", async () => {
    const t = setup();
    await t.ready();
    const a = (await (await t.requestApproval()).json()) as { id: string };
    await t.owner.post(`/requests/${a.id}/reject`);
    await t.requestApproval();
    const all = (await (await t.owner.get("/requests?limit=50")).json()) as { status: string }[];
    expect(all.map((r) => r.status).sort()).toEqual(["pending", "rejected"]);
  });
});

describe("x402 (pay HTTP 402 APIs via just-in-time top-ups)", () => {
  const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
  const SELLER = privateKeyToAddress(generatePrivateKey());
  const x402Grant = async (t: ReturnType<typeof setup>) => {
    await t.owner.register();
    await t.owner.put("/me/account", { accountAddress: ACCOUNT });
    const policy = {
      version: 1,
      chainId: 84532,
      agent: t.agent.address,
      expiresAt: 1_800_086_400,
      cosigner: t.cosigner.address,
      permissions: [
        {
          kind: "x402",
          token: TOKEN,
          sellers: [SELLER],
          perTx: "1000000",
          perPeriod: { amount: "5000000", periodSeconds: 86_400 },
        },
      ],
      escalation: { enabled: true, approvalTtlSeconds: 600, hardMax: [{ token: TOKEN, amount: "20000000" }] },
      forbidden: { targets: [MIXER] },
    };
    const delegation = {
      delegate: t.agent.address,
      delegator: ACCOUNT,
      authority: `0x${"f".repeat(64)}`,
      caveats: [cosignerCaveat(t.cosigner.address)],
      salt: "0x01",
      signature: "0x01",
    };
    const res = await t.owner.post("/grants", { policy, delegations: [delegation] });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  const topUp = (agent: Address, amount: bigint) =>
    encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [agent, amount] });

  it("co-signs a top-up only for an allowed seller, within the per-payment cap and the payment amount", async () => {
    const t = setup();
    const grant = await x402Grant(t);
    const ask = (amount: bigint, x402?: { payTo: Address; amount: string; resource: string }) =>
      t.asAgent("POST", "/agent/cosign", {
        account: ACCOUNT,
        grantId: grant.id,
        delegationIndex: 0,
        to: TOKEN,
        value: "0",
        data: topUp(t.agent.address, amount),
        ...(x402 ? { x402 } : {}),
      });
    const ctx = (payTo: Address, amount: string) => ({ payTo, amount, resource: "https://api.example/data" });
    expect((await ask(500_000n, ctx(SELLER, "500000"))).status).toBe(200);
    expect((await ask(200_000n, ctx(SELLER, "500000"))).status).toBe(200); // shortfall only
    const refusals = [
      await ask(500_000n), // no x402 details: a bare top-up is never co-signed
      await ask(500_000n, ctx(SHOP, "500000")), // seller not allowed
      await ask(2_000_000n, ctx(SELLER, "2000000")), // above per-payment cap
      await ask(900_000n, ctx(SELLER, "500000")), // top-up larger than the payment
    ];
    for (const r of refusals) {
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: string }).error).toBe("offchain_rule");
    }
  });

  it("refuses x402 permissions without a co-signer", async () => {
    const t = setup();
    await t.owner.register();
    await t.owner.put("/me/account", { accountAddress: ACCOUNT });
    const res = await t.owner.post("/grants", {
      policy: {
        version: 1,
        chainId: 84532,
        agent: t.agent.address,
        expiresAt: 1_800_086_400,
        permissions: [
          { kind: "x402", token: TOKEN, sellers: [SELLER], perTx: "1", perPeriod: { amount: "5", periodSeconds: 60 } },
        ],
      },
      delegations: [fakeDelegationFor(t.agent.address)],
    });
    expect(res.status).toBe(400);
  });

  it("escalates a top-up for an unknown seller but denies one for a forbidden seller", async () => {
    const t = setup();
    await x402Grant(t);
    const request = (payTo: Address) =>
      t.asAgent("POST", "/agent/requests", {
        account: ACCOUNT,
        to: TOKEN,
        value: "0",
        data: topUp(t.agent.address, 3_000_000n),
        reason: "x402 payment",
        x402: { payTo, amount: "3000000", resource: "https://api.example/report" },
      });
    expect((await request(SHOP)).status).toBe(201);
    const denied = await request(MIXER);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe("forbidden");
  });

  it("records a settled x402 payment only if the chain shows agent → seller for exactly that amount", async () => {
    let moved: bigint | null = 500_000n;
    const t = setup({ erc20Transferred: async () => moved });
    await x402Grant(t);
    const body = {
      account: ACCOUNT,
      txHash: `0x${"a".repeat(64)}`,
      asset: TOKEN,
      payTo: SELLER,
      amount: "500000",
      resource: "https://api.example/data",
      reason: "market data",
    };
    expect((await t.asAgent("POST", "/agent/x402/paid", body)).status).toBe(201);
    moved = 1n;
    expect((await t.asAgent("POST", "/agent/x402/paid", body)).status).toBe(400);
    moved = null;
    expect((await t.asAgent("POST", "/agent/x402/paid", body)).status).toBe(400);
    const activity = (await (await t.owner.get("/activity")).json()) as {
      kind: string;
      detail: { resource?: string; payer?: string };
    }[];
    const paid = activity.filter((a) => a.kind === "x402_paid");
    expect(paid).toHaveLength(1);
    expect(paid[0]?.detail).toMatchObject({ resource: "https://api.example/data", payer: t.agent.address });
  });
});

function fakeDelegationFor(agent: Address) {
  return {
    delegate: agent,
    delegator: ACCOUNT,
    authority: `0x${"f".repeat(64)}`,
    caveats: [],
    salt: "0x01",
    signature: "0x01",
  };
}

describe("x402 vaults", () => {
  const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
  const SELLER = privateKeyToAddress(generatePrivateKey());
  const VAULT = privateKeyToAddress(generatePrivateKey());
  const vaultGrant = (t: ReturnType<typeof setup>) =>
    t.owner.post("/grants", {
      policy: {
        version: 1,
        chainId: 84532,
        agent: t.agent.address,
        expiresAt: 1_800_086_400,
        permissions: [
          {
            kind: "x402",
            token: TOKEN,
            sellers: [SELLER],
            perTx: "1000000",
            perPeriod: { amount: "5000000", periodSeconds: 86_400 },
            vault: VAULT,
          },
        ],
        escalation: { enabled: true, approvalTtlSeconds: 600, hardMax: [{ token: TOKEN, amount: "20000000" }] },
      },
      delegations: [fakeDelegationFor(t.agent.address)],
    });
  const good = (t: ReturnType<typeof setup>) => ({
    owner: ACCOUNT,
    agent: t.agent.address,
    token: TOKEN,
    maxPerPayment: 20_000_000n, // the hard max, so approved larger payments can still be paid
    allSellersListed: true,
  });
  const ready = async (t: ReturnType<typeof setup>) => {
    await t.owner.register();
    await t.owner.put("/me/account", { accountAddress: ACCOUNT });
  };

  it("accepts a grant only if the vault on-chain matches the policy (no co-signer needed)", async () => {
    for (const [label, mutate, status] of [
      ["matching vault", (v: ReturnType<typeof good>) => v, 201],
      ["vault of another owner", (v: ReturnType<typeof good>) => ({ ...v, owner: MIXER }), 400],
      ["vault for another agent", (v: ReturnType<typeof good>) => ({ ...v, agent: MIXER }), 400],
      ["wrong cap", (v: ReturnType<typeof good>) => ({ ...v, maxPerPayment: 1n }), 400],
      ["seller not listed", (v: ReturnType<typeof good>) => ({ ...v, allSellersListed: false }), 400],
    ] as const) {
      let t: ReturnType<typeof setup>;
      t = setup({ readX402Vault: async () => mutate(good(t)) });
      await ready(t);
      expect((await vaultGrant(t)).status, label).toBe(status);
    }
    const missing = setup({ readX402Vault: async () => null });
    await ready(missing);
    expect((await vaultGrant(missing)).status).toBe(400);
  });

  it("records payments from the agent's vault, but not from some other payer", async () => {
    let t: ReturnType<typeof setup>;
    t = setup({ readX402Vault: async () => good(t), erc20Transferred: async () => 500_000n });
    await ready(t);
    expect((await vaultGrant(t)).status).toBe(201);
    const body = (payer: Address) => ({
      account: ACCOUNT,
      txHash: `0x${"b".repeat(64)}`,
      asset: TOKEN,
      payTo: SELLER,
      amount: "500000",
      resource: "https://api.example/data",
      payer,
    });
    expect((await t.asAgent("POST", "/agent/x402/paid", body(VAULT))).status).toBe(201);
    expect((await t.asAgent("POST", "/agent/x402/paid", body(MIXER))).status).toBe(400);
    const paid = (
      (await (await t.owner.get("/activity")).json()) as { kind: string; detail: { payer?: string } }[]
    ).filter((a) => a.kind === "x402_paid");
    expect(paid.map((a) => a.detail.payer)).toEqual([VAULT]);
  });
});
