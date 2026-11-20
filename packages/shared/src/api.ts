/**
 * Wire contract between agent SDK, policy-service and approver app.
 * Amounts are decimal strings (wei); hex fields are 0x-strings; timestamps are unix seconds.
 */
import { type Address, type Hex, sha256, toBytes } from "viem";
import { z } from "zod";
import { addressSchema } from "./policy.ts";

// ---------- agent request authentication (EIP-191 signature over method, path, time, body hash) ----------

export const AGENT_HEADERS = {
  agent: "x-cyphos-agent",
  timestamp: "x-cyphos-timestamp",
  signature: "x-cyphos-signature",
  /** Random per request, so identical requests in the same second still get distinct signatures. */
  nonce: "x-cyphos-nonce",
} as const;

/** Signed requests older/newer than this are rejected (replay window). */
export const AGENT_AUTH_MAX_SKEW_SECONDS = 300;

export function agentAuthMessage(args: {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
}): string {
  return [
    "cyphos-guard-agent-auth-v1",
    `${args.method.toUpperCase()} ${args.path}`,
    String(args.timestamp),
    args.nonce,
    sha256(toBytes(args.body)),
  ].join("\n");
}

// ---------- bodies ----------

const hexSchema = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "expected 0x-prefixed even-length hex");
const weiSchema = z.string().regex(/^\d+$/, "expected wei as decimal string");

export const executionSchema = z.object({
  to: addressSchema,
  value: weiSchema.default("0"),
  data: hexSchema.default("0x"),
});

export const createApprovalRequestSchema = executionSchema.extend({
  /** The owner's smart account the agent acts for. */
  account: addressSchema,
  /** Why the agent wants this; shown to the owner (untrusted text). */
  reason: z.string().trim().min(1).max(500),
});

export const caveatSchema = z.object({ enforcer: addressSchema, terms: hexSchema, args: hexSchema });
export const delegationSchema = z.object({
  delegate: addressSchema,
  delegator: addressSchema,
  authority: hexSchema,
  caveats: z.array(caveatSchema),
  salt: hexSchema,
  signature: hexSchema,
});

export const requestStatusSchema = z.enum(["pending", "approved", "rejected", "expired", "executed"]);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

export type SignedDelegationJSON = z.infer<typeof delegationSchema>;

export type ApprovalRequestJSON = {
  id: string;
  account: Address;
  agent: Address;
  to: Address;
  value: string;
  data: Hex;
  reason: string;
  status: RequestStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  txHash: Hex | null;
  /** Present once approved: the passkey-signed one-shot delegation the agent redeems. */
  delegation: SignedDelegationJSON | null;
};

export type GrantJSON = {
  id: string;
  account: Address;
  agent: Address;
  name: string | null;
  /** Policy as JSON input (amounts as strings). */
  policy: unknown;
  delegations: SignedDelegationJSON[];
  status: "active" | "revoked";
  createdAt: number;
  revokedAt: number | null;
};

export type ActivityJSON = {
  id: number;
  account: Address;
  agent: Address | null;
  kind:
    | "grant_created"
    | "grant_revoked"
    | "routine_executed"
    | "request_created"
    | "request_approved"
    | "request_rejected"
    | "request_executed"
    | "request_denied";
  detail: Record<string, unknown>;
  txHash: Hex | null;
  createdAt: number;
};

/** Errors the service returns to agents when it refuses to escalate. */
export type EscalationRefusal = "forbidden" | "over_hard_max" | "escalation_disabled" | "no_grant";
