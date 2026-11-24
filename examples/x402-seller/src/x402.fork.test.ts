/**
 * cyphos-guard pays x402 APIs, proven against the OFFICIAL x402 server and facilitator (@x402/core +
 * @x402/evm 2.30) on a Base Sepolia fork: the seller's facilitator really settles the agent's EIP-3009
 * authorization on-chain. Routine payment, escalation with owner approval, forbidden seller, max-amount guard.
 */
import { createApp } from "@cyphos-guard/policy-service/app";
import { createChainAdapter } from "@cyphos-guard/policy-service/chain";
import { openStore } from "@cyphos-guard/policy-service/store";
import { setupSoftOwner } from "@cyphos-guard/policy-service/testing";
import { createCyphosGuard, X402Error, x402VaultAbi } from "@cyphos-guard/sdk";
import { ensureFork, fundUsdc } from "@cyphos-guard/sdk/testing";
import { serve } from "@hono/node-server";
import {
  type Address,
  type Chain,
  createPublicClient,
  erc20Abi,
  http,
  type PublicClient,
  parseEther,
  parseEventLogs,
  parseUnits,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSellerApp, localFacilitator, USDC } from "./seller.ts";

const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const chain: Chain = baseSepolia;
const SELLER = privateKeyToAddress(generatePrivateKey());
const MIXER = privateKeyToAddress(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const facilitatorKey = privateKeyToAccount(generatePrivateKey());
const closers: (() => void)[] = [];
let publicClient: PublicClient;
let owner: Awaited<ReturnType<typeof setupSoftOwner>>["owner"];
let pw: ReturnType<typeof createCyphosGuard>;
let shop: string;
let shady: string;
let vault: Address;

const listen = async (fetch: (r: Request) => Response | Promise<Response>) => {
  const s = serve({ fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => s.once("listening", r));
  closers.push(() => s.close());
  const a = s.address();
  return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
};
const usdcOf = (a: Address) =>
  publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const setEth = (a: Address) =>
  publicClient.request({ method: "anvil_setBalance" as never, params: [a, toHex(parseEther("1"))] as never });

beforeAll(async () => {
  const anvil = await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
  closers.push(() => anvil?.kill());
  publicClient = createPublicClient({ chain, transport: http(FORK) });
  const adapter = await createChainAdapter({ rpcUrl: FORK, network: "fork" });
  await adapter.ensureEnforcers();
  const cosigner = privateKeyToAccount(generatePrivateKey());
  const serviceUrl = await listen(
    createApp({
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
  );
  ({ owner } = await setupSoftOwner({ serviceUrl, publicClient }));
  await setEth(agent.address);
  await setEth(facilitatorKey.address);
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
          kind: "x402",
          token: USDC,
          sellers: [SELLER],
          perTx: parseUnits("1", 6),
          perPeriod: { amount: parseUnits("5", 6), periodSeconds: 86_400 },
        },
      ],
      escalation: { enabled: true, approvalTtlSeconds: 600, hardMax: [{ token: USDC, amount: parseUnits("20", 6) }] },
      forbidden: { targets: [MIXER] },
    },
  });
  const facilitator = localFacilitator(facilitatorKey, FORK);
  shop = await listen(
    (
      await createSellerApp({
        payTo: SELLER,
        facilitator,
        products: [
          { path: "/data", description: "market data", amount: parseUnits("0.5", 6), body: { price: 42 } },
          { path: "/report", description: "deep report", amount: parseUnits("3", 6), body: { report: "long" } },
          { path: "/free", description: "free", amount: 0n, body: {} },
        ],
      })
    ).fetch,
  );
  shady = await listen(
    (
      await createSellerApp({
        payTo: MIXER,
        facilitator,
        products: [{ path: "/data", description: "scraped data", amount: parseUnits("0.1", 6), body: {} }],
      })
    ).fetch,
  );
  pw = createCyphosGuard({ policyServiceUrl: serviceUrl, publicClient, agent, rpcUrl: FORK });
  const [grant] = await owner.getGrants();
  if (!grant) throw new Error("no grant");
  const perm = (grant.policy as { permissions: { kind: string; vault?: Address }[] }).permissions[0];
  if (!perm?.vault) throw new Error("grantAgent did not set up an x402 vault");
  vault = perm.vault;
});

