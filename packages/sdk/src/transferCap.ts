/**
 * Per-transfer cap for ERC-20 grants. When a permission has `perTx`, the compiler adds an
 * ERC20PerTransferCapEnforcer caveat: every single transfer under the delegation must be token.transfer(to, x)
 * with x <= perTx, enforced on-chain without a co-signer. Stateless; the period cap stays a separate caveat.
 *
 * Deployed with the standard CREATE2 deployer like the CosignerEnforcer: same address on every chain and fork,
 * anyone can deploy it, nobody owns it.
 */

import { erc20PerTransferCapEnforcerBytecode } from "@cyphos-guard/contracts/per-transfer-cap";
import {
  type Account,
  type Address,
  type Chain,
  concat,
  encodePacked,
  getContractAddress,
  type Hex,
  keccak256,
  type PublicClient,
  type Transport,
  toHex,
  type WalletClient,
} from "viem";
import { CREATE2_DEPLOYER } from "./cosigner.ts";

export const PER_TRANSFER_CAP_ENFORCER_SALT: Hex = keccak256(toHex("cyphos-guard:ERC20PerTransferCapEnforcer:v1"));

/** Address of the ERC20PerTransferCapEnforcer (deterministic: depends only on the compiled bytecode and salt). */
export const perTransferCapEnforcerAddress: Address = getContractAddress({
  opcode: "CREATE2",
  from: CREATE2_DEPLOYER,
  salt: PER_TRANSFER_CAP_ENFORCER_SALT,
  bytecode: erc20PerTransferCapEnforcerBytecode,
});

/** Deploy the enforcer if it isn't on this chain yet. Any funded account can do this. Returns tx hash or null. */
export async function deployPerTransferCapEnforcer(
  wallet: WalletClient<Transport, Chain, Account>,
  client: PublicClient,
) {
  if (await client.getCode({ address: perTransferCapEnforcerAddress })) return null;
  const hash = await wallet.sendTransaction({
    to: CREATE2_DEPLOYER,
    data: concat([PER_TRANSFER_CAP_ENFORCER_SALT, erc20PerTransferCapEnforcerBytecode]),
  });
  await client.waitForTransactionReceipt({ hash });
  if (!(await client.getCode({ address: perTransferCapEnforcerAddress }))) throw new Error(`deploy failed: ${hash}`);
  return hash;
}

/** The caveat: every transfer of `token` under the delegation is at most `maxAmount`. */
export function perTransferCapCaveat(token: Address, maxAmount: bigint) {
  return {
    enforcer: perTransferCapEnforcerAddress,
    terms: encodePacked(["address", "uint256"], [token, maxAmount]),
    args: "0x" as Hex,
  };
}
