/**
 * Off-chain pre-checks for rules the chain can't enforce (ADR 0002): ERC-20 per-tx caps and argument
 * rules other than `eq`. The SDK runs them before using a grant; a failing check makes the agent
 * escalate instead of acting alone.
 *
 * IMPORTANT: these protect against a buggy or confused agent, not a compromised one: an agent holding
 * the signed delegation can bypass the SDK and redeem directly. Only on-chain caveats bind a malicious
 * agent (until the co-signer enforcer exists). Keep anything security-critical on-chain.
 */
import {
  type AbiFunction,
  decodeFunctionData,
  type Hex,
  isAddress,
  isAddressEqual,
  parseAbiItem,
  toFunctionSelector,
} from "viem";
import { decodeErc20Transfer } from "./escalation.ts";
import type { Permission } from "./policy.ts";

/** Returns a human-readable violation, or null if the execution passes all off-chain rules of `permission`. */
export function offchainCheck(
  permission: Permission,
  exec: { to: `0x${string}`; value: bigint; data: Hex },
): string | null {
  if (permission.kind === "erc20Transfer") {
    const t = decodeErc20Transfer(exec.data);
    if (t && permission.perTx !== undefined && t.amount > permission.perTx) {
      return `token amount ${t.amount} exceeds per-transaction limit ${permission.perTx}`;
    }
    return null;
  }
  if (permission.kind === "contractCall") {
    const selector = exec.data.slice(0, 10).toLowerCase();
    for (const f of permission.functions) {
      const abi = parseAbiItem(`function ${f.signature}`) as AbiFunction;
      if (toFunctionSelector(abi).toLowerCase() !== selector || f.args.length === 0) continue;
      let args: readonly unknown[];
      try {
        args = decodeFunctionData({ abi: [abi], data: exec.data }).args ?? [];
      } catch {
        return `calldata does not decode as ${f.signature}`;
      }
      for (const rule of f.args) {
        const v = compare(args[rule.index], rule.value);
        if (v === null) return `argument ${rule.index} of ${abi.name} can't be compared`;
        const ok = { eq: v === 0, neq: v !== 0, lt: v < 0, lte: v <= 0, gt: v > 0, gte: v >= 0 }[rule.op];
        if (!ok) return `argument ${rule.index} of ${abi.name} violates ${rule.op} ${rule.value}`;
      }
    }
  }
  return null;
}

/** -1 / 0 / 1 comparing an ABI-decoded value with a rule value, or null if incomparable. */
function compare(actual: unknown, expected: string): number | null {
  if (typeof actual === "bigint") {
    const e = BigInt(expected);
    return actual === e ? 0 : actual < e ? -1 : 1;
  }
  if (typeof actual === "string" && isAddress(actual) && isAddress(expected)) {
    return isAddressEqual(actual, expected) ? 0 : actual.toLowerCase() < expected.toLowerCase() ? -1 : 1;
  }
  if (typeof actual === "boolean") return actual === (expected === "true") ? 0 : 1;
  if (typeof actual === "string") return actual.toLowerCase() === expected.toLowerCase() ? 0 : 1;
  return null;
}
