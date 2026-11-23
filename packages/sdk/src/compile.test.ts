import { parsePolicy } from "@cyphos-guard/shared";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { describe, expect, it } from "vitest";
import { compilePolicy } from "./compile.ts";
import { perTransferCapEnforcerAddress } from "./transferCap.ts";

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

  it("makes perTx binding on-chain with the per-transfer cap enforcer (no co-signer needed)", () => {
    const [c] = compilePolicy({
      policy: withPermissions([
        {
          kind: "erc20Transfer",
          token: USDC_ADDRESS,
          recipients: [SHOP],
          perTx: "2000000",
          perPeriod: { amount: "5000000", periodSeconds: DAY },
        },
      ]),
      delegator: ACCOUNT,
      environment: env,
    });
    const cap = c?.delegation.caveats.find((cv) => cv.enforcer === perTransferCapEnforcerAddress);
    // terms = token (20 bytes) ‖ uint256 max amount
    expect(cap?.terms.toLowerCase()).toBe(`${USDC_ADDRESS}${(2_000_000).toString(16).padStart(64, "0")}`.toLowerCase());
    expect(c?.delegation.caveats).toHaveLength(5);
  });

  it("adds no cap caveat without perTx", () => {
    const [c] = compilePolicy({
      policy: withPermissions([
        {
          kind: "erc20Transfer",
          token: USDC_ADDRESS,
          recipients: [SHOP],
          perPeriod: { amount: "5", periodSeconds: DAY },
        },
      ]),
      delegator: ACCOUNT,
      environment: env,
    });
    expect(c?.delegation.caveats.some((cv) => cv.enforcer === perTransferCapEnforcerAddress)).toBe(false);
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

describe("compilePolicy: x402", () => {
  const COSIGNER = "0x5555555555555555555555555555555555555555";
  const SELLER = "0x6666666666666666666666666666666666666666";
  it("compiles to token top-ups to the agent itself, period-capped and co-signed", () => {
    const p = parsePolicy({
      version: 1,
      chainId: 84532,
      agent: AGENT,
      validFrom: NOW,
      expiresAt: NOW + 7 * DAY,
      cosigner: COSIGNER,
      permissions: [
        {
          kind: "x402",
          token: USDC_ADDRESS,
          sellers: [SELLER],
          perTx: "1000000",
          perPeriod: { amount: "5000000", periodSeconds: DAY },
        },
      ],
    });
    const [c] = compilePolicy({ policy: p, delegator: ACCOUNT, environment: env });
    const calldata = c?.delegation.caveats.find(
      (cv) => cv.enforcer.toLowerCase() === env.caveatEnforcers.AllowedCalldataEnforcer?.toLowerCase(),
    );
    // The only allowed recipient is the AGENT (not the seller): the money goes to the agent just in time.
    expect(calldata?.terms.toLowerCase()).toBe(
      `0x${(4).toString(16).padStart(64, "0")}${AGENT.slice(2).padStart(64, "0")}`.toLowerCase(),
    );
    expect(enforcers(c?.delegation.caveats ?? []).filter(Boolean)).toEqual([
      "AllowedCalldataEnforcer",
      "ERC20PeriodTransferEnforcer",
      "TimestampEnforcer",
      "ValueLteEnforcer",
    ]);
    // + the per-transfer cap and the CosignerEnforcer (ours, not in the kit's environment)
    expect(c?.delegation.caveats).toHaveLength(6);
    expect(c?.delegation.caveats.find((cv) => cv.enforcer === perTransferCapEnforcerAddress)?.terms.toLowerCase()).toBe(
      `${USDC_ADDRESS}${(1_000_000).toString(16).padStart(64, "0")}`.toLowerCase(),
    );
  });

  it("the schema refuses x402 without a co-signer and sellers on the denylist", () => {
    const base = {
      version: 1,
      chainId: 84532,
      agent: AGENT,
      expiresAt: NOW + DAY,
      permissions: [
        {
          kind: "x402",
          token: USDC_ADDRESS,
          sellers: [SELLER],
          perTx: "1",
          perPeriod: { amount: "5", periodSeconds: DAY },
        },
      ],
    };
    expect(() => parsePolicy(base)).toThrow(/co-signer/);
    expect(() => parsePolicy({ ...base, cosigner: COSIGNER, forbidden: { targets: [SELLER] } })).toThrow(/forbidden/);
  });
});

describe("compilePolicy: x402 with a vault", () => {
  const VAULT = "0x7777777777777777777777777777777777777777";
  const SELLER = "0x6666666666666666666666666666666666666666";
  it("pins top-ups to the vault and needs no co-signer", () => {
    const p = parsePolicy({
      version: 1,
      chainId: 84532,
      agent: AGENT,
      validFrom: NOW,
      expiresAt: NOW + DAY,
      permissions: [
        {
          kind: "x402",
          token: USDC_ADDRESS,
          sellers: [SELLER],
          perTx: "1000000",
          perPeriod: { amount: "5000000", periodSeconds: DAY },
          vault: VAULT,
        },
      ],
    });
    const [c] = compilePolicy({ policy: p, delegator: ACCOUNT, environment: env });
    const calldata = c?.delegation.caveats.find(
      (cv) => cv.enforcer.toLowerCase() === env.caveatEnforcers.AllowedCalldataEnforcer?.toLowerCase(),
    );
    expect(calldata?.terms.toLowerCase()).toBe(
      `0x${(4).toString(16).padStart(64, "0")}${VAULT.slice(2).padStart(64, "0")}`.toLowerCase(),
    );
    expect(c?.delegation.caveats).toHaveLength(5); // + the per-transfer cap, no CosignerEnforcer
  });
});
