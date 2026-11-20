import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { parsePolicy } from "@phoswallet/shared";
import { describe, expect, it } from "vitest";
import { compilePolicy } from "./compile.ts";

const env = getSmartAccountsEnvironment(84532);
const AGENT = "0x1111111111111111111111111111111111111111";
const SHOP = "0x2222222222222222222222222222222222222222";
const ACCOUNT = "0x4444444444444444444444444444444444444444";
const NOW = 1_795_000_000;
const DAY = 86_400;

const policy = (extra: Record<string, unknown> = {}) =>
  parsePolicy({
    version: 1,
    chainId: 84532,
    agent: AGENT,
    validFrom: NOW,
    expiresAt: NOW + 7 * DAY,
    permissions: [
      { kind: "nativeTransfer", recipients: [SHOP], perPeriod: { amount: "1000", periodSeconds: DAY }, ...extra },
    ],
  });

const enforcers = (caveats: { enforcer: string }[]) => {
  const byAddress = Object.fromEntries(
    Object.entries(env.caveatEnforcers).map(([k, v]) => [String(v).toLowerCase(), k]),
  );
  return caveats.map((c) => byAddress[c.enforcer.toLowerCase()]).sort();
};

describe("compilePolicy: nativeTransfer", () => {
  it("binds delegator, delegate and every required caveat", () => {
    const [c] = compilePolicy({ policy: policy(), delegator: ACCOUNT, environment: env });
    expect(c?.delegation.delegator).toBe(ACCOUNT);
    expect(c?.delegation.delegate).toBe(AGENT);
    expect(enforcers(c?.delegation.caveats ?? [])).toEqual([
      "AllowedTargetsEnforcer",
      "ExactCalldataEnforcer", // plain ETH sends only
      "NativeTokenPeriodTransferEnforcer",
      "TimestampEnforcer",
    ]);
  });

  it("adds ValueLte when perTx is set", () => {
    const [c] = compilePolicy({ policy: policy({ perTx: "500" }), delegator: ACCOUNT, environment: env });
    expect(enforcers(c?.delegation.caveats ?? [])).toContain("ValueLteEnforcer");
  });

  it("gives each grant a unique salt", () => {
    const a = compilePolicy({ policy: policy(), delegator: ACCOUNT, environment: env })[0];
    const b = compilePolicy({ policy: policy(), delegator: ACCOUNT, environment: env })[0];
    expect(a?.delegation.salt).not.toBe(b?.delegation.salt);
  });
});

const withPermissions = (permissions: unknown[]) =>
  parsePolicy({ version: 1, chainId: 84532, agent: AGENT, validFrom: NOW, expiresAt: NOW + DAY, permissions });
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

describe("compilePolicy: erc20Transfer", () => {
  it("pins token + period, the recipient (calldata word 1) and zero ETH value", () => {
    const [c] = compilePolicy({
      policy: withPermissions([
        {
          kind: "erc20Transfer",
          token: USDC_ADDRESS,
          recipients: [SHOP],
          perPeriod: { amount: "5000000", periodSeconds: DAY },
        },
      ]),
      delegator: ACCOUNT,
      environment: env,
    });
    expect(enforcers(c?.delegation.caveats ?? [])).toEqual([
      "AllowedCalldataEnforcer",
      "ERC20PeriodTransferEnforcer",
      "TimestampEnforcer",
      "ValueLteEnforcer",
    ]);
    const calldata = c?.delegation.caveats.find(
      (cv) => cv.enforcer.toLowerCase() === env.caveatEnforcers.AllowedCalldataEnforcer?.toLowerCase(),
    );
    // terms = startIndex (32 bytes, = 4) ‖ 32-byte padded recipient
    expect(calldata?.terms.toLowerCase()).toBe(
      `0x${(4).toString(16).padStart(64, "0")}${SHOP.slice(2).padStart(64, "0")}`.toLowerCase(),
    );
  });

  it("refuses several recipients (would need several caps)", () => {
    const policy = withPermissions([
      {
        kind: "erc20Transfer",
        token: USDC_ADDRESS,
        recipients: [SHOP, AGENT],
        perPeriod: { amount: "1", periodSeconds: DAY },
      },
    ]);
    expect(() => compilePolicy({ policy, delegator: ACCOUNT, environment: env })).toThrow(/exactly one recipient/);
  });
});

describe("compilePolicy: contractCall", () => {
  it("pins target, selector, eq args and zero value by default", () => {
    const [c] = compilePolicy({
      policy: withPermissions([
        {
          kind: "contractCall",
          target: USDC_ADDRESS,
          functions: [{ signature: "approve(address,uint256)", args: [{ index: 0, op: "eq", value: SHOP }] }],
        },
      ]),
      delegator: ACCOUNT,
      environment: env,
    });
    expect(enforcers(c?.delegation.caveats ?? [])).toEqual([
      "AllowedCalldataEnforcer",
      "AllowedMethodsEnforcer",
      "AllowedTargetsEnforcer",
      "TimestampEnforcer",
      "ValueLteEnforcer",
    ]);
  });

  it("adds a native period cap when value is allowed", () => {
    const [c] = compilePolicy({
      policy: withPermissions([
        {
          kind: "contractCall",
          target: USDC_ADDRESS,
          functions: [{ signature: "deposit()" }],
          value: { perPeriod: { amount: "1000", periodSeconds: DAY } },
        },
      ]),
      delegator: ACCOUNT,
      environment: env,
    });
    expect(enforcers(c?.delegation.caveats ?? [])).toContain("NativeTokenPeriodTransferEnforcer");
  });

  it("refuses on-chain arg pins with several functions and dynamic-type pins", () => {
    const multi = withPermissions([
      {
        kind: "contractCall",
        target: USDC_ADDRESS,
        functions: [
          { signature: "approve(address,uint256)", args: [{ index: 0, op: "eq", value: SHOP }] },
          { signature: "transfer(address,uint256)" },
        ],
      },
    ]);
    expect(() => compilePolicy({ policy: multi, delegator: ACCOUNT, environment: env })).toThrow(
      /exactly one function/,
    );
    const dynamic = withPermissions([
      {
        kind: "contractCall",
        target: USDC_ADDRESS,
        functions: [{ signature: "setName(string)", args: [{ index: 0, op: "eq", value: "x" }] }],
      },
    ]);
    expect(() => compilePolicy({ policy: dynamic, delegator: ACCOUNT, environment: env })).toThrow(/dynamic type/);
  });
});
