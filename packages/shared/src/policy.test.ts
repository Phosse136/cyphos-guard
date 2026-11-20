import { describe, expect, it } from "vitest";
import { type PolicyInput, policySchema } from "./policy.ts";

const AGENT = "0x1111111111111111111111111111111111111111";
const SHOP = "0x2222222222222222222222222222222222222222";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Circle test USDC on Base Sepolia
const ROUTER = "0x3333333333333333333333333333333333333333";
const DAY = 86_400;
const NOW = 1_795_000_000;

const valid = (): PolicyInput => ({
  version: 1,
  chainId: 84532,
  agent: AGENT,
  validFrom: NOW,
  expiresAt: NOW + 7 * DAY,
  permissions: [
    {
      kind: "nativeTransfer",
      recipients: [SHOP],
      perPeriod: { amount: "1000000000000000", periodSeconds: DAY }, // 0.001 ETH/day
    },
    {
      kind: "erc20Transfer",
      token: USDC,
      recipients: [SHOP],
      perTx: "500000",
      perPeriod: { amount: "1000000", periodSeconds: DAY }, // 1 USDC/day
    },
    {
      kind: "contractCall",
      target: ROUTER,
      functions: [{ signature: "swap(address,uint256,uint256)", args: [{ index: 0, op: "eq", value: USDC }] }],
    },
  ],
});

describe("policySchema", () => {
  it("parses a valid policy, converts amounts to bigint and applies defaults", () => {
    const p = policySchema.parse(valid());
    const native = p.permissions[0];
    expect(native?.kind === "nativeTransfer" && native.perPeriod.amount).toBe(1_000_000_000_000_000n);
    expect(p.escalation).toEqual({ enabled: true, approvalTtlSeconds: 900, hardMax: [] });
    expect(p.forbidden.targets).toEqual([]);
  });

  it("checksums addresses", () => {
    const input = valid();
    input.agent = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    expect(policySchema.parse(input).agent).toBe("0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD");
  });

  it("rejects mainnet chain ids", () => {
    expect(policySchema.safeParse({ ...valid(), chainId: 8453 }).success).toBe(false);
    expect(policySchema.safeParse({ ...valid(), chainId: 1 }).success).toBe(false);
  });

  it("requires a per-period cap on value-moving permissions", () => {
    const input = valid();
    input.permissions = [{ kind: "nativeTransfer", recipients: [SHOP] } as never];
    expect(policySchema.safeParse(input).success).toBe(false);
  });

  it("rejects zero and non-integer amounts", () => {
    for (const amount of ["0", "0.5", "-1", "1e18"]) {
      const input = valid();
      input.permissions = [{ kind: "nativeTransfer", recipients: [SHOP], perPeriod: { amount, periodSeconds: DAY } }];
      expect(policySchema.safeParse(input).success, amount).toBe(false);
    }
  });

  it("rejects grants without expiry, expired-before-start, or longer than 90 days", () => {
    const { expiresAt: _, ...noExpiry } = valid();
    expect(policySchema.safeParse(noExpiry).success).toBe(false);
    expect(policySchema.safeParse({ ...valid(), expiresAt: NOW }).success).toBe(false);
    expect(policySchema.safeParse({ ...valid(), expiresAt: NOW + 91 * DAY }).success).toBe(false);
  });

  it("rejects invalid function signatures", () => {
    const input = valid();
    input.permissions = [{ kind: "contractCall", target: ROUTER, functions: [{ signature: "not a function" }] }];
    expect(policySchema.safeParse(input).success).toBe(false);
  });

  it("rejects permissions that touch a forbidden address", () => {
    const result = policySchema.safeParse({ ...valid(), forbidden: { targets: [ROUTER] } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/forbidden/);
  });

  it("rejects invalid addresses", () => {
    expect(policySchema.safeParse({ ...valid(), agent: "0x1234" }).success).toBe(false);
  });
});
