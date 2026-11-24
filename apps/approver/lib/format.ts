import { decodeErc20Transfer } from "@cyphos-guard/shared";
import { type Address, formatEther, formatUnits, type Hex } from "viem";

/** Circle test USDC on Base Sepolia. */
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/** Known tokens on Base Sepolia, for human-readable amounts. Unknown tokens show raw base units. */
const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": { symbol: "USDC", decimals: 6 },
};

export { short } from "./short";
export const eth = (wei: string | bigint) => `${formatEther(BigInt(wei))} ETH`;
export const ago = (unix: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

/**
 * Human-readable description of an execution, decoded locally from the raw fields that will be
 * signed. Never display server-provided summaries for approvals.
 */
export function describe(exec: { to: Address; value: string; data: Hex }): { title: string; lines: string[] } {
  const value = BigInt(exec.value);
  if (exec.data === "0x") return { title: `Send ${eth(value)}`, lines: [`to ${exec.to}`] };
  const erc20 = decodeErc20Transfer(exec.data);
  const known = TOKENS[exec.to.toLowerCase()];
  if (erc20 && known && exec.data.startsWith("0xa9059cbb")) {
    return {
      title: `Pay ${formatUnits(erc20.amount, known.decimals)} ${known.symbol}`,
      lines: [
        `to ${erc20.recipient}`,
        `token ${known.symbol} ${exec.to}`,
        ...(value > 0n ? [`plus ${eth(value)}`] : []),
      ],
    };
  }
  if (erc20) {
    return {
      title: `Token transfer of ${erc20.amount.toString()} base units`,
      lines: [`token ${exec.to}`, `to ${erc20.recipient}`, ...(value > 0n ? [`plus ${eth(value)}`] : [])],
    };
  }
  return {
    title: `Contract call ${exec.data.slice(0, 10)}`,
    lines: [`contract ${exec.to}`, `value ${eth(value)}`, `calldata ${exec.data.length / 2 - 1} bytes`],
  };
}

export const explorer = (fork: boolean, tx: string) => (fork ? null : `https://sepolia.basescan.org/tx/${tx}`);

/** Local date and time, e.g. "20 Nov 2026, 20:14:05". */
export const when = (unix: number) =>
  new Date(unix * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** "1 day", "7 days", "12 h", "30 min". */
export const duration = (seconds: number) =>
  seconds % 86_400 === 0
    ? `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`
    : seconds % 3600 === 0
      ? `${seconds / 3600} h`
      : `${Math.round(seconds / 60)} min`;
