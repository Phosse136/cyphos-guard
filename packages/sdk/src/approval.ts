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
import { type Address, encodePacked, hexToBigInt, isAddressEqual, toHex } from "viem";
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

/**
 * Structural check that a (signed) delegation is exactly the one-shot approval for `execution`:
 * right delegator/delegate, root authority, and ONLY the three expected caveats with matching terms.
 * Returns an error string, or null if it matches. Signature validity is checked separately
 * (on-chain simulation), because only the chain can verify a passkey's ERC-1271 signature.
 */
export function checkApprovalDelegation(
  delegation: Pick<Delegation, "delegate" | "delegator" | "authority" | "caveats">,
  expected: {
    environment: SmartAccountsEnvironment;
    delegator: Address;
    agent: Address;
    execution: Execution;
    latestExpiry: number;
  },
): string | null {
  const { environment: env, execution } = expected;
  if (!isAddressEqual(delegation.delegator, expected.delegator)) return "wrong delegator";
  if (!isAddressEqual(delegation.delegate, expected.agent)) return "wrong delegate";
  if (delegation.authority.toLowerCase() !== ROOT_AUTHORITY.toLowerCase()) return "must be a root delegation";
  if (delegation.caveats.length !== 3) return "approval must have exactly 3 caveats";

  const find = (name: keyof typeof env.caveatEnforcers) => {
    const addr = env.caveatEnforcers[name];
    return delegation.caveats.find((c) => addr && isAddressEqual(c.enforcer, addr));
  };
  const exact = find("ExactExecutionEnforcer");
  const wantTerms = encodePacked(
    ["address", "uint256", "bytes"],
    [execution.to, execution.value ?? 0n, execution.data ?? "0x"],
  );
  if (!exact || exact.terms.toLowerCase() !== wantTerms.toLowerCase()) return "execution does not match the request";

  const limited = find("LimitedCallsEnforcer");
  if (!limited || hexToBigInt(limited.terms) !== 1n) return "approval must be limited to one call";

  const ts = find("TimestampEnforcer");
  if (ts?.terms.length !== 66) return "approval must expire";
  const before = hexToBigInt(`0x${ts.terms.slice(34)}`);
  if (before === 0n || before > BigInt(expected.latestExpiry)) return "approval expiry is missing or too late";
  return null;
}
