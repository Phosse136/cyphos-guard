/**
 * Recovery without cyphos-guard, on a Base Sepolia fork: a Hybrid DeleGator account whose owner EOA (the recovery
 * address) empties it through an EIP-1193 wallet only: USDC, ETH and the EntryPoint deposit. A stranger can't.
 */
import { ensureFork } from "@cyphos-guard/sdk/testing";
import {
  type Address,
  type Chain,
  createPublicClient,
  erc20Abi,
  http,
  type PublicClient,
  parseEther,
  parseUnits,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recoverableAccount, testWallet } from "./fork-fixture.ts";
import {
  buildUserOp,
  encodeBatchExecute,
  inspect,
  RecoveryError,
  signAndSubmit,
  USDC,
  withdrawAllCalls,
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
