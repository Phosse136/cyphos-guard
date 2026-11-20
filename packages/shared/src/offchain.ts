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

/** What an x402 top-up pays for: the seller and the amount it asked for. */
export type X402Context = { payTo: `0x${string}`; amount: bigint; resource: string };

/** Returns a human-readable violation, or null if the execution passes all off-chain rules of `permission`. */
export function offchainCheck(
  permission: Permission,
  exec: { to: `0x${string}`; value: bigint; data: Hex },
  context: { x402?: X402Context } = {},
): string | null {
  if (permission.kind === "x402") {
    // On-chain already pins token, recipient (= agent) and the period cap. Here: it must be a top-up FOR an
    // x402 payment to an allowed seller, no larger than that payment and the per-payment cap.
    const t = decodeErc20Transfer(exec.data);
    if (!t) return "not a token transfer";
    const x = context.x402;
    if (!x) return "x402 top-up without x402 payment details";
    if (!permission.sellers.some((s) => isAddressEqual(s, x.payTo))) return `x402 seller ${x.payTo} is not allowed`;
    if (x.amount > permission.perTx) return `x402 payment ${x.amount} exceeds per-payment limit ${permission.perTx}`;
    if (t.amount > x.amount) return `top-up ${t.amount} exceeds the x402 payment ${x.amount}`;
    return null;
  }
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
