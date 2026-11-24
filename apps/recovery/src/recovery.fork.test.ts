/**
 * Recovery without cyphos-guard, on a Base Sepolia fork: a Hybrid DeleGator account whose owner EOA (the recovery
 * address) empties it through an EIP-1193 wallet only: USDC, ETH and the EntryPoint deposit. A stranger can't.
 * And the emergency stop: removing the passkey kills every delegation it signed.
 */
import { buildApprovalDelegation, encodeRedeem, vaultDeployment } from "@cyphos-guard/sdk";
import { createSoftPasskey, ensureFork, fundUsdc } from "@cyphos-guard/sdk/testing";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  type Hex,
  http,
  type PublicClient,
  parseEther,
  parseUnits,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recoverableAccount, recoverableSmartAccount, testWallet } from "./fork-fixture.ts";
import {
  buildUserOp,
  encodeBatchExecute,
  inspect,
  inspectVaults,
  RecoveryError,
  signAndSubmit,
  stopAgentsCalls,
  USDC,
  withdrawAllCalls,
  withdrawVaultCalls,
} from "./recovery.ts";

const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
const chain: Chain = baseSepolia;
const recoveryKey = generatePrivateKey();
const recovery = privateKeyToAccount(recoveryKey);
let publicClient: PublicClient;
let account: Address;
let kill: (() => void) | undefined;

const usdcOf = (a: Address) =>
  publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });

beforeAll(async () => {
  const anvil = await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");
  kill = () => anvil?.kill();
  publicClient = createPublicClient({ chain, transport: http(FORK) });
  account = await recoverableAccount(publicClient, FORK, recovery.address);
});

afterAll(() => kill?.());

describe("recovery page core (fork)", () => {
  it("reads the account: deployed, recovery address, balances, EntryPoint deposit", async () => {
    const s = await inspect(testWallet(recoveryKey, FORK), account);
    expect(s).toMatchObject({
      deployed: true,
      recovery: recovery.address,
      eth: parseEther("0.003"),
      usdc: parseUnits("14.8", 6),
      deposit: parseEther("0.001"),
    });
  });

  it("a stranger's signature is refused by the account (nothing moves)", async () => {
    const stranger = generatePrivateKey();
    const strangerAddr = privateKeyToAccount(stranger).address;
    await publicClient.request({
      method: "anvil_setBalance" as never,
      params: [strangerAddr, toHex(parseEther("0.01"))] as never,
    });
    const wallet = testWallet(stranger, FORK);
    const s = await inspect(wallet, account);
    const op = await buildUserOp(wallet, account, encodeBatchExecute(withdrawAllCalls(s, strangerAddr)));
    await expect(signAndSubmit(wallet, strangerAddr, op)).rejects.toThrow();
    expect(await usdcOf(account)).toBe(parseUnits("14.8", 6));
  });

  it("the recovery address empties the account into itself: USDC, ETH and the deposit, without cyphos-guard", async () => {
    const wallet = testWallet(recoveryKey, FORK);
    const s = await inspect(wallet, account);
    const ethBefore = await publicClient.getBalance({ address: recovery.address });
    const op = await buildUserOp(wallet, account, encodeBatchExecute(withdrawAllCalls(s, recovery.address)));
    const hash = await signAndSubmit(wallet, recovery.address, op);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    const after = await inspect(wallet, account);
    expect(after).toMatchObject({ eth: 0n, usdc: 0n, deposit: 0n });
    expect(await usdcOf(recovery.address)).toBe(parseUnits("14.8", 6));
    // Got 0.003 + 0.001 ETH back, minus only its own transaction's fees: gas, plus on OP-stack chains (Base) a
    // small L1 data fee that a local fork may charge without reporting it in the receipt.
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const gasFee = receipt.gasUsed * receipt.effectiveGasPrice;
    const gained = (await publicClient.getBalance({ address: recovery.address })) - ethBefore;
    expect(gained).toBeLessThanOrEqual(parseEther("0.004") - gasFee);
    expect(gained).toBeGreaterThan(parseEther("0.004") - gasFee - parseEther("0.00001"));
  });

  it("refuses to sign for something that isn't a Hybrid DeleGator", async () => {
    const wallet = testWallet(recoveryKey, FORK);
    const op = await buildUserOp(wallet, USDC, "0x");
    await expect(signAndSubmit(wallet, recovery.address, op)).rejects.toThrow();
    expect(RecoveryError).toBeDefined();
  });
});

