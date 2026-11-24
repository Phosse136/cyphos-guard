/**
 * X402Vault helpers (EXPERIMENTAL contract, not audited). The vault is the x402 payer for one agent: it approves
 * only USDC TransferWithAuthorization from itself to listed sellers, up to its cap, signed by the agent. So the
 * seller list is enforced on-chain (see packages/contracts/src/X402Vault.sol).
 *
 * Deployed by the owner's smart account through the standard CREATE2 deployer, so the address is known before
 * deployment and can go into the policy the owner signs.
 */
import { x402VaultAbi, x402VaultBytecode } from "@cyphos-guard/contracts/x402-vault";
import {
  type Address,
  concat,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  getContractAddress,
  type Hex,
  keccak256,
  maxUint256,
  type PublicClient,
  toHex,
} from "viem";
import { CREATE2_DEPLOYER } from "./cosigner.ts";

export { x402VaultAbi };

export type VaultParams = {
  /** The owner's smart account: manages sellers, withdraws. */
  owner: Address;
  agent: Address;
  token: Address;
  maxPerPayment: bigint;
  sellers: Address[];
  /** Any unique value per vault (e.g. random). */
  salt: Hex;
};

/** The vault's address and the call (from the owner's account) that deploys it via the CREATE2 deployer. */
export function vaultDeployment(p: VaultParams) {
  const initCode = encodeDeployData({
    abi: x402VaultAbi,
    bytecode: x402VaultBytecode,
    args: [p.owner, p.agent, p.token, p.maxPerPayment, p.sellers],
  });
  const salt = keccak256(concat([p.owner, p.salt]));
  return {
    address: getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: initCode }),
    call: { to: CREATE2_DEPLOYER, data: concat([salt, initCode]) },
  };
}

export const randomVaultSalt = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Salt for the vault of permission `index` in the agent's grant number `grantNumber` (= how many grants, active or
 * revoked, the agent had before). Deterministic, so retrying a failed grant finds the vault it already deployed;
 * the owner and the constructor args (agent, token, cap, sellers) are part of the address anyway.
 */
export const grantVaultSalt = (grantNumber: number, index: number): Hex =>
  keccak256(toHex(`cyphos-guard:x402-vault:grant-${grantNumber}:permission-${index}`));

/**
 * The bytes the vault's isValidSignature expects: the payment fields (so it can recompute the EIP-712 digest and
 * check the seller and cap) plus the agent's 65-byte signature over that digest.
 */
export function encodeVaultSignature(
  a: { to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex },
  agentSignature: Hex,
): Hex {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes" },
    ],
    [a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, agentSignature],
  );
}

/** Reads a deployed vault's configuration (for verifying it matches a policy). */
export async function readVault(client: PublicClient, vault: Address, sellers: Address[]) {
  const read = <T>(functionName: "owner" | "agent" | "token" | "maxPerPayment") =>
    client.readContract({ address: vault, abi: x402VaultAbi, functionName }) as Promise<T>;
  const [owner, agent, token, maxPerPayment, listed] = await Promise.all([
    read<Address>("owner"),
    read<Address>("agent"),
    read<Address>("token"),
    read<bigint>("maxPerPayment"),
    Promise.all(
      sellers.map(
        (s) =>
          client.readContract({
            address: vault,
            abi: x402VaultAbi,
            functionName: "isSeller",
            args: [s],
          }) as Promise<boolean>,
      ),
    ),
  ]);
  return { owner, agent, token, maxPerPayment, allSellersListed: listed.every(Boolean) };
}

/** The x402 vaults a grant's policy names (one per x402 permission), with the token each one pays in. */
export function grantVaults(policy: unknown): { address: Address; token: Address }[] {
  const permissions = (policy as { permissions?: { kind?: string; vault?: Address; token?: Address }[] }).permissions;
  return (permissions ?? []).flatMap((p) =>
    p.kind === "x402" && p.vault && p.token ? [{ address: p.vault, token: p.token }] : [],
  );
}

/**
 * Whether a vault is switched off: true/false for vaults with `disable()`, null for vaults deployed before it
 * existed (their bytecode has no `disabled()`, so the call reverts) or no contract at all.
 */
export async function vaultDisabled(client: PublicClient, vault: Address): Promise<boolean | null> {
  try {
    return (await client.readContract({ address: vault, abi: x402VaultAbi, functionName: "disabled" })) as boolean;
  } catch {
    return null;
  }
}

/**
 * Calls (sent from the owner's smart account, the vault's owner) that retire each vault when its grant is revoked
 * or replaced: switch it off and move its whole token balance to `to`.
 *
 * - Vaults with `disable()` (review finding 9): `disable()`, so authorizations the agent key signed earlier stop
 *   working too, then `withdraw(token, to, max)`, which takes the balance at execution time (no race with a
 *   payment landing first). Already-disabled vaults only get the withdraw, empty ones only the disable.
 * - Older vaults (no `disable()`): they approve agent-signed payments to listed sellers for as long as they exist,
 *   so they are emptied (issue #2). The amount is read now and withdrawn exactly; if an agent payment lowers it
 *   before the transaction lands, the transaction reverts and the owner retries with the smaller balance.
 */
export async function vaultSweepCalls(
  client: PublicClient,
  vaults: { address: Address; token: Address }[],
  to: Address,
): Promise<{ to: Address; data: Hex }[]> {
  const unique = [...new Map(vaults.map((v) => [`${v.address.toLowerCase()}:${v.token.toLowerCase()}`, v])).values()];
  const state = await Promise.all(
    unique.map(async (v) => {
      const [balance, disabled] = await Promise.all([
        client.readContract({ address: v.token, abi: erc20Abi, functionName: "balanceOf", args: [v.address] }),
        vaultDisabled(client, v.address),
      ]);
      return { balance, disabled };
    }),
  );
  const withdraw = (v: { address: Address; token: Address }, amount: bigint) => ({
    to: v.address,
    data: encodeFunctionData({ abi: x402VaultAbi, functionName: "withdraw", args: [v.token, to, amount] }),
  });
  const disable = (v: { address: Address }) => ({
    to: v.address,
    data: encodeFunctionData({ abi: x402VaultAbi, functionName: "disable" }),
  });
  // One disable per vault address, even if it is listed with several tokens.
  const disabling = new Set<string>();
  return unique.flatMap((v, i) => {
    const { balance = 0n, disabled = null } = state[i] ?? {};
    const calls: { to: Address; data: Hex }[] = [];
    if (disabled === false && !disabling.has(v.address.toLowerCase())) {
      disabling.add(v.address.toLowerCase());
      calls.push(disable(v));
    }
    if (balance > 0n) calls.push(withdraw(v, disabled === null ? balance : maxUint256));
    return calls;
  });
}
