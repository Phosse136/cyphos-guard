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
  getContractAddress,
  type Hex,
  keccak256,
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
