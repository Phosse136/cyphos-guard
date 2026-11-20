/**
 * phoswallet policy schema, v1.
 *
 * A policy is what an owner grants an agent. It is a *list of permissions*; each permission compiles
 * to exactly one MetaMask delegation (see docs/decisions/0001 + 0002). One-delegation-per-permission
 * matters for security: AllowedTargets × AllowedMethods is a cross-product on-chain, so bundling
 * several targets/functions into one delegation would grant more than the owner intended.
 *
 * Amounts are in base units (wei / token units). JSON carries them as decimal strings; parsed output
 * is bigint.
 */
import { getAddress, isAddress, parseAbiItem } from "viem";
import { z } from "zod";

/** Testnets only. There is deliberately no way to express a mainnet chain in a policy. */
export const SUPPORTED_CHAIN_IDS = { baseSepolia: 84532, sepolia: 11155111 } as const;

/** Upper bound for a grant's lifetime. Forces periodic re-grants instead of forever-keys. */
export const MAX_GRANT_SECONDS = 90 * 24 * 60 * 60;

const chainId = z.union([z.literal(SUPPORTED_CHAIN_IDS.baseSepolia), z.literal(SUPPORTED_CHAIN_IDS.sepolia)]);

export const addressSchema = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "invalid address")
  .transform((v) => getAddress(v));

/** Positive integer amount in base units. Accepts bigint or a decimal string (JSON-safe). */
export const amountSchema = z
  .union([z.bigint(), z.string().regex(/^\d+$/, "amount must be a base-unit integer string")])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, "amount must be > 0");

const unixSeconds = z.number().int().nonnegative();

export const periodLimitSchema = z.object({
  amount: amountSchema,
  /** Period length in seconds, e.g. 86400 = per day. Unused allowance does not carry over. */
  periodSeconds: z
    .number()
    .int()
    .min(60)
    .max(365 * 24 * 60 * 60),
});

/** Human-readable Solidity signature, e.g. "transfer(address,uint256)". */
export const functionSignatureSchema = z.string().refine((sig) => {
  try {
    parseAbiItem(`function ${sig}`);
    return true;
  } catch {
    return false;
  }
}, "invalid function signature, expected e.g. transfer(address,uint256)");

/**
 * Argument rule. `eq` on static types is enforceable on-chain (AllowedCalldata byte-range equality);
 * every other operator is checked off-chain (SDK pre-check now, co-signer later).
 */
export const argRuleSchema = z.object({
  /** 0-based index of the argument in the function signature. */
  index: z.number().int().nonnegative(),
  op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]),
  /** Address, decimal integer, or 0x-hex, interpreted by the argument's ABI type. */
  value: z.string().min(1),
});

const nativeTransferSchema = z.object({
  kind: z.literal("nativeTransfer"),
  /** Plain ETH sends (empty calldata) to these addresses only. */
  recipients: z.array(addressSchema).min(1),
  perTx: amountSchema.optional(),
  /** Required: the on-chain safety floor. */
  perPeriod: periodLimitSchema,
});

const erc20TransferSchema = z.object({
  kind: z.literal("erc20Transfer"),
  token: addressSchema,
  /** `token.transfer(to, …)` to these addresses only. */
  recipients: z.array(addressSchema).min(1),
  /** Off-chain only (no per-tx ERC-20 enforcer); acts as the escalation threshold. */
  perTx: amountSchema.optional(),
  /** Required: the on-chain safety floor. */
  perPeriod: periodLimitSchema,
});

const contractCallSchema = z.object({
  kind: z.literal("contractCall"),
  /** Exactly one target per permission (avoids the targets × methods cross-product). */
  target: addressSchema,
  functions: z
    .array(
      z.object({
        signature: functionSignatureSchema,
        args: z.array(argRuleSchema).default([]),
      }),
    )
    .min(1),
  /** Native value attached to calls. Omitted = calls must carry 0 value. */
  value: z
    .object({
      perTx: amountSchema.optional(),
      perPeriod: periodLimitSchema,
    })
    .optional(),
});

export const permissionSchema = z.discriminatedUnion("kind", [
  nativeTransferSchema,
  erc20TransferSchema,
  contractCallSchema,
]);

export const tokenSchema = z.union([z.literal("native"), addressSchema]);

