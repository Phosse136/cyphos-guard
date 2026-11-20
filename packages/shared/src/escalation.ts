/**
 * Off-chain escalation rules (layer 2 vs layer 3). Called when an action does NOT fit the agent's
 * on-chain delegations: decides whether the owner may be asked, or the action is denied outright.
 * These rules can only refuse; they never widen what the chain allows.
 */
import { type Address, decodeFunctionData, erc20Abi, type Hex, isAddressEqual } from "viem";
import type { EscalationRefusal } from "./api.ts";
import type { Policy } from "./policy.ts";

export type EscalationDecision = { ok: true } | { ok: false; code: EscalationRefusal; message: string };

/** If `data` is an ERC-20 transfer/transferFrom, returns recipient and amount. */
export function decodeErc20Transfer(data: Hex): { recipient: Address; amount: bigint } | null {
  if (data.length < 10) return null;
  try {
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
    if (functionName === "transfer") return { recipient: args[0], amount: args[1] };
    if (functionName === "transferFrom") return { recipient: args[1], amount: args[2] };
  } catch {
    // not an ERC-20 transfer
  }
  return null;
}

export function escalationDecision(
  policy: Policy,
  exec: { to: Address; value: bigint; data: Hex },
): EscalationDecision {
  if (!policy.escalation.enabled) {
    return { ok: false, code: "escalation_disabled", message: "escalation is disabled for this grant" };
  }
  const erc20 = decodeErc20Transfer(exec.data);
  const touched = erc20 ? [exec.to, erc20.recipient] : [exec.to];
  for (const forbidden of policy.forbidden.targets) {
    if (touched.some((a) => isAddressEqual(a, forbidden))) {
      return { ok: false, code: "forbidden", message: `address ${forbidden} is forbidden` };
    }
  }
  for (const cap of policy.escalation.hardMax) {
    if (cap.token === "native" && exec.value > cap.amount) {
      return { ok: false, code: "over_hard_max", message: `value exceeds hard maximum of ${cap.amount} wei` };
    }
    if (cap.token !== "native" && erc20 && isAddressEqual(exec.to, cap.token) && erc20.amount > cap.amount) {
      return { ok: false, code: "over_hard_max", message: `token amount exceeds hard maximum of ${cap.amount}` };
    }
  }
  return { ok: true };
}