afterAll(() => {
  for (const close of closers.reverse()) close();
});

describe("x402 against the reference server + facilitator (fork)", () => {
  it("grantAgent deployed the agent's X402Vault, owned by the account, listing the seller", async () => {
    const read = (functionName: "owner" | "agent" | "maxPerPayment") =>
      publicClient.readContract({ address: vault, abi: x402VaultAbi, functionName });
    const isSeller = (a: Address) =>
      publicClient.readContract({ address: vault, abi: x402VaultAbi, functionName: "isSeller", args: [a] });
    expect((await read("agent")) as Address).toBe(agent.address);
    expect(await read("maxPerPayment")).toBe(parseUnits("20", 6)); // = hard max: approved larger payments can pay
    expect(await isSeller(SELLER)).toBe(true);
    expect(await isSeller(MIXER)).toBe(false);
  });

  it("pays a routine x402 price within limits: account → vault (exact shortfall) → seller, settled on-chain", async () => {
    const before = await usdcOf(SELLER);
    const r = await pw.payX402(`${shop}/data`, {}, { reason: "price check" });
    expect(r.paid).toBe(true);
    expect(await r.response.json()).toEqual({ price: 42 });
    expect(r.topUp?.via).toBe("grant");
    expect(r.settlement?.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await usdcOf(SELLER)) - before).toBe(parseUnits("0.5", 6));
    expect(await usdcOf(vault)).toBe(0n); // nothing left behind in the vault
    expect(await usdcOf(agent.address)).toBe(0n); // and the agent itself never holds funds
  });

  it("above the per-payment cap: asks the owner, pays after approval", async () => {
    const before = await usdcOf(SELLER);
    const paying = pw.payX402(`${shop}/report`, {}, { reason: "quarterly report", wait: { timeoutMs: 60_000 } });
    let pending: Awaited<ReturnType<typeof owner.getRequests>> = [];
    for (let i = 0; i < 60 && pending.length === 0; i++) {
      pending = await owner.getRequests("pending");
      if (!pending.length) await new Promise((r) => setTimeout(r, 500));
    }
    const [req] = pending;
    if (!req) throw new Error("no approval request");
    expect(req.reason).toMatch(/x402 payment to .* for .*\/report: quarterly report/);
    await owner.approve(req);
    const r = await paying;
    expect(r.paid).toBe(true);
    expect(r.topUp?.via).toBe("approval");
    expect((await usdcOf(SELLER)) - before).toBe(parseUnits("3", 6));
  });

  it("never pays a seller that isn't on the vault's list: refused before any money moves", async () => {
    const before = await usdcOf(vault);
    await expect(pw.payX402(`${shady}/data`, {}, { reason: "cheap data" })).rejects.toBeInstanceOf(X402Error);
    expect(await usdcOf(MIXER)).toBe(0n);
    expect(await usdcOf(vault)).toBe(before);
  });

  it("respects the caller's maxAmount and passes non-402 responses through", async () => {
    await expect(
      pw.payX402(`${shop}/data`, {}, { reason: "x", maxAmount: parseUnits("0.1", 6) }),
    ).rejects.toBeInstanceOf(X402Error);
    const notPaywalled = await pw.payX402(`${shop}/nope`, {}, { reason: "x" });
    expect(notPaywalled.paid).toBe(false);
    expect(notPaywalled.response.status).toBe(404);
  });

  it("records each settled payment in the owner's activity, verified from the chain", async () => {
    const activity = await owner.getActivity();
    const paid = activity.filter((a) => a.kind === "x402_paid");
    expect(paid).toHaveLength(2);
    expect(paid.every((a) => (a.detail as { payer: string }).payer === vault)).toBe(true);
    expect(paid.map((a) => (a.detail as { resource: string }).resource).sort()).toEqual([
      `${shop}/data`,
      `${shop}/report`,
    ]);
  });
});

