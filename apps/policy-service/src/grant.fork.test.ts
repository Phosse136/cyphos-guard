/**
 * grantAgent passkey steps, on a Base Sepolia fork with the real policy service: how many prompts a grant and a
 * re-grant take, that cancelling a signature changes nothing on-chain, and that a retry after a half-finished
 * attempt reuses its vault and its revoke instead of doing them again.
 */
import { createCyphosGuard, type GrantProgress } from "@cyphos-guard/sdk";
import { ensureFork, USDC } from "@cyphos-guard/sdk/testing";
import type { PolicyInput } from "@cyphos-guard/shared";
import { serve } from "@hono/node-server";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { type Address, type Chain, createPublicClient, type Hex, http, type PublicClient, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createChainAdapter } from "./chain.ts";
import { openStore } from "./store.ts";
import { setupSoftOwner } from "./testing.ts";

const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const chain: Chain = baseSepolia;
const env = getSmartAccountsEnvironment(chain.id);
const SELLER = privateKeyToAddress(generatePrivateKey());
const SHOP = privateKeyToAddress(generatePrivateKey());
const agent = privateKeyToAddress(generatePrivateKey());
const cosigner = privateKeyToAccount(generatePrivateKey());
const closers: (() => void)[] = [];
let publicClient: PublicClient;
let owner: ReturnType<typeof createCyphosGuard>;
let isDisabled: (d: unknown) => Promise<boolean>;

// Passkey prompts, counted; and a switch to make one of them fail like a cancelled prompt.
const prompts = { sign: 0, tx: 0 };
let failNext: "sign" | "afterTx" | null = null;
let progress: GrantProgress[] = [];

const policy = async (withCosigner = true): Promise<PolicyInput> => {
  const now = Number((await publicClient.getBlock()).timestamp);
  return {
    version: 1,
    chainId: 84532,
    agent,
    validFrom: now - 60,
    expiresAt: now + 86_400,
    ...(withCosigner ? { cosigner: cosigner.address } : {}),
    permissions: [
      {
        kind: "erc20Transfer",
        token: USDC,
        recipients: [SHOP],
        perTx: parseUnits("2", 6).toString(),
        perPeriod: { amount: parseUnits("5", 6).toString(), periodSeconds: 86_400 },
      },
      {
        kind: "x402",
        token: USDC,
        sellers: [SELLER],
        perTx: parseUnits("1", 6).toString(),
        perPeriod: { amount: parseUnits("5", 6).toString(), periodSeconds: 86_400 },
      },
    ],
    escalation: {
      enabled: true,
      approvalTtlSeconds: 600,
      hardMax: [{ token: USDC, amount: parseUnits("20", 6).toString() }],
    },
  } as PolicyInput;
};
const grant = async () => {
  progress = [];
  prompts.sign = 0;
  prompts.tx = 0;
  return owner.grantAgent({ policy: await policy(), onProgress: (p) => progress.push(p) });
};
const vaultOf = (g: { policy: unknown }) =>
  (g.policy as { permissions: { kind: string; vault?: Address }[] }).permissions.find((p) => p.kind === "x402")
    ?.vault as Address;
const grantsOfAgent = async () => (await owner.getGrants()).filter((g) => g.agent === agent);