export const escalationSchema = z.object({
  /** Out-of-policy (but not forbidden) actions become owner approval requests instead of failing. */
  enabled: z.boolean().default(true),
  /** How long an approval request (and the one-shot delegation it produces) stays valid. */
  approvalTtlSeconds: z.number().int().min(60).max(86_400).default(900),
  /** Above these amounts phoswallet denies outright and doesn't even ask the owner. */
  hardMax: z.array(z.object({ token: tokenSchema, amount: amountSchema })).default([]),
});

export const policySchema = z
  .object({
    version: z.literal(1),
    chainId,
    /** The agent's EOA: the delegate that redeems delegations. */
    agent: addressSchema,
    name: z.string().max(80).optional(),
    validFrom: unixSeconds.optional(),
    /** Required. No open-ended grants. */
    expiresAt: unixSeconds,
    permissions: z.array(permissionSchema).min(1),
    escalation: escalationSchema.default({ enabled: true, approvalTtlSeconds: 900, hardMax: [] }),
    /** Never executed by the agent and never offered for approval. */
    forbidden: z.object({ targets: z.array(addressSchema).default([]) }).default({ targets: [] }),
  })
  .superRefine((p, ctx) => {
    const start = p.validFrom ?? 0;
    if (p.expiresAt <= start) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt must be after validFrom" });
    }
    if (p.validFrom !== undefined && p.expiresAt - p.validFrom > MAX_GRANT_SECONDS) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "grant longer than 90 days" });
    }
    const forbidden = new Set(p.forbidden.targets);
    p.permissions.forEach((perm, i) => {
      const touched =
        perm.kind === "contractCall"
          ? [perm.target]
          : perm.kind === "erc20Transfer"
            ? [perm.token, ...perm.recipients]
            : perm.recipients;
      for (const addr of touched) {
        if (forbidden.has(addr)) {
          ctx.addIssue({
            code: "custom",
            path: ["permissions", i],
            message: `permission touches forbidden address ${addr}`,
          });
        }
      }
    });
  });

/** JSON / input shape (amounts as strings). */
export type PolicyInput = z.input<typeof policySchema>;
/** Parsed shape (amounts as bigint, addresses checksummed, defaults applied). */
export type Policy = z.output<typeof policySchema>;
export type Permission = z.output<typeof permissionSchema>;

/**
 * Where each rule is enforced. "onchain" = MetaMask Delegation Framework caveat enforcer (hard floor,
 * holds even if phoswallet is down or compromised). "offchain" = SDK/policy-service check that can
 * only *refuse or escalate*, never widen what's on-chain.
 */
export const ENFORCEMENT = {
  agent: { where: "onchain", how: "delegation.delegate" },
  expiresAt: { where: "onchain", how: "TimestampEnforcer" },
  validFrom: { where: "onchain", how: "TimestampEnforcer" },
  "nativeTransfer.recipients": { where: "onchain", how: "AllowedTargetsEnforcer + ExactCalldataEnforcer(0x)" },
  "nativeTransfer.perTx": { where: "onchain", how: "ValueLteEnforcer" },
  "nativeTransfer.perPeriod": { where: "onchain", how: "NativeTokenPeriodTransferEnforcer" },
  "erc20Transfer.token": { where: "onchain", how: "ERC20PeriodTransferEnforcer (target == token, transfer only)" },
  "erc20Transfer.recipients": {
    where: "onchain",
    how: "AllowedCalldataEnforcer @ offset 4 (one recipient; several via LogicalOrWrapperEnforcer)",
  },
  "erc20Transfer.perTx": { where: "offchain", how: "SDK pre-check → escalation" },
  "erc20Transfer.perPeriod": { where: "onchain", how: "ERC20PeriodTransferEnforcer" },
  "contractCall.target": { where: "onchain", how: "AllowedTargetsEnforcer" },
  "contractCall.functions": { where: "onchain", how: "AllowedMethodsEnforcer" },
  "contractCall.args[eq, static types]": { where: "onchain", how: "AllowedCalldataEnforcer" },
  "contractCall.args[other ops]": { where: "offchain", how: "SDK pre-check; later co-signer enforcer" },
  "contractCall.value": { where: "onchain", how: "ValueLteEnforcer + NativeTokenPeriodTransferEnforcer" },
  "escalation.*": {
    where: "offchain",
    how: "SDK + policy-service queue; approval = passkey-signed one-shot delegation",
  },
  "forbidden.targets": {
    where: "offchain",
    how: "never escalated; agent already can't reach them on-chain (allowlist)",
  },
} as const;

export function parsePolicy(input: unknown): Policy {
  return policySchema.parse(input);
}
