/**
 * Policy → MetaMask delegations. One permission compiles to exactly one delegation (ADR 0002):
 * AllowedTargets × AllowedMethods is a cross-product on-chain, so merging permissions would widen them.
 *
 * Every delegation gets a TimestampEnforcer (expiry). Value-moving ones always get a period cap.
 * Anything that can't be expressed on-chain exactly is either rejected here (CompileError) or left to
 * the off-chain pre-check (offchainCheck), never silently dropped.
 */

import type { Permission, Policy } from "@cyphos-guard/shared";
import {
  type Caveats,
  createDelegation,
  type Delegation,
  ScopeType,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import {
  type AbiFunction,
  type Address,
  encodeAbiParameters,
  type Hex,
  isAddress,
  pad,
  parseAbiItem,
  toFunctionSelector,
  toHex,
} from "viem";
import { cosignerCaveat } from "./cosigner.ts";

/** One caveat in object form, e.g. { type: "timestamp", afterThreshold, beforeThreshold }. */
type CaveatConfig = Extract<Caveats, readonly unknown[]>[number];

export class CompileError extends Error {
  override name = "CompileError";
}

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
  return policy.permissions.map((permission, i) => {
    try {
      return { permission, delegation: compilePermission(policy, permission, delegator, environment, startDate) };
    } catch (e) {
      if (e instanceof CompileError) throw new CompileError(`permissions[${i}] (${permission.kind}): ${e.message}`);
      throw e;
    }
  });
}

function compilePermission(
  policy: Policy,
  permission: Permission,
  delegator: Address,
  environment: SmartAccountsEnvironment,
  startDate: number,
): Delegation {
  const base = { environment, from: delegator, to: policy.agent, salt: randomSalt() } as const;
  // A named co-signer becomes an extra caveat on every grant delegation (not on one-shot approvals).
  const extra: CaveatConfig[] = policy.cosigner ? [cosignerCaveat(policy.cosigner)] : [];
  const expiry: CaveatConfig = {
    type: "timestamp",
    afterThreshold: policy.validFrom ?? 0, // 0 = no lower bound
    beforeThreshold: policy.expiresAt,
  };
  const period = (p: { amount: bigint; periodSeconds: number }) => ({
    periodAmount: p.amount,
    periodDuration: p.periodSeconds,
    startDate,
  });

  switch (permission.kind) {
    case "nativeTransfer": {
      const caveats: CaveatConfig[] = [
        // The period scope only constrains *value*; the recipient allowlist must be added explicitly.
        { type: "allowedTargets", targets: permission.recipients },
        expiry,
        ...extra,
      ];
      if (permission.perTx !== undefined) caveats.push({ type: "valueLte", maxValue: permission.perTx });
      return createDelegation({
        ...base,
        // The kit adds ExactCalldata("0x") for this scope by default, so only plain ETH sends pass.
        scope: { type: ScopeType.NativeTokenPeriodTransfer, ...period(permission.perPeriod) },
        caveats,
      });
    }

    case "erc20Transfer": {
      // ERC20PeriodTransferEnforcer pins target == token and the transfer() selector; the scope adds
      // ValueLte(0). The recipient is calldata bytes 4..36: one AllowedCalldata caveat can pin exactly one.
      // Several recipients would need several delegations, each with its own period cap (= a wider cap).
      const [recipient, ...more] = permission.recipients;
      if (!recipient || more.length > 0) {
        throw new CompileError("exactly one recipient per erc20Transfer permission is supported on-chain");
      }
      return createDelegation({
        ...base,
        scope: { type: ScopeType.Erc20PeriodTransfer, tokenAddress: permission.token, ...period(permission.perPeriod) },
        caveats: [{ type: "allowedCalldata", startIndex: 4, value: pad(recipient, { size: 32 }) }, expiry, ...extra],
      });
    }

    case "x402": {
      // Just-in-time top-ups: token.transfer(agent, …) only, under a period cap. The co-signer (required by
      // the schema) binds the per-payment cap and the seller check; the agent then signs the x402 payment.
      if (!policy.cosigner) throw new CompileError("x402 permissions require a co-signer");
      return createDelegation({
        ...base,
        scope: { type: ScopeType.Erc20PeriodTransfer, tokenAddress: permission.token, ...period(permission.perPeriod) },
        caveats: [{ type: "allowedCalldata", startIndex: 4, value: pad(policy.agent, { size: 32 }) }, expiry, ...extra],
      });
    }

    case "contractCall": {
      const fns = permission.functions.map((f) => ({
        ...f,
        abi: parseAbiItem(`function ${f.signature}`) as AbiFunction,
      }));
      const eqRules = fns.flatMap((f) => f.args.filter((a) => a.op === "eq").map((a) => ({ fn: f, rule: a })));
      // AllowedCalldata applies to EVERY call under the delegation, so per-function argument pins are only
      // sound when the permission has a single function.
      if (eqRules.length > 0 && fns.length > 1) {
        throw new CompileError("on-chain argument rules (op eq) require exactly one function per permission");
      }
      const allowedCalldata = eqRules.map(({ fn, rule }) => ({
        startIndex: 4 + 32 * rule.index,
        value: encodeStaticArg(fn.abi, rule.index, rule.value),
      }));
      const caveats: CaveatConfig[] = [expiry, ...extra];
      if (permission.value) {
        caveats.push({ type: "nativeTokenPeriodTransfer", ...period(permission.value.perPeriod) });
      }
      return createDelegation({
        ...base,
        scope: {
          type: ScopeType.FunctionCall,
          targets: [permission.target],
          selectors: fns.map((f) => toFunctionSelector(f.abi)),
          ...(allowedCalldata.length ? { allowedCalldata } : {}),
          // Default (no `value`): calls must carry 0 ETH.
          valueLte: { maxValue: permission.value ? (permission.value.perTx ?? permission.value.perPeriod.amount) : 0n },
        },
        caveats,
      });
    }
  }
}

/** ABI-encode one static argument as its 32-byte calldata word. Dynamic types can't be pinned by offset. */
function encodeStaticArg(fn: AbiFunction, index: number, raw: string): Hex {
  const param = fn.inputs[index];
  if (!param) throw new CompileError(`${fn.name} has no argument at index ${index}`);
  const t = param.type;
  let value: unknown;
  if (t === "address") {
    if (!isAddress(raw)) throw new CompileError(`argument ${index} of ${fn.name} must be an address`);
    value = raw;
  } else if (/^u?int\d*$/.test(t)) value = BigInt(raw);
  else if (t === "bool") value = raw === "true";
  else if (/^bytes([1-9]|[12]\d|3[0-2])$/.test(t)) value = raw;
  else throw new CompileError(`argument ${index} of ${fn.name} has dynamic type ${t}; only static types can be pinned`);
  return encodeAbiParameters([{ type: t }], [value]);
}

/** Random salt so two otherwise-identical grants get distinct hashes (and separate period state). */
function randomSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
