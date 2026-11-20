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
  toHex,
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

/** Unsigned userOp for `calls` with fixed, generous gas limits (no bundler estimation round-trip). */
export async function buildUserOp(
  account: MetaMaskSmartAccount,
  publicClient: PublicClient,
  calls: { to: `0x${string}`; data?: Hex; value?: bigint }[],
): Promise<UserOperation<"0.7">> {
  const [nonce, callData, fees, deployed] = await Promise.all([
    account.getNonce(),
    account.encodeCalls(calls),
    publicClient.estimateFeesPerGas(),
    account.isDeployed(),
  ]);
  const init = deployed ? {} : await account.getFactoryArgs();
  return {
    sender: account.address,
    nonce,
    callData,
    ...(init.factory && init.factoryData ? { factory: init.factory, factoryData: init.factoryData } : {}),
    // Validation is one ECDSA/ERC-1271/P-256 check; deployment (first op) needs more.
    callGasLimit: 300_000n,
    verificationGasLimit: deployed ? 800_000n : 2_000_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: fees.maxFeePerGas * 2n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    signature: "0x",
  };
}

/**
 * Submit a *signed* userOp through EntryPoint.handleOps from `submitter` (any funded EOA: the owner's
 * recovery key, or the fork-only dev relayer). The submitter cannot alter the op: any change breaks
 * the owner's signature. Returns the tx hash; throws if the inner call failed.
 */
export async function submitUserOp(userOp: UserOperation<"0.7">, submitter: OwnerWallet, publicClient: PublicClient) {
  // Revocation must work even if the smart account's ETH balance is empty (e.g. the agent spent it).
  // So the submitter tops up the account's EntryPoint deposit to cover the max gas cost; the
  // EntryPoint then takes no prefund from the account's balance (unused deposit stays withdrawable).
  const maxCost = (userOp.callGasLimit + userOp.verificationGasLimit + userOp.preVerificationGas) * userOp.maxFeePerGas;
  const deposit = await publicClient.readContract({
    address: entryPoint07Address,
    abi: entryPoint07Abi,
    functionName: "balanceOf",
    args: [userOp.sender],
  });
  if (deposit < maxCost) {
    const topUp = await submitter.writeContract({
      address: entryPoint07Address,
      abi: entryPoint07Abi,
      functionName: "depositTo",
      args: [userOp.sender],
      value: maxCost - deposit,
    });
    await publicClient.waitForTransactionReceipt({ hash: topUp });
  }

  const hash = await submitter.writeContract({
    address: entryPoint07Address,
    abi: entryPoint07Abi,
    functionName: "handleOps",
    args: [[toPackedUserOperation(userOp)], submitter.account.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // handleOps does NOT revert when the inner call fails; the outcome is in UserOperationEvent.success.
  const [event] = parseEventLogs({ abi: entryPoint07Abi, logs: receipt.logs, eventName: "UserOperationEvent" });
  if (receipt.status !== "success" || !event?.args.success) throw new Error(`userOp failed: ${hash}`);
  return hash;
}

/** Sign with the account's owner signer (EOA or passkey) and submit from `submitter`. */
export async function executeAsOwner(
  account: MetaMaskSmartAccount,
  submitter: OwnerWallet,
  publicClient: PublicClient,
  calls: { to: `0x${string}`; data?: Hex; value?: bigint }[],
) {
  const userOp = await buildUserOp(account, publicClient, calls);
  userOp.signature = await account.signUserOperation({ ...userOp, chainId: submitter.chain.id });
  return submitUserOp(userOp, submitter, publicClient);
}

// ---------- JSON transport for userOps (bigint ⇄ hex) ----------
const BIG_FIELDS = [
  "nonce",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
] as const;

export type UserOpJSON = Record<string, string>;

export function userOpToJSON(op: UserOperation<"0.7">): UserOpJSON {
  const out: UserOpJSON = {};
  for (const [k, v] of Object.entries(op)) if (v !== undefined) out[k] = typeof v === "bigint" ? toHex(v) : String(v);
  return out;
}

export function userOpFromJSON(json: UserOpJSON): UserOperation<"0.7"> {
  const op: Record<string, unknown> = { ...json };
  for (const k of BIG_FIELDS) op[k] = BigInt(json[k] ?? "0x0");
  return op as unknown as UserOperation<"0.7">;
}

/** Hybrid DeleGator key id we use for a passkey: the credential id, hex-encoded (same string at deploy and sign). */
export function passkeyKeyId(credentialId: string): Hex {
  return toHex(credentialId);
}
