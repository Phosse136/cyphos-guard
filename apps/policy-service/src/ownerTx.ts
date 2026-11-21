/**
 * The owner's own passkey transactions (account creation, sending out, recovery changes, vault deploy/withdraw).
 * They go from the browser to the bundler, not through this service, so the approver reports the tx hash afterwards.
 * We trust nothing but the hash: the calls are decoded from the EntryPoint.handleOps input on-chain, and only a
 * successful userOp whose sender is the owner's account counts.
 */

import { decodeErc20Transfer } from "@cyphos-guard/shared";
import {
  type Address,
  decodeAbiParameters,
  decodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  type Hex,
  isAddressEqual,
  parseAbi,
  slice,
  toFunctionSelector,
} from "viem";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** Deterministic CREATE2 deployer the SDK uses for X402Vaults. */
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

export const entryPointAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
const accountAbi = parseAbi([
  "function execute(bytes32 mode, bytes executionCalldata)",
  "function execute((address target, uint256 value, bytes callData) execution)",
  "function transferOwnership(address newOwner)",
  "function withdrawDeposit(address withdrawAddress, uint256 withdrawAmount)",
]);
const vaultAbi = parseAbi(["function withdraw(address token, address to, uint256 amount)"]);
const SEL = {
  transferOwnership: toFunctionSelector("transferOwnership(address)"),
  withdrawDeposit: toFunctionSelector("withdrawDeposit(address,uint256)"),
  vaultWithdraw: toFunctionSelector("withdraw(address,address,uint256)"),
  disableDelegation: toFunctionSelector(
    "disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))",
  ),
};

export type OwnerCall = { to: Address; value: bigint; data: Hex };
export type OwnerOp = { created: boolean; calls: OwnerCall[] };

/**
 * The account's calls. The kit encodes one call as `execute((target,value,callData))`, several as ERC-7579
 * `execute(mode, executionCalldata)` (0x00 single packed, 0x01 batch), and a lone no-op self-call (the
 * deploying userOp) as empty callData. Null: not an execute call.
 */
export function decodeExecute(callData: Hex): OwnerCall[] | null {
  if (callData === "0x") return [];
  try {
    const decoded = decodeFunctionData({ abi: accountAbi, data: callData });
    if (decoded.functionName !== "execute") return null;
    if (decoded.args.length === 1) {
      const { target, value, callData: data } = decoded.args[0];
      return [{ to: target, value, data }];
    }
    const [mode, exec] = decoded.args;
    const callType = slice(mode, 0, 1);
    if (callType === "0x00") {
      return [
        {
          to: getAddress(slice(exec, 0, 20)),
          value: BigInt(slice(exec, 20, 52)),
          data: exec.length > 106 ? slice(exec, 52) : "0x",
        },
      ];
    }
    if (callType === "0x01") {
      const [list] = decodeAbiParameters(
        [{ type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
        exec,
      );
      return list.map(([to, value, data]) => ({ to, value, data }));
    }
    return null;
  } catch {
    return null;
  }
}

/** The userOp of `account` inside a handleOps tx input, decoded; null if it isn't there or can't be decoded. */
export function decodeOwnerOp(input: Hex, account: Address): OwnerOp | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: entryPointAbi, data: input });
    if (functionName !== "handleOps") return null;
    const op = args[0].find((o) => isAddressEqual(o.sender, account));
    if (!op) return null;
    // Not an execute(...): the kit sends a lone call to the account itself as the raw callData (e.g.
    // transferOwnership), which the EntryPoint then calls on the account.
    const calls = decodeExecute(op.callData) ?? [{ to: op.sender, value: 0n, data: op.callData }];
    return { created: op.initCode !== "0x", calls };
  } catch {
    return null;
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const token = (t: Address) => (isAddressEqual(t, USDC) ? "USDC" : `token ${short(t)}`);

/** Human lines, e.g. ["created the account", "sent 0.01 ETH → 0x12…ab"]. Empty: nothing worth reporting. */
export function describeOwnerOp(op: OwnerOp, account: Address, delegationManager: Address): string[] {
  const lines: string[] = op.created ? ["created the account"] : [];
  for (const c of op.calls) {
    const sel = c.data.length >= 10 ? slice(c.data, 0, 4) : null;
    const self = isAddressEqual(c.to, account);
    if (self && sel === SEL.transferOwnership) {
      const { args } = decodeFunctionData({ abi: accountAbi, data: c.data });
      lines.push(`changed the recovery address → ${short(args[0] as string)}`);
    } else if (self && sel === SEL.withdrawDeposit) {
      lines.push("withdrew the EntryPoint deposit");
    } else if (self && !sel && c.value === 0n) {
      // the no-op self-call that deploys the account; covered by "created the account"
    } else if (isAddressEqual(c.to, delegationManager) && sel === SEL.disableDelegation) {
      lines.push("revoked a delegation");
    } else if (isAddressEqual(c.to, CREATE2_DEPLOYER)) {
      lines.push("deployed an x402 vault");
    } else if (sel === SEL.vaultWithdraw) {
      const { args } = decodeFunctionData({ abi: vaultAbi, data: c.data });
      lines.push(`withdrew ${formatUnits(args[2], 6)} ${token(args[0])} from vault ${short(c.to)} → ${short(args[1])}`);
    } else if (decodeErc20Transfer(c.data)) {
      const t = decodeErc20Transfer(c.data);
      if (t) lines.push(`sent ${formatUnits(t.amount, 6)} ${token(c.to)} → ${short(t.recipient)}`);
    } else if (!sel) {
      if (c.value > 0n) lines.push(`sent ${formatEther(c.value)} ETH → ${short(c.to)}`);
    } else {
      lines.push(`called ${short(c.to)} (${sel})${c.value > 0n ? ` with ${formatEther(c.value)} ETH` : ""}`);
    }
  }
  return lines;
}

/** True if the op only revokes delegations: already reported as grant_revoked, so not repeated. */
export const onlyRevokes = (op: OwnerOp, delegationManager: Address) =>
  !op.created &&
  op.calls.length > 0 &&
  op.calls.every((c) => isAddressEqual(c.to, delegationManager) && c.data.startsWith(SEL.disableDelegation));