describe("emergency stop (fork)", () => {
  it("removing the passkey stops every delegation it signed; the recovery address can still withdraw", async () => {
    const env = getSmartAccountsEnvironment(chain.id);
    const key = generatePrivateKey();
    const rec = privateKeyToAccount(key);
    const passkey = createSoftPasskey();
    const sa = await recoverableSmartAccount(publicClient, FORK, rec.address, passkey);
    const agent = privateKeyToAccount(generatePrivateKey());
    await publicClient.request({
      method: "anvil_setBalance" as never,
      params: [agent.address, toHex(parseEther("0.01"))] as never,
    });
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    const now = Number((await publicClient.getBlock()).timestamp);
    const unsigned = buildApprovalDelegation({
      environment: env,
      delegator: sa.address,
      agent: agent.address,
      execution: { to: payee, value: parseEther("0.001") },
      expiresAt: now + 900,
    });
    const approval = { ...unsigned, signature: await sa.signDelegation({ delegation: unsigned }) };
    const redeem = () =>
      publicClient.call({
        account: agent,
        to: env.DelegationManager,
        data: encodeRedeem(approval, { to: payee, value: parseEther("0.001") }),
      });

    await expect(redeem()).resolves.toBeDefined(); // the passkey-signed delegation works

    const wallet = testWallet(key, FORK);
    const s = await inspect(wallet, sa.address);
    expect(s.passkeys).toBe(1);
    await signAndSubmit(
      wallet,
      rec.address,
      await buildUserOp(wallet, sa.address, encodeBatchExecute(stopAgentsCalls(s))),
    );

    const stopped = await inspect(wallet, sa.address);
    expect(stopped).toMatchObject({ passkeys: 0, recovery: rec.address, usdc: parseUnits("14.8", 6) });
    await expect(redeem()).rejects.toThrow(); // ...and now it doesn't

    const op = await buildUserOp(wallet, sa.address, encodeBatchExecute(withdrawAllCalls(stopped, rec.address)));
    await signAndSubmit(wallet, rec.address, op);
    expect(await inspect(wallet, sa.address)).toMatchObject({ eth: 0n, usdc: 0n, deposit: 0n });
  });

  it("a stranger can't trigger it", async () => {
    const stranger = generatePrivateKey();
    const strangerAddr = privateKeyToAccount(stranger).address;
    await publicClient.request({
      method: "anvil_setBalance" as never,
      params: [strangerAddr, toHex(parseEther("0.01"))] as never,
    });
    const sa = await recoverableSmartAccount(publicClient, FORK, recovery.address, createSoftPasskey());
    const wallet = testWallet(stranger, FORK);
    const s = await inspect(wallet, sa.address);
    const op = await buildUserOp(wallet, sa.address, encodeBatchExecute(stopAgentsCalls(s)));
    await expect(signAndSubmit(wallet, strangerAddr, op)).rejects.toThrow();
    expect((await inspect(wallet, sa.address)).passkeys).toBe(1);
  });
});

// Issue #2: the emergency stop removes the passkey but can't switch off an x402 vault, and the app's passkey-signed
// vault withdraw no longer works afterwards. The recovery address empties the vault through the account instead.
describe("x402 vaults (fork)", () => {
  /** Deploys an X402Vault owned by `owner` through the public CREATE2 deployer, holding `usdc`. */
  async function vaultOf(owner: Address, payerKey: Hex, usdc: bigint) {
    const d = vaultDeployment({
      owner,
      agent: privateKeyToAccount(generatePrivateKey()).address,
      token: USDC,
      maxPerPayment: parseUnits("1", 6),
      sellers: [privateKeyToAccount(generatePrivateKey()).address],
      salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    });
    const w = createWalletClient({ account: privateKeyToAccount(payerKey), chain, transport: http(FORK) });
    await publicClient.waitForTransactionReceipt({ hash: await w.sendTransaction(d.call) });
    if (usdc > 0n) await fundUsdc(publicClient, d.address, usdc);
    return d.address;
  }

  it("after the emergency stop, the recovery address withdraws what's left in the account's vaults", async () => {
    const key = generatePrivateKey();
    const rec = privateKeyToAccount(key);
    const sa = await recoverableSmartAccount(publicClient, FORK, rec.address, createSoftPasskey());
    const full = await vaultOf(sa.address, key, parseUnits("0.7", 6));
    const empty = await vaultOf(sa.address, key, 0n);
    const wallet = testWallet(key, FORK);
    await signAndSubmit(
      wallet,
      rec.address,
      await buildUserOp(wallet, sa.address, encodeBatchExecute(stopAgentsCalls(await inspect(wallet, sa.address)))),
    );

    const vaults = await inspectVaults(wallet, sa.address, [full, empty, full]);
    expect(vaults.map((v) => v.balance)).toEqual([parseUnits("0.7", 6), 0n]); // de-duplicated
    const calls = withdrawVaultCalls(vaults, rec.address);
    expect(calls).toHaveLength(1); // nothing for the empty vault
    const stopped = await inspect(wallet, sa.address);
    const op = await buildUserOp(
      wallet,
      sa.address,
      encodeBatchExecute([...withdrawAllCalls(stopped, rec.address), ...calls]),
    );
    await signAndSubmit(wallet, rec.address, op);
    expect(await usdcOf(full)).toBe(0n);
    expect(await usdcOf(rec.address)).toBe(parseUnits("14.8", 6) + parseUnits("0.7", 6));
  });

  it("refuses an address that isn't a vault of this account (a foreign vault, a token, a typo'd EOA)", async () => {
    const key = generatePrivateKey();
    const rec = privateKeyToAccount(key);
    const sa = await recoverableSmartAccount(publicClient, FORK, rec.address);
    const foreign = await vaultOf(account, key, parseUnits("0.1", 6));
    const wallet = testWallet(key, FORK);
    for (const a of [foreign, USDC, privateKeyToAccount(generatePrivateKey()).address]) {
      await expect(inspectVaults(wallet, sa.address, [a])).rejects.toBeInstanceOf(RecoveryError);
    }
  });
});
