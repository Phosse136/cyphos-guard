import type { ActivityJSON, ApprovalRequestJSON, GrantJSON } from "@cyphos-guard/shared";
import type { Address, Hex } from "viem";

export type Me = {
  registrationOpen: boolean;
  fork: boolean;
  chainId: number;
  owner: { credentialId: string; keyId: Hex; x: Hex; y: Hex; accountAddress: Address | null } | null;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  me: () => call<Me>("GET", "/me"),
  registerOptions: () => call<{ challengeId: string; options: never }>("POST", "/auth/register/options"),
  registerVerify: (challengeId: string, response: unknown) =>
    call<{ keyId: Hex; x: Hex; y: Hex }>("POST", "/auth/register/verify", { challengeId, response }),
  loginOptions: () => call<{ challengeId: string; options: never }>("POST", "/auth/login/options"),
  loginVerify: (challengeId: string, response: unknown) =>
    call("POST", "/auth/login/verify", { challengeId, response }),
  logout: () => call("POST", "/auth/logout"),
  linkAccount: (accountAddress: Address) => call("PUT", "/me/account", { accountAddress }),
  requests: (status?: string) => call<ApprovalRequestJSON[]>("GET", `/requests${status ? `?status=${status}` : ""}`),
  approve: (id: string, delegation: unknown) =>
    call<ApprovalRequestJSON>("POST", `/requests/${id}/approve`, { delegation }),
  reject: (id: string) => call<ApprovalRequestJSON>("POST", `/requests/${id}/reject`),
  grants: () => call<GrantJSON[]>("GET", "/grants"),
  createGrant: (policy: unknown, delegations: unknown[]) => call<GrantJSON>("POST", "/grants", { policy, delegations }),
  markRevoked: (id: string, txHash: Hex) => call("POST", `/grants/${id}/revoked`, { txHash }),
  activity: () => call<ActivityJSON[]>("GET", "/activity"),
  cosigner: () => call<{ enabled: boolean; address: Address | null; enforcer: Address }>("GET", "/cosigner"),
  devRelay: (userOp: unknown) => call<{ txHash: Hex }>("POST", "/dev/relay", { userOp }),
  devFund: (address: Address) => call("POST", "/dev/fund", { address }),
};
