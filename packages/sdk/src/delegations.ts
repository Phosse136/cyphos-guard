/** Encoding helpers around the DelegationManager (redeem as agent, disable as owner). */
import {
  createExecution,
  type Delegation,
  ExecutionMode,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import { decodeRevertReason } from "@metamask/smart-accounts-kit/utils";
import type { Address, Hex } from "viem";

export type Execution = { to: Address; value?: bigint; data?: Hex };

/**
 * Calldata the *agent* sends (as a plain EOA tx) to the DelegationManager to act on the owner's
 * behalf. The DelegationManager validates the delegation chain and runs every caveat enforcer;
 * any failing caveat reverts the whole redemption.
 */
export function encodeRedeem(signedDelegation: Delegation, execution: Execution): Hex {
  return DelegationManager.encode.redeemDelegations({
    delegations: [[signedDelegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [
      [createExecution({ target: execution.to, value: execution.value ?? 0n, callData: execution.data ?? "0x" })],
    ],
  });
}

/** Call the *owner's smart account* must make to revoke a delegation. Only the delegator can disable it. */
export function revokeCall(environment: SmartAccountsEnvironment, delegation: Delegation) {
  return { to: environment.DelegationManager, data: DelegationManager.encode.disableDelegation({ delegation }) };
}

/** Human-readable revert reason (enforcer require-string or custom error), if one can be decoded. */
export function revertReason(error: unknown): string {
  const decoded = decodeRevertReason(error);
  if (decoded) return decoded.message || decoded.errorName;
  return error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
}
