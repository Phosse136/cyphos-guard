/**
 * Owner-side actions on the Hybrid smart account (deploy, revoke).
 *
 * The account only executes calls that come through the ERC-4337 EntryPoint. Instead of depending on
 * a bundler service, the owner's EOA submits its own signed userOp via `EntryPoint.handleOps`
 * ("self-bundling"). The EntryPoint is permissionless, so this is the same code path a bundler takes,
 * and it works identically on a local anvil fork and on Base Sepolia. See ADR 0003.
 */
import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import {
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  parseEventLogs,
  type Transport,
  type WalletClient,
} from "viem";
import {
  entryPoint07Abi,
  entryPoint07Address,
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";

type OwnerWallet = WalletClient<Transport, Chain, Account>;

/** Deploy the counterfactual account via its factory. No-op if already deployed. Returns tx hash or null. */
export async function deployAccount(
  account: MetaMaskSmartAccount,
  ownerWallet: OwnerWallet,
  publicClient: PublicClient,
) {
  if (await account.isDeployed()) return null;
  const { factory, factoryData } = await account.getFactoryArgs();
  if (!factory || !factoryData) throw new Error("account has no factory args");
  const hash = await ownerWallet.sendTransaction({ to: factory, data: factoryData });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !(await account.isDeployed())) throw new Error(`deploy failed: ${hash}`);
  return hash;
}

/**
 * Sign a userOp with the account's owner signer and submit it through EntryPoint.handleOps from the
 * owner's EOA. Gas is prefunded from the smart account's own balance; the owner EOA is the beneficiary.
 */
export async function executeAsOwner(
  account: MetaMaskSmartAccount,
  ownerWallet: OwnerWallet,
  publicClient: PublicClient,
  calls: { to: `0x${string}`; data?: Hex; value?: bigint }[],
) {
  const [nonce, callData, fees] = await Promise.all([
    account.getNonce(),
    account.encodeCalls(calls),
    publicClient.estimateFeesPerGas(),
  ]);
  const userOp: UserOperation<"0.7"> = {
    sender: account.address,
    nonce,
    callData,
    // Fixed, generous limits: the account is already deployed and validation is a single ECDSA/1271 check.
    callGasLimit: 300_000n,
    verificationGasLimit: 500_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: fees.maxFeePerGas * 2n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    signature: "0x",
  };
  // Revocation must work even if the smart account's ETH balance is empty (e.g. the agent spent it).
  // So the owner EOA tops up the account's EntryPoint deposit to cover the max gas cost; the
  // EntryPoint then takes no prefund from the account's balance (unused deposit stays withdrawable).
  const maxCost = (userOp.callGasLimit + userOp.verificationGasLimit + userOp.preVerificationGas) * userOp.maxFeePerGas;
  const deposit = await publicClient.readContract({
    address: entryPoint07Address,
    abi: entryPoint07Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (deposit < maxCost) {
    const topUp = await ownerWallet.writeContract({
      address: entryPoint07Address,
      abi: entryPoint07Abi,
      functionName: "depositTo",
      args: [account.address],
      value: maxCost - deposit,
    });
    await publicClient.waitForTransactionReceipt({ hash: topUp });
  }

  userOp.signature = await account.signUserOperation({ ...userOp, chainId: ownerWallet.chain.id });

  const hash = await ownerWallet.writeContract({
    address: entryPoint07Address,
    abi: entryPoint07Abi,
    functionName: "handleOps",
    args: [[toPackedUserOperation(userOp)], ownerWallet.account.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // handleOps does NOT revert when the inner call fails; the outcome is in UserOperationEvent.success.
  const [event] = parseEventLogs({ abi: entryPoint07Abi, logs: receipt.logs, eventName: "UserOperationEvent" });
  if (receipt.status !== "success" || !event?.args.success) throw new Error(`owner userOp failed: ${hash}`);
  return hash;
}
