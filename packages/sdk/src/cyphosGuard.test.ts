import type { PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCyphosGuard } from "./cyphosGuard.ts";
import {
  ApprovalExpired,
  ApprovalPending,
  ApprovalRejected,
  MissingSigner,
  PolicyServiceError,
  PolicyViolation,
} from "./errors.ts";

const ACCOUNT = "0x4444444444444444444444444444444444444444";
const SHOP = "0x2222222222222222222222222222222222222222";
const fakeClient = {} as PublicClient; // no grants → never touches the chain
const req = (status: string) => ({
  id: "r1",
  account: ACCOUNT,
  agent: SHOP,
  to: SHOP,
  value: "1",
  data: "0x",
  reason: "x",
  status,
  createdAt: 1,
  expiresAt: 2,
  decidedAt: null,
  txHash: null,
  delegation: null,
});

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown } | Error) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const r = handler(String(url), init ?? {});
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const agentPw = () =>
  createCyphosGuard({
    accountAddress: ACCOUNT,
    policyServiceUrl: "http://svc",
    publicClient: fakeClient,
    agent: privateKeyToAccount(generatePrivateKey()),
    retry: { attempts: 3, baseDelayMs: 1 },
  });

afterEach(() => vi.unstubAllGlobals());

describe("createCyphosGuard", () => {
  it("refuses mainnet", () => {
    expect(() =>
      createCyphosGuard({ accountAddress: ACCOUNT, policyServiceUrl: "http://svc", chain: mainnet }),
    ).toThrow(/testnet-only/);
  });

  it("signs agent requests (headers present, fresh nonce per request)", async () => {
    const f = mockFetch(() => ({ status: 200, body: [] }));
    const pw = agentPw();
    await pw.getGrants();
    await pw.getGrants();
    const nonces = f.mock.calls.map((c) => (c[1]?.headers as Record<string, string> | undefined)?.["x-cyphos-nonce"]);
    expect(nonces[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("escalates when no grant covers the action → ApprovalPending", async () => {
    mockFetch((url) =>
      url.endsWith("/agent/grants") ? { status: 200, body: [] } : { status: 201, body: req("pending") },
    );
    await expect(agentPw().execute({ to: SHOP, value: 1n, reason: "x" })).rejects.toBeInstanceOf(ApprovalPending);
  });

  it("execute fetches the grants once, also when it has to find the account from them", async () => {
    const agent = privateKeyToAccount(generatePrivateKey());
    const now = Math.floor(Date.now() / 1000);
    const grant = {
      id: "g1",
      account: ACCOUNT,
      agent: agent.address,
      status: "active",
      // x402 top-ups only, so the plain ETH payment below is refused off-chain and escalated.
      policy: {
        version: 1,
        chainId: 84532,
        agent: agent.address,
        expiresAt: now + 3600,
        permissions: [
          {
            kind: "x402",
            token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            sellers: ["0x3333333333333333333333333333333333333333"],
            vault: "0x5555555555555555555555555555555555555555",
            perTx: "1000",
            perPeriod: { amount: "5000", periodSeconds: 86400 },
          },
        ],
      },
      delegations: [{}],
    };
    const f = mockFetch((url) =>
      url.endsWith("/agent/grants") ? { status: 200, body: [grant] } : { status: 201, body: req("pending") },
    );
    const pw = createCyphosGuard({ policyServiceUrl: "http://svc", publicClient: fakeClient, agent });
    await expect(pw.execute({ to: SHOP, value: 1n, reason: "x" })).rejects.toBeInstanceOf(ApprovalPending);
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith("/agent/grants"))).toHaveLength(1);
    const escalation = f.mock.calls.find((c) => String(c[0]).endsWith("/agent/requests"));
    expect(JSON.parse(String(escalation?.[1]?.body)).account).toBe(ACCOUNT);
  });

  it("maps refusals to PolicyViolation with the reason code", async () => {
    mockFetch((url) =>
      url.endsWith("/agent/grants")
        ? { status: 200, body: [] }
        : { status: 403, body: { error: "forbidden", message: "nope" } },
    );
    const err = await agentPw()
      .execute({ to: SHOP, value: 1n, reason: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PolicyViolation);
    expect(err.reason).toBe("forbidden");
  });

  it("waitForApproval throws ApprovalRejected / ApprovalExpired", async () => {
    mockFetch(() => ({ status: 200, body: req("rejected") }));
    await expect(agentPw().waitForApproval("r1", { pollMs: 1 })).rejects.toBeInstanceOf(ApprovalRejected);
    mockFetch(() => ({ status: 200, body: req("expired") }));
    await expect(agentPw().waitForApproval("r1", { pollMs: 1 })).rejects.toBeInstanceOf(ApprovalExpired);
  });

  it("retries network errors and 5xx, then succeeds", async () => {
    let n = 0;
    const f = mockFetch(() =>
      ++n === 1 ? new Error("ECONNRESET") : n === 2 ? { status: 503, body: {} } : { status: 200, body: [] },
    );
    expect(await agentPw().getGrants()).toEqual([]);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx and gives up after the attempt budget", async () => {
    const f = mockFetch(() => ({ status: 500, body: { error: "boom" } }));
    await expect(agentPw().getGrants()).rejects.toBeInstanceOf(PolicyServiceError);
    expect(f).toHaveBeenCalledTimes(3);
    const g = mockFetch(() => ({ status: 404, body: { error: "nope" } }));
    await expect(agentPw().getRequest("x")).rejects.toBeInstanceOf(PolicyServiceError);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it("owner methods without an owner signer throw MissingSigner", async () => {
    await expect(agentPw().revoke("g1")).rejects.toBeInstanceOf(MissingSigner);
  });
});
