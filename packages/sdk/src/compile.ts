/**
 * Policy → MetaMask delegations. One permission compiles to exactly one delegation (ADR 0002):
 * AllowedTargets × AllowedMethods is a cross-product on-chain, so merging permissions would widen them.
 *
 * Every delegation gets a TimestampEnforcer (expiry). Value-moving ones always get a period cap.
 */
import {
  type Caveats,
  createDelegation,
  type Delegation,
  ScopeType,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import type { Permission, Policy } from "@phoswallet/shared";
import { type Address, type Hex, toHex } from "viem";

/** One caveat in object form, e.g. { type: "timestamp", afterThreshold, beforeThreshold }. */
type CaveatConfig = Extract<Caveats, readonly unknown[]>[number];

export type CompiledPermission = { permission: Permission; delegation: Delegation };

export type CompilePolicyArgs = {
  policy: Policy;
  /** The owner's smart account (the delegator). */
  delegator: Address;
  environment: SmartAccountsEnvironment;
  /** Unix seconds; used as the period start when the policy has no validFrom. */
  now?: number;
};

export function compilePolicy({ policy, delegator, environment, now }: CompilePolicyArgs): CompiledPermission[] {
  // Period enforcers require startDate <= block.timestamp at first use; back off a minute for clock skew.
  const startDate = policy.validFrom ?? (now ?? Math.floor(Date.now() / 1000)) - 60;
  return policy.permissions.map((permission) => ({
    permission,
    delegation: compilePermission(policy, permission, delegator, environment, startDate),
  }));
}

function compilePermission(
  policy: Policy,
  permission: Permission,
  delegator: Address,
  environment: SmartAccountsEnvironment,
  startDate: number,
): Delegation {
  const expiry: CaveatConfig = {
    type: "timestamp",
    afterThreshold: policy.validFrom ?? 0, // 0 = no lower bound
    beforeThreshold: policy.expiresAt,
  };

  switch (permission.kind) {
    case "nativeTransfer": {
      const caveats: CaveatConfig[] = [
        // The period scope only constrains *value*; the recipient allowlist must be added explicitly.
        { type: "allowedTargets", targets: permission.recipients },
        expiry,
      ];
      if (permission.perTx !== undefined) caveats.push({ type: "valueLte", maxValue: permission.perTx });
      return createDelegation({
        environment,
        from: delegator,
        to: policy.agent,
        // The kit adds ExactCalldata("0x") for this scope by default, so only plain ETH sends pass
        // (no value smuggled into arbitrary contract calls). See createNativeTokenPeriodicCaveatBuilder.
        scope: {
          type: ScopeType.NativeTokenPeriodTransfer,
          periodAmount: permission.perPeriod.amount,
          periodDuration: permission.perPeriod.periodSeconds,
          startDate,
        },
        caveats,
        salt: randomSalt(),
      });
    }
    case "erc20Transfer":
    case "contractCall":
      throw new Error(`permission kind "${permission.kind}" is not compiled yet (planned for Phase 3)`);
  }
}

/** Random salt so two otherwise-identical grants get distinct hashes (and separate period state). */
function randomSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
