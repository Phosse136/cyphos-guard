import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { buildApprovalDelegation } from "@phoswallet/sdk";
import { createSoftPasskey } from "@phoswallet/sdk/testing";
import type { ApprovalRequestJSON } from "@phoswallet/shared";
import { type Address, parseEther } from "viem";
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

function setup(overrides: Partial<ChainAdapter> = {}) {
  let chainTime = 1_800_000_000;
  const chain: ChainAdapter = {
    chainId: 84532,
    isFork: false,
    environment: env,
    now: async () => chainTime,
    simulateRedeem: async () => null,
    isDisabled: async () => true,
    isSuccessfulRedeem: async () => true,
    accountHasPasskey: async () => true,
    ...overrides,
  };
  const store = openStore(":memory:");
  const app = createApp({
    store,
    chain,
    config: {
      rpId: "localhost",
      rpName: "test",
      origins: ["http://localhost:3000"],
      sessionTtlSeconds: 3600,
      secureCookies: false,
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
    async register() {
      const o = (await (await app.request("/auth/register/options", { method: "POST" })).json()) as {
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
    const forged = { ...req, headers: { ...req.headers, "x-phos-agent": privateKeyToAddress(generatePrivateKey()) } };
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
    const t = setup();
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
    const t = setup({ isSuccessfulRedeem: async () => false });
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

  it("has no dev relay/funding endpoints unless running against a fork", async () => {
    const t = setup();
    await t.ready();
    expect((await t.owner.post("/dev/fund", { address: SHOP })).status).toBe(404);
    expect((await t.owner.post("/dev/relay", { userOp: {} })).status).toBe(404);
  });
});
