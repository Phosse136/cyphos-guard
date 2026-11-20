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

  it("refuses permission kinds it cannot compile yet instead of emitting a weaker delegation", () => {
    const p = parsePolicy({
      version: 1,
      chainId: 84532,
      agent: AGENT,
      expiresAt: NOW,
      permissions: [{ kind: "contractCall", target: SHOP, functions: [{ signature: "ping()" }] }],
    });
    expect(() => compilePolicy({ policy: p, delegator: ACCOUNT, environment: env })).toThrow(/not compiled yet/);
  });
});