// Issue #2: a vault can't be switched off, so whatever is left in it (e.g. a top-up whose settlement failed) stays
// spendable with the agent key after the owner revoked the agent. Revoking and re-granting therefore empty the
// grant's vaults back into the account, in the same transaction that disables the delegations.
describe("leftovers in a vault go back to the account (issue #2)", () => {
  const LEFTOVER = parseUnits("0.7", 6);
  const permsOf = (g: { policy: unknown }) =>
    (g.policy as { permissions: { kind: string; vault?: Address; vaultSalt?: string }[] }).permissions;

  it("re-granting the agent empties the old grant's vault into the account", async () => {
    const [old] = (await owner.getGrants()).filter((g) => g.status === "active");
    if (!old) throw new Error("no active grant");
    const oldVault = permsOf(old)[0]?.vault as Address;
    await fundUsdc(publicClient, oldVault, LEFTOVER); // as if a top-up's settlement had failed
    const before = await usdcOf(old.account);
    // Same policy, but let grantAgent derive a fresh vault (the next grant gets a new one).
    const policy = old.policy as Parameters<typeof owner.grantAgent>[0]["policy"];
    const fresh = await owner.grantAgent({
      policy: { ...policy, permissions: permsOf(old).map(({ vault: _v, vaultSalt: _s, ...p }) => p) as never },
    });
    const newVault = permsOf(fresh)[0]?.vault as Address;
    expect(newVault).not.toBe(oldVault);
    expect(await usdcOf(oldVault)).toBe(0n);
    expect((await usdcOf(old.account)) - before).toBe(LEFTOVER);
    vault = newVault;
  });

  it("revoking empties the vault in the same transaction, so the agent key has nothing left to pay from", async () => {
    const [grant] = (await owner.getGrants()).filter((g) => g.status === "active");
    if (!grant) throw new Error("no active grant");
    await fundUsdc(publicClient, vault, LEFTOVER);
    const before = await usdcOf(grant.account);
    const { txHash } = await owner.revoke(grant.id);
    expect(await usdcOf(vault)).toBe(0n);
    expect((await usdcOf(grant.account)) - before).toBe(LEFTOVER);
    // One transaction did both: the delegations are disabled and the vault was emptied.
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const withdrawn = parseEventLogs({ abi: x402VaultAbi, eventName: "Withdrawn", logs: receipt.logs });
    expect(withdrawn.map((l) => [l.address.toLowerCase(), l.args.amount])).toEqual([[vault.toLowerCase(), LEFTOVER]]);
    // The vault itself still accepts the agent's signature (it can't be disabled), but there is nothing to pay.
    expect(await usdcOf(vault)).toBe(0n);
  });

  it("revoking a grant whose vault is already empty adds no withdraw call", async () => {
    const now = Number((await publicClient.getBlock()).timestamp);
    const g = await owner.grantAgent({
      policy: {
        version: 1,
        chainId: 84532,
        agent: agent.address,
        validFrom: now - 60,
        expiresAt: now + 86_400,
        permissions: [
          {
            kind: "x402",
            token: USDC,
            sellers: [SELLER],
            perTx: parseUnits("1", 6),
            perPeriod: { amount: parseUnits("5", 6), periodSeconds: 86_400 },
          },
        ],
      },
    });
    const { txHash } = await owner.revoke(g.id);
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    expect(parseEventLogs({ abi: x402VaultAbi, eventName: "Withdrawn", logs: receipt.logs })).toEqual([]);
  });
});