beforeAll(async () => {
  const anvil = await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
  closers.push(() => anvil?.kill());
  publicClient = createPublicClient({ chain, transport: http(FORK) });
  const adapter = await createChainAdapter({ rpcUrl: FORK, network: "fork" });
  await adapter.ensureEnforcers();
  isDisabled = (d) => adapter.isDisabled(d as never);
  const s = serve({
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
  await new Promise((r) => s.once("listening", r));
  closers.push(() => s.close());
  const a = s.address();
  const serviceUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  const soft = await setupSoftOwner({ serviceUrl, publicClient });

  const signDelegation = soft.account.signDelegation.bind(soft.account);
  soft.account.signDelegation = async (args) => {
    prompts.sign++;
    if (failNext === "sign") {
      failNext = null;
      throw new Error("NotAllowedError: the passkey prompt was cancelled");
    }
    return signDelegation(args);
  };
  const sendCalls = async (calls: { to: Address; data?: Hex; value?: bigint }[]) => {
    prompts.tx++;
    const hash = await soft.sendCalls(calls);
    if (failNext === "afterTx") {
      failNext = null;
      throw new Error("network error after the transaction was sent");
    }
    return hash;
  };
  owner = createCyphosGuard({
    policyServiceUrl: serviceUrl,
    publicClient,
    owner: { account: soft.account, sendCalls, fetch: soft.ownerFetch },
  });
});

afterAll(() => {
  for (const c of closers.reverse()) c();
});

describe("grantAgent passkey steps (fork)", () => {
  it("x402 works without the co-signer too (the vault binds sellers and cap)", async () => {
    const other = privateKeyToAddress(generatePrivateKey());
    const g = await owner.grantAgent({ policy: { ...(await policy(false)), agent: other } });
    expect(g.status).toBe("active");
    expect(await publicClient.getCode({ address: vaultOf(g) })).toBeTruthy();
  });

  it("first grant: one prompt per permission + one transaction for the vault", async () => {
    const g = await grant();
    expect(prompts).toEqual({ sign: 2, tx: 1 });
    expect(progress.map((p) => `${p.step}/${p.of} ${p.action}`)).toEqual(["1/3 sign", "2/3 sign", "3/3 transaction"]);
    expect(progress[2]?.label).toMatch(/set up the x402 vault$/);
    expect(await publicClient.getCode({ address: vaultOf(g) })).toBeTruthy();
  });

  it("re-grant: vault and revoke of the old grant in ONE transaction (3 prompts, was 4)", async () => {
    const [old] = await grantsOfAgent();
    const g = await grant();
    expect(prompts).toEqual({ sign: 2, tx: 1 });
    expect(progress[2]?.label).toMatch(/set up the x402 vault and replace the old grant/);
    const all = await grantsOfAgent();
    expect(all.filter((x) => x.status === "active").map((x) => x.id)).toEqual([g.id]);
    expect(all.find((x) => x.id === old?.id)?.status).toBe("revoked");
    for (const d of old?.delegations ?? []) expect(await isDisabled(d)).toBe(true);
    expect(vaultOf(g)).not.toBe(old && vaultOf(old)); // a fresh vault per grant
  });

  it("cancelling a signature changes nothing on-chain; the old grant stays active", async () => {
    const [active] = (await grantsOfAgent()).filter((x) => x.status === "active");
    failNext = "sign";
    await expect(grant()).rejects.toThrow(/cancelled/);
    expect(prompts.tx).toBe(0);
    expect((await grantsOfAgent()).filter((x) => x.status === "active").map((x) => x.id)).toEqual([active?.id]);
    for (const d of active?.delegations ?? []) expect(await isDisabled(d)).toBe(false);
  });

  it("a retry after a half-finished attempt reuses its vault and revoke: no second transaction", async () => {
    const [active] = (await grantsOfAgent()).filter((x) => x.status === "active");
    failNext = "afterTx"; // vault deployed + old grant revoked on-chain, then the app lost the connection
    await expect(grant()).rejects.toThrow(/network error/);
    expect(prompts).toEqual({ sign: 2, tx: 1 });
    const g = await grant();
    expect(prompts).toEqual({ sign: 2, tx: 0 }); // only the two signatures again
    expect(progress.map((p) => `${p.step}/${p.of} ${p.action}`)).toEqual(["1/2 sign", "2/2 sign"]);
    expect(await publicClient.getCode({ address: vaultOf(g) })).toBeTruthy();
    const all = await grantsOfAgent();
    expect(all.filter((x) => x.status === "active").map((x) => x.id)).toEqual([g.id]);
    expect(all.find((x) => x.id === active?.id)?.status).toBe("revoked");
    expect(env.DelegationManager).toBeTruthy();
  });
});
