/**
 * Typed errors. Agents (and LLM tool handlers) should branch on these instead of parsing messages:
 *
 *   PolicyViolation   denied outright (forbidden, over hard max, no grant, escalation disabled): don't retry
 *   ApprovalPending   the owner was asked; call waitForApproval(error.request.id) later
 *   ApprovalRejected  the owner said no
 *   ApprovalExpired   nobody decided in time (or the approval window passed before redemption)
 *   ExecutionFailed   approved/allowed but the on-chain redemption reverted
 *   PolicyServiceError the policy service failed or was unreachable (after retries)
 *   MissingSigner     method needs an agent or owner signer that wasn't configured
 */
import type { ApprovalRequestJSON, EscalationRefusal } from "@phoswallet/shared";

export class PhoswalletError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class PolicyViolation extends PhoswalletError {
  readonly reason: EscalationRefusal;
  /** Why the agent's own grant(s) didn't cover the action (enforcer revert reasons / off-chain checks). */
  readonly violations: string[];
  constructor(reason: EscalationRefusal, message: string, violations: string[]) {
    super("POLICY_VIOLATION", `${reason}: ${message}`);
    this.reason = reason;
    this.violations = violations;
  }
}

export class ApprovalPending extends PhoswalletError {
  readonly request: ApprovalRequestJSON;
  readonly violations: string[];
  constructor(request: ApprovalRequestJSON, violations: string[] = []) {
    super("APPROVAL_PENDING", `waiting for owner approval (request ${request.id}, expires ${request.expiresAt})`);
    this.request = request;
    this.violations = violations;
  }
}

export class ApprovalRejected extends PhoswalletError {
  readonly request: ApprovalRequestJSON;
  constructor(request: ApprovalRequestJSON) {
    super("APPROVAL_REJECTED", `owner rejected request ${request.id}`);
    this.request = request;
  }
}

export class ApprovalExpired extends PhoswalletError {
  readonly request: ApprovalRequestJSON;
  constructor(request: ApprovalRequestJSON) {
    super("APPROVAL_EXPIRED", `request ${request.id} expired without being executed`);
    this.request = request;
  }
}

export class ExecutionFailed extends PhoswalletError {
  readonly reason: string;
  constructor(reason: string) {
    super("EXECUTION_FAILED", `on-chain execution failed: ${reason}`);
    this.reason = reason;
  }
}

export class PolicyServiceError extends PhoswalletError {
  readonly status: number | null;
  constructor(status: number | null, message: string) {
    super("POLICY_SERVICE_ERROR", message);
    this.status = status;
  }
}

export class MissingSigner extends PhoswalletError {
  constructor(role: "agent" | "owner", method: string) {
    super("MISSING_SIGNER", `${method}() needs an ${role} signer; pass \`${role}\` to createPhoswallet()`);
  }
}
