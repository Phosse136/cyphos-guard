/**
 * One-shot approval delegation: what the owner's passkey signs when approving an escalated request.
 *
 * It authorises exactly one execution (target + value + calldata pinned by ExactExecution), at most
 * once (LimitedCalls(1)), for a short window (Timestamp). Even if it leaks, it can't be replayed or
 * widened. The agent redeems it like any other delegation.
 *
 * Security: the approver UI must build this from the raw execution *client-side* and show the
 * decoded call from that same data. Never sign a delegation the server constructed.
 */
import {
  createExecution,
  type Delegation,
  ROOT_AUTHORITY,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import { type Address, toHex } from "viem";
import type { Execution } from "./delegations.ts";

export type BuildApprovalArgs = {
  environment: SmartAccountsEnvironment;
  /** Owner's smart account. */
  delegator: Address;
  /** Agent EOA that will redeem the approval. */
  agent: Address;
  execution: Execution;
  /** Unix seconds until which the approval can be redeemed. */
  expiresAt: number;
};

export function buildApprovalDelegation({ environment, delegator, agent, execution, expiresAt }: BuildApprovalArgs) {
  const caveats = createCaveatBuilder(environment)
    .addCaveat("exactExecution", {
      execution: createExecution({
        target: execution.to,
        value: execution.value ?? 0n,
        callData: execution.data ?? "0x",
      }),
    })
    .addCaveat("limitedCalls", { limit: 1 })
    .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: expiresAt })
    .build();

  const delegation: Omit<Delegation, "signature"> = {
    delegate: agent,
    delegator,
    authority: ROOT_AUTHORITY,
    caveats,
    salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  return delegation;
}
