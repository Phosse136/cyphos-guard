import { encodeFunctionData, erc20Abi, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { offchainCheck } from "./offchain.ts";
import { parsePolicy } from "./policy.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const perm = (p: unknown) => {
  const [first] = parsePolicy({
    version: 1,
    chainId: 84532,
    agent: A,
    expiresAt: 2_000_000_000,
    permissions: [p],
  }).permissions;
  if (!first) throw new Error("no permission");
  return first;
};

describe("offchainCheck", () => {
  it("enforces ERC-20 per-tx caps", () => {
    const p = perm({
      kind: "erc20Transfer",
      token: TOKEN,
      recipients: [B],
      perTx: "100",
      perPeriod: { amount: "1000", periodSeconds: 86400 },
    });
    const data = (n: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [B, n] });
    expect(offchainCheck(p, { to: TOKEN, value: 0n, data: data(100n) })).toBeNull();
    expect(offchainCheck(p, { to: TOKEN, value: 0n, data: data(101n) })).toMatch(/per-transaction/);
  });

  it("enforces argument comparison rules for contract calls", () => {
    const p = perm({
      kind: "contractCall",
      target: TOKEN,
      functions: [
        {
          signature: "swap(address,uint256)",
          args: [
            { index: 1, op: "lte", value: "500" },
            { index: 0, op: "neq", value: A },
          ],
        },
      ],
    });
    const abi = parseAbi(["function swap(address,uint256)"]);
    const data = (to: `0x${string}`, n: bigint) => encodeFunctionData({ abi, functionName: "swap", args: [to, n] });
    expect(offchainCheck(p, { to: TOKEN, value: 0n, data: data(B, 500n) })).toBeNull();
    expect(offchainCheck(p, { to: TOKEN, value: 0n, data: data(B, 501n) })).toMatch(/lte 500/);
    expect(offchainCheck(p, { to: TOKEN, value: 0n, data: data(A, 1n) })).toMatch(/neq/);
  });

  it("has nothing to add for native transfers (all on-chain)", () => {
    const p = perm({ kind: "nativeTransfer", recipients: [B], perPeriod: { amount: "1", periodSeconds: 86400 } });
    expect(offchainCheck(p, { to: B, value: 10n ** 18n, data: "0x" })).toBeNull();
  });
});
