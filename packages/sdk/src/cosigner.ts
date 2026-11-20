/**
 * Co-signer support (ADR 0005). A policy with `cosigner` gets a CosignerEnforcer caveat on every grant
 * delegation: each redemption then needs a fresh cosignature from that address over the exact execution.
 * The policy service only co-signs when the off-chain rules pass, which makes those rules binding.
 *
 * The enforcer is deployed with the standard CREATE2 deployer, so it has the same address on every chain
 * and fork: anyone can deploy it, nobody owns it.
 */
import type { Delegation } from "@metamask/smart-accounts-kit";
import { createExecution } from "@metamask/smart-accounts-kit";
import { encodeSingleExecution, hashDelegation } from "@metamask/smart-accounts-kit/utils";
import { cosignerEnforcerBytecode } from "@phoswallet/contracts";
import {
  type Account,
  type Address,
  type Chain,
  concat,
  encodeAbiParameters,
  getContractAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  type PublicClient,
  type Transport,
  toHex,
  type WalletClient,
} from "viem";
import type { Execution } from "./delegations.ts";

/** Arachnid's deterministic deployment proxy (present on Base Sepolia, Sepolia and anvil forks of them). */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
export const COSIGNER_ENFORCER_SALT: Hex = keccak256(toHex("phoswallet:CosignerEnforcer:v1"));

/** Address of the CosignerEnforcer (deterministic: depends only on the compiled bytecode and salt). */
export const cosignerEnforcerAddress: Address = getContractAddress({
  opcode: "CREATE2",
  from: CREATE2_DEPLOYER,
  salt: COSIGNER_ENFORCER_SALT,
  bytecode: cosignerEnforcerBytecode,
});

/** Deploy the enforcer if it isn't on this chain yet. Any funded account can do this. Returns tx hash or null. */
export async function deployCosignerEnforcer(wallet: WalletClient<Transport, Chain, Account>, client: PublicClient) {
  if (await client.getCode({ address: cosignerEnforcerAddress })) return null;
  const hash = await wallet.sendTransaction({
    to: CREATE2_DEPLOYER,
    data: concat([COSIGNER_ENFORCER_SALT, cosignerEnforcerBytecode]),
  });
  await client.waitForTransactionReceipt({ hash });
  if (!(await client.getCode({ address: cosignerEnforcerAddress }))) throw new Error(`deploy failed: ${hash}`);
  return hash;
}

/** The caveat the compiler adds when a policy names a co-signer. `args` are filled in per redemption. */
export function cosignerCaveat(cosigner: Address) {
  return { enforcer: cosignerEnforcerAddress, terms: cosigner.toLowerCase() as Hex, args: "0x" as Hex };
}

/** The co-signer required by this delegation, if any. */
export function delegationCosigner(delegation: Pick<Delegation, "caveats">): Address | null {
  const c = delegation.caveats.find((cv) => isAddressEqual(cv.enforcer, cosignerEnforcerAddress));
  return c ? (c.terms as Address) : null;
}

export type CosignRequest = {
  chainId: number;
  delegationManager: Address;
  delegation: Delegation;
  redeemer: Address;
  execution: Execution;
  salt: Hex;
  deadline: bigint;
};

/** EIP-712 typed data the co-signer signs (must match CosignerEnforcer.COSIGN_TYPEHASH and its domain). */
export function cosignTypedData(r: CosignRequest) {
  const executionCallData = encodeSingleExecution(
    createExecution({ target: r.execution.to, value: r.execution.value ?? 0n, callData: r.execution.data ?? "0x" }),
  );
  return {
    domain: {
      name: "phoswallet CosignerEnforcer",
      version: "1",
      chainId: r.chainId,
      verifyingContract: cosignerEnforcerAddress,
    },
    types: {
      Cosign: [
        { name: "delegationManager", type: "address" },
        { name: "delegationHash", type: "bytes32" },
        { name: "redeemer", type: "address" },
        { name: "executionHash", type: "bytes32" },
        { name: "salt", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Cosign",
    message: {
      delegationManager: r.delegationManager,
      // Same struct hash the DelegationManager passes to the hook (covers enforcer + terms, not args).
      delegationHash: hashDelegation(r.delegation),
      redeemer: r.redeemer,
      executionHash: keccak256(executionCallData),
      salt: r.salt,
      deadline: r.deadline,
    },
  } as const;
}

export type Cosignature = { salt: Hex; deadline: string; signature: Hex };

/** Copy of `delegation` with the cosignature placed into the CosignerEnforcer caveat's `args`. */
export function withCosignature(delegation: Delegation, c: Cosignature): Delegation {
  const args = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes" }],
    [c.salt, BigInt(c.deadline), c.signature],
  );
  return {
    ...delegation,
    caveats: delegation.caveats.map((cv) =>
      isAddressEqual(cv.enforcer, cosignerEnforcerAddress) ? { ...cv, args } : cv,
    ),
  };
}
