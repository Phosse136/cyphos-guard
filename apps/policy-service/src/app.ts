/**
 * cyphos-guard policy service: approval queue + grant registry + activity log.
 *
 * Trust model (see docs/decisions/0004-approval-flow.md):
 * - Holds no keys that can move funds. Approvals are signed by the owner's passkey in the browser;
 *   the service only stores and relays them, and re-checks them (structure + on-chain simulation).
 * - Agents authenticate every request with an EIP-191 signature from their own key.
 * - The owner authenticates with a passkey (WebAuthn), getting an HttpOnly session cookie.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  checkApprovalDelegation,
  cosignerEnforcerAddress,
  cosignTypedData,
  delegationCosigner,
  passkeyKeyId,
  type UserOpJSON,
} from "@cyphos-guard/sdk";
import {
  AGENT_AUTH_MAX_SKEW_SECONDS,
  AGENT_HEADERS,
  addressSchema,
  agentAuthMessage,
  createApprovalRequestSchema,
  delegationSchema,
  escalationDecision,
  offchainCheck,
  parsePolicy,
  policySchema,
  requestStatusSchema,
  type X402Context,
  x402ContextSchema,
} from "@cyphos-guard/shared";
import type { Delegation } from "@metamask/smart-accounts-kit";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  isAddressEqual,
  isHex,
  type LocalAccount,
  toHex,
  verifyMessage,
} from "viem";
import { z } from "zod";
import type { ChainAdapter } from "./chain.ts";
import type { Owner, Store } from "./store.ts";

export type AppConfig = {
  rpId: string;
  rpName: string;
  /** Approver app origin(s) allowed for WebAuthn. */
  origins: string[];
  sessionTtlSeconds: number;
  secureCookies: boolean;
  /**
   * Co-signer key (ADR 0005). It can only BLOCK: a cosignature adds a requirement to a redemption and grants
   * nothing by itself. Absent → co-signing disabled.
   */
  cosigner?: LocalAccount;
  /**
   * One-time owner setup code. When set, registering the owner passkey requires it, so on a public address a
   * stranger cannot claim the instance before the owner does. Absent → the first passkey becomes the owner.
   */
  setupCode?: string;
};

type Env = { Variables: { owner: Owner; agent: Address; body: unknown } };

const SESSION_COOKIE = "cyphos_session";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const nowS = () => Math.floor(Date.now() / 1000);
const toX402 = (x?: z.output<typeof x402ContextSchema>): X402Context | undefined =>
  x && { payTo: x.payTo, amount: BigInt(x.amount), resource: x.resource };

export function createApp({ store, chain, config }: { store: Store; chain: ChainAdapter; config: AppConfig }) {
  const app = new Hono<Env>();
  const challenges = new Map<string, { challenge: string; kind: "register" | "login"; exp: number }>();
  const seenAgentSigs = new Map<string, number>();

  const takeChallenge = (id: unknown, kind: "register" | "login") => {
    const c = typeof id === "string" ? challenges.get(id) : undefined;
    if (typeof id === "string") challenges.delete(id);
    if (!c || c.kind !== kind || c.exp < nowS()) throw new HTTPException(400, { message: "challenge expired" });
    return c.challenge;
  };
  const newChallengeId = (challenge: string, kind: "register" | "login") => {
    const id = randomBytes(16).toString("hex");
    challenges.set(id, { challenge, kind, exp: nowS() + 300 });
    for (const [k, v] of challenges) if (v.exp < nowS()) challenges.delete(k);
    return id;
  };
  const startSession = (c: Parameters<MiddlewareHandler<Env>>[0], ownerId: number) => {
    const token = randomBytes(32).toString("base64url");
    store.sessions.create(sha(token), ownerId, nowS() + config.sessionTtlSeconds);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: config.secureCookies,
      path: "/",
      maxAge: config.sessionTtlSeconds,
    });
  };
  const parse = <T>(schema: z.ZodType<T>, data: unknown): T => {
    const r = schema.safeParse(data);
    if (!r.success) throw new HTTPException(400, { message: z.prettifyError(r.error) });
    return r.data;
  };

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  // ---------- middleware ----------

  const ownerAuth: MiddlewareHandler<Env> = async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const ownerId = token ? store.sessions.ownerFor(sha(token), nowS()) : null;
    const owner = ownerId ? store.owners.byId(ownerId) : null;
    if (!owner) throw new HTTPException(401, { message: "login required" });
    c.set("owner", owner);
    await next();
  };
  const requireAccount = (o: Owner): Address => {
    if (!o.accountAddress) throw new HTTPException(409, { message: "no smart account linked yet" });
    return o.accountAddress;
  };

  /** Verifies the agent's EIP-191 signature over method, path, timestamp and body. */
  const agentAuth: MiddlewareHandler<Env> = async (c, next) => {
    const agent = c.req.header(AGENT_HEADERS.agent);
    const ts = Number(c.req.header(AGENT_HEADERS.timestamp));
    const sig = c.req.header(AGENT_HEADERS.signature);
    const nonce = c.req.header(AGENT_HEADERS.nonce) ?? "";
    if (
      !agent ||
      !addressSchema.safeParse(agent).success ||
      !sig ||
      !isHex(sig) ||
      !Number.isInteger(ts) ||
      !/^[0-9a-f]{16,64}$/.test(nonce)
    ) {
      throw new HTTPException(401, { message: "missing agent auth headers" });
    }
    if (Math.abs(nowS() - ts) > AGENT_AUTH_MAX_SKEW_SECONDS) throw new HTTPException(401, { message: "stale request" });
    if (seenAgentSigs.has(sig)) throw new HTTPException(401, { message: "replayed request" });
    const body = c.req.method === "GET" ? "" : await c.req.text();
    const message = agentAuthMessage({
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      timestamp: ts,
      nonce,
      body,
    });
    const valid = await verifyMessage({ address: agent as Address, message, signature: sig }).catch(() => false);
    if (!valid) throw new HTTPException(401, { message: "bad agent signature" });
    seenAgentSigs.set(sig, ts);
    for (const [k, t] of seenAgentSigs) if (Math.abs(nowS() - t) > AGENT_AUTH_MAX_SKEW_SECONDS) seenAgentSigs.delete(k);
    c.set("agent", addressSchema.parse(agent));
    c.set("body", body ? JSON.parse(body) : undefined);
    await next();
  };

  // ---------- health ----------
  app.get("/health", (c) => c.json({ ok: true, chainId: chain.chainId, fork: chain.isFork }));

  // ---------- owner: passkey registration & login ----------

  app.get("/me", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const ownerId = token ? store.sessions.ownerFor(sha(token), nowS()) : null;
    const owner = ownerId ? store.owners.byId(ownerId) : null;
    return c.json({
      registrationOpen: store.owners.count() === 0,
      setupCodeRequired: Boolean(config.setupCode),
      fork: chain.isFork,
      chainId: chain.chainId,
      owner: owner && {
        credentialId: owner.credentialId,
        keyId: passkeyKeyId(owner.credentialId),
        x: owner.x,
        y: owner.y,
        accountAddress: owner.accountAddress,
      },
    });
  });

  app.post("/auth/register/options", async (c) => {
    // Single-owner, self-hosted MVP: the first passkey to register becomes the owner; afterwards closed.
    if (store.owners.count() > 0) throw new HTTPException(403, { message: "registration is closed" });
    if (config.setupCode) {
      // Only a caller with the code gets a challenge; /verify needs that challenge, so it is gated too.
      const body = (await c.req.json().catch(() => ({}))) as { setupCode?: unknown };
      const given = sha(typeof body.setupCode === "string" ? body.setupCode.trim() : "");
      if (!timingSafeEqual(Buffer.from(given), Buffer.from(sha(config.setupCode)))) {
        throw new HTTPException(403, { message: "wrong setup code" });
      }
    }
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpId,
      userName: "owner",
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: [-7], // ES256 = P-256, the curve the smart account verifies on-chain
    });
    return c.json({ challengeId: newChallengeId(options.challenge, "register"), options });
  });

  app.post("/auth/register/verify", async (c) => {
    if (store.owners.count() > 0) throw new HTTPException(403, { message: "registration is closed" });
    const body = (await c.req.json()) as {
      challengeId: string;
      response: Parameters<typeof verifyRegistrationResponse>[0]["response"];
    };
    const expectedChallenge = takeChallenge(body.challengeId, "register");
    const v = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7],
    }).catch((e: Error) => {
      throw new HTTPException(400, { message: `registration failed: ${e.message}` });
    });
    if (!v.verified) throw new HTTPException(400, { message: "registration not verified" });
    const { credential } = v.registrationInfo;
    const key = decodeCredentialPublicKey(credential.publicKey);
    if (!cose.isCOSEPublicKeyEC2(key)) throw new HTTPException(400, { message: "expected a P-256 (EC2) key" });
    const x = key.get(cose.COSEKEYS.x);
    const y = key.get(cose.COSEKEYS.y);
    if (!x || !y || key.get(cose.COSEKEYS.crv) !== cose.COSECRV.P256) {
      throw new HTTPException(400, { message: "expected a P-256 key" });
    }
    const id = store.owners.create({
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      x: toHex(x),
      y: toHex(y),
      counter: credential.counter,
      transports: credential.transports ?? [],
      createdAt: nowS(),
    });
    startSession(c, id);
    return c.json({
      ok: true,
      credentialId: credential.id,
      keyId: passkeyKeyId(credential.id),
      x: toHex(x),
      y: toHex(y),
    });
  });

  app.post("/auth/login/options", async (c) => {
    const owners = store.owners.all();
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      userVerification: "required",
      allowCredentials: owners.map((o) => ({ id: o.credentialId })),
    });
    return c.json({ challengeId: newChallengeId(options.challenge, "login"), options });
  });

  app.post("/auth/login/verify", async (c) => {
    const body = (await c.req.json()) as {
      challengeId: string;
      response: Parameters<typeof verifyAuthenticationResponse>[0]["response"];
    };
    const expectedChallenge = takeChallenge(body.challengeId, "login");
    const owner = store.owners.byCredential(body.response?.id);
    if (!owner) throw new HTTPException(401, { message: "unknown passkey" });
    const v = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: owner.credentialId,
        publicKey: new Uint8Array(Buffer.from(owner.publicKey, "base64url")),
        counter: owner.counter,
        transports: owner.transports,
      },
    }).catch(() => ({ verified: false as const }));
    if (!v.verified) throw new HTTPException(401, { message: "login failed" });
    store.owners.setCounter(owner.id, v.authenticationInfo.newCounter);
    startSession(c, owner.id);
    return c.json({ ok: true });
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) store.sessions.delete(sha(token));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ---------- owner: account, grants, requests, activity ----------

  app.put("/me/account", ownerAuth, async (c) => {
    const owner = c.get("owner");
    const { accountAddress } = parse(z.object({ accountAddress: addressSchema }), await c.req.json());
    // Don't trust the client: the account must exist on-chain with this passkey as a signer.
    const ok = await chain.accountHasPasskey(accountAddress, passkeyKeyId(owner.credentialId), owner.x, owner.y);
    if (!ok)
      throw new HTTPException(400, { message: "account is not deployed or does not have this passkey as signer" });
    store.owners.setAccount(owner.id, accountAddress);
    return c.json({ ok: true });
  });

  app.get("/grants", ownerAuth, (c) => c.json(store.grants.forAccount(requireAccount(c.get("owner")))));

  app.post("/grants", ownerAuth, async (c) => {
    const account = requireAccount(c.get("owner"));
    const body = parse(
      z.object({ policy: z.unknown(), delegations: z.array(delegationSchema).min(1) }),
      await c.req.json(),
    );
    const policy = parse(policySchema, body.policy);
    if (policy.chainId !== chain.chainId) throw new HTTPException(400, { message: "policy is for another chain" });
    if (body.delegations.length !== policy.permissions.length) {
      throw new HTTPException(400, { message: "need exactly one delegation per permission" });
    }
    for (const d of body.delegations) {
      if (!isAddressEqual(d.delegator, account) || !isAddressEqual(d.delegate, policy.agent)) {
        throw new HTTPException(400, { message: "delegation does not match account/agent" });
      }
    }
    if (policy.cosigner) {
      if (!config.cosigner || !isAddressEqual(policy.cosigner, config.cosigner.address)) {
        throw new HTTPException(400, { message: "policy names a co-signer this service doesn't hold" });
      }
      const cosigner = policy.cosigner;
      if (
        !body.delegations.every((d) => delegationCosigner(d as Delegation)?.toLowerCase() === cosigner.toLowerCase())
      ) {
        throw new HTTPException(400, { message: "every delegation must carry the co-signer caveat" });
      }
    }
    // One active grant per agent: each grant has its own on-chain period counters, so two overlapping
    // grants would double the agent's effective daily cap. The old one must be revoked on-chain first.
    if (store.grants.activeFor(account, policy.agent).length > 0) {
      throw new HTTPException(409, { message: "agent already has an active grant; revoke it first" });
    }
    const grant = {
      id: crypto.randomUUID(),
      account,
      agent: policy.agent,
      name: policy.name ?? null,
      policy: body.policy,
      delegations: body.delegations,
      createdAt: nowS(),
    };
    store.grants.create(grant);
    store.activity.add({
      account,
      agent: policy.agent,
      kind: "grant_created",
      detail: { grantId: grant.id, name: grant.name },
      txHash: null,
      createdAt: nowS(),
    });
    return c.json(store.grants.byId(grant.id), 201);
  });

  /** Called after the owner revoked on-chain; the service verifies every delegation is disabled. */
  app.post("/grants/:id/revoked", ownerAuth, async (c) => {
    const account = requireAccount(c.get("owner"));
    const grant = store.grants.byId(c.req.param("id"));
    if (!grant || !isAddressEqual(grant.account, account)) throw new HTTPException(404, { message: "no such grant" });
    for (const d of grant.delegations) {
      if (!(await chain.isDisabled(d as Delegation))) {
        throw new HTTPException(409, { message: "delegation is still enabled on-chain" });
      }
    }
    const body = (await c.req.json().catch(() => ({}))) as { txHash?: string };
    store.grants.markRevoked(grant.id, nowS());
    store.activity.add({
      account,
      agent: grant.agent,
      kind: "grant_revoked",
      detail: { grantId: grant.id },
      txHash: isHex(body.txHash) ? body.txHash : null,
      createdAt: nowS(),
    });
    return c.json({ ok: true });
  });

  app.get("/requests", ownerAuth, async (c) => {
    const account = requireAccount(c.get("owner"));
    store.requests.expire(await chain.now());
    const status = c.req.query("status");
    const limit = parse(z.coerce.number().int().min(1).max(1000).default(200), c.req.query("limit"));
    return c.json(store.requests.list(account, status ? parse(requestStatusSchema, status) : undefined, limit));
  });

  app.post("/requests/:id/approve", ownerAuth, async (c) => {
    const account = requireAccount(c.get("owner"));
    store.requests.expire(await chain.now());
    const req = store.requests.byId(c.req.param("id"));
    if (!req || !isAddressEqual(req.account, account)) throw new HTTPException(404, { message: "no such request" });
    if (req.status !== "pending") throw new HTTPException(409, { message: `request is ${req.status}` });
    const { delegation } = parse(z.object({ delegation: delegationSchema }), await c.req.json());
    const execution = { to: req.to, value: BigInt(req.value), data: req.data };

    const mismatch = checkApprovalDelegation(delegation as Delegation, {
      environment: chain.environment,
      delegator: account,
      agent: req.agent,
      execution,
      latestExpiry: req.expiresAt,
    });
    if (mismatch) throw new HTTPException(400, { message: `approval rejected: ${mismatch}` });
    // Only the chain can verify the passkey signature (ERC-1271) and current balances/caveats.
    const sim = await chain.simulateRedeem(req.agent, delegation as Delegation, execution);
    if (sim) throw new HTTPException(400, { message: `approval would not execute: ${sim}` });

    if (!store.requests.transition(req.id, "pending", "approved", { decidedAt: nowS(), delegation })) {
      throw new HTTPException(409, { message: "request changed concurrently" });
    }
    store.activity.add({
      account,
      agent: req.agent,
      kind: "request_approved",
      detail: { requestId: req.id, to: req.to, value: req.value, data: req.data },
      txHash: null,
      createdAt: nowS(),
    });
    return c.json(store.requests.byId(req.id));
  });

  app.post("/requests/:id/reject", ownerAuth, async (c) => {
    const account = requireAccount(c.get("owner"));
    const req = store.requests.byId(c.req.param("id"));
    if (!req || !isAddressEqual(req.account, account)) throw new HTTPException(404, { message: "no such request" });
    if (!store.requests.transition(req.id, "pending", "rejected", { decidedAt: nowS() })) {
      throw new HTTPException(409, { message: `request is ${req.status}` });
    }
    store.activity.add({
      account,
      agent: req.agent,
      kind: "request_rejected",
      detail: { requestId: req.id, to: req.to, value: req.value, data: req.data },
      txHash: null,
      createdAt: nowS(),
    });
    return c.json(store.requests.byId(req.id));
  });

  /** Newest first; `limit` (≤ 1000, default 100) and `before` (an activity id) page backwards. */
  app.get("/activity", ownerAuth, (c) => {
    const limit = parse(z.coerce.number().int().min(1).max(1000).default(100), c.req.query("limit"));
    const before = c.req.query("before");
    const beforeId = before === undefined ? undefined : parse(z.coerce.number().int().positive(), before);
    return c.json(store.activity.list(requireAccount(c.get("owner")), limit, beforeId));
  });

  // ---------- agent API ----------

  app.get("/agent/grants", agentAuth, (c) => c.json(store.grants.activeForAgent(c.get("agent"))));

  app.get("/agent/activity", agentAuth, (c) => c.json(store.activity.forAgent(c.get("agent"))));

  // ---------- co-signer (ADR 0005) ----------

  app.get("/cosigner", (c) =>
    c.json({
      enabled: !!config.cosigner,
      address: config.cosigner?.address ?? null,
      enforcer: cosignerEnforcerAddress,
    }),
  );

  /**
   * Co-sign one redemption: only for an active grant of this agent, a delegation that names our co-signer,
   * and an execution that passes the permission's off-chain rules. The cosignature binds the exact call,
   * the redeemer and the delegation, expires in 5 minutes and can be used once.
   */
  app.post("/agent/cosign", agentAuth, async (c) => {
    if (!config.cosigner) throw new HTTPException(404, { message: "co-signing is not enabled on this service" });
    const agent = c.get("agent");
    const body = parse(
      z.object({
        account: addressSchema,
        grantId: z.string(),
        delegationIndex: z.number().int().nonnegative(),
        to: addressSchema,
        value: z.string().regex(/^\d+$/),
        data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
        x402: x402ContextSchema.optional(),
      }),
      c.get("body"),
    );
    const grant = store.grants.byId(body.grantId);
    if (
      grant?.status !== "active" ||
      !isAddressEqual(grant.agent, agent) ||
      !isAddressEqual(grant.account, body.account)
    ) {
      throw new HTTPException(404, { message: "no such active grant for this agent" });
    }
    const delegation = grant.delegations[body.delegationIndex] as Delegation | undefined;
    const permission = parsePolicy(grant.policy).permissions[body.delegationIndex];
    if (!delegation || !permission) throw new HTTPException(404, { message: "no such delegation" });
    const named = delegationCosigner(delegation);
    if (!named || !isAddressEqual(named, config.cosigner.address)) {
      throw new HTTPException(400, { message: "delegation does not require this co-signer" });
    }
    const execution = { to: body.to, value: BigInt(body.value), data: body.data as Hex };
    const x402 = toX402(body.x402);
    const violation = offchainCheck(permission, execution, x402 ? { x402 } : {});
    if (violation) return c.json({ error: "offchain_rule", message: violation }, 403);

    const salt = toHex(randomBytes(32));
    const deadline = BigInt((await chain.now()) + 300);
    const signature = await config.cosigner.signTypedData(
      cosignTypedData({
        chainId: chain.chainId,
        delegationManager: chain.environment.DelegationManager,
        delegation,
        redeemer: agent,
        execution,
        salt,
        deadline,
      }),
    );
    return c.json({ salt, deadline: deadline.toString(), signature });
  });

  app.post("/agent/requests", agentAuth, async (c) => {
    const agent = c.get("agent");
    const body = parse(createApprovalRequestSchema, c.get("body"));
    const [grant] = store.grants.activeFor(body.account, agent);
    const deny = (code: string, message: string, status: 403 | 404) => {
      store.activity.add({
        account: body.account,
        agent,
        kind: "request_denied",
        detail: { code, message, to: body.to, value: body.value, data: body.data, reason: body.reason },
        txHash: null,
        createdAt: nowS(),
      });
      return c.json({ error: code, message }, status);
    };
    // Not logged to the named account's activity: any agent could otherwise spam any account's log.
    if (!grant) return c.json({ error: "no_grant", message: "no active grant for this agent and account" }, 404);
    const policy = parsePolicy(grant.policy);
    const decision = escalationDecision(policy, { to: body.to, value: BigInt(body.value), data: body.data as Hex });
    if (!decision.ok) return deny(decision.code, decision.message, 403);
    // An x402 top-up is judged by where the money finally goes, too: never ask the owner to fund a forbidden seller.
    if (body.x402 && policy.forbidden.targets.some((t) => isAddressEqual(t, body.x402?.payTo ?? t))) {
      return deny("forbidden", `x402 seller ${body.x402.payTo} is forbidden`, 403);
    }

    const now = await chain.now();
    const req = {
      id: crypto.randomUUID(),
      account: body.account,
      agent,
      to: body.to,
      value: body.value,
      data: body.data as Hex,
      reason: body.reason,
      createdAt: now,
      expiresAt: now + policy.escalation.approvalTtlSeconds,
    };
    store.requests.create(req);
    store.activity.add({
      account: body.account,
      agent,
      kind: "request_created",
      detail: {
        requestId: req.id,
        to: req.to,
        value: req.value,
        data: req.data,
        reason: req.reason,
        ...(body.x402 ? { x402: body.x402 } : {}),
      },
      txHash: null,
      createdAt: nowS(),
    });
    return c.json(store.requests.byId(req.id), 201);
  });

  const agentRequest = (agent: Address, id: string) => {
    const req = store.requests.byId(id);
    if (!req || !isAddressEqual(req.agent, agent)) throw new HTTPException(404, { message: "no such request" });
    return req;
  };

  app.get("/agent/requests/:id", agentAuth, async (c) => {
    store.requests.expire(await chain.now());
    return c.json(agentRequest(c.get("agent"), c.req.param("id")));
  });

  app.post("/agent/requests/:id/executed", agentAuth, async (c) => {
    const agent = c.get("agent");
    const req = agentRequest(agent, c.req.param("id"));
    const { txHash } = parse(z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }), c.get("body"));
    const redeemed = await chain.verifiedRedeem(txHash as Hex, agent);
    if (
      !redeemed ||
      !isAddressEqual(redeemed.delegator, req.account) ||
      !isAddressEqual(redeemed.to, req.to) ||
      redeemed.value !== BigInt(req.value) ||
      redeemed.data.toLowerCase() !== req.data.toLowerCase()
    ) {
      throw new HTTPException(400, { message: "tx is not this request's execution by this agent" });
    }
    if (!store.requests.transition(req.id, "approved", "executed", { txHash: txHash as Hex })) {
      throw new HTTPException(409, { message: `request is ${req.status}` });
    }
    store.activity.add({
      account: req.account,
      agent,
      kind: "request_executed",
      detail: { requestId: req.id, to: req.to, value: req.value, data: req.data },
      txHash: txHash as Hex,
      createdAt: nowS(),
    });
    return c.json(store.requests.byId(req.id));
  });

  app.post("/agent/activity", agentAuth, async (c) => {
    const agent = c.get("agent");
    const body = parse(
      z.object({
        account: addressSchema,
        txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        to: addressSchema,
        value: z.string().regex(/^\d+$/),
        /** The agent's stated reason (untrusted text, shown to the owner as the agent's words). */
        reason: z.string().trim().max(500).optional(),
      }),
      c.get("body"),
    );
    if (store.grants.activeFor(body.account, agent).length === 0) throw new HTTPException(404, { message: "no grant" });
    // Record what the chain says happened, not what the agent claims: decoded from the tx itself, and it
    // must have spent from THIS account (an agent with grants on two accounts can't mislabel activity).
    const redeemed = await chain.verifiedRedeem(body.txHash as Hex, agent);
    if (!redeemed || !isAddressEqual(redeemed.delegator, body.account)) {
      throw new HTTPException(400, { message: "tx is not a successful redemption by this agent from this account" });
    }
    store.activity.add({
      account: body.account,
      agent,
      kind: "routine_executed",
      detail: {
        to: redeemed.to,
        value: redeemed.value.toString(),
        data: redeemed.data,
        ...(body.reason ? { reason: body.reason } : {}),
      },
      txHash: body.txHash as Hex,
      createdAt: nowS(),
    });
    return c.json({ ok: true }, 201);
  });

  app.post("/agent/x402/paid", agentAuth, async (c) => {
    const agent = c.get("agent");
    const body = parse(
      z.object({
        account: addressSchema,
        /** The facilitator's settlement tx (it broadcasts the agent's signed authorization). */
        txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        asset: addressSchema,
        payTo: addressSchema,
        amount: z.string().regex(/^\d+$/),
        resource: z.string().trim().min(1).max(500),
        reason: z.string().trim().max(500).optional(),
      }),
      c.get("body"),
    );
    if (store.grants.activeFor(body.account, agent).length === 0) throw new HTTPException(404, { message: "no grant" });
    // Record what the chain shows: the agent's own address paid the seller exactly this amount in this tx.
    const moved = await chain.erc20Transferred(body.txHash as Hex, body.asset, agent, body.payTo);
    if (moved === null || moved !== BigInt(body.amount)) {
      throw new HTTPException(400, { message: "tx does not show this payment from this agent to this seller" });
    }
    store.activity.add({
      account: body.account,
      agent,
      kind: "x402_paid",
      detail: {
        // Rendered like any token payment: asset.transfer(payTo, amount), paid from the agent's address.
        to: body.asset,
        value: "0",
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [body.payTo, BigInt(body.amount)] }),
        resource: body.resource,
        payer: agent,
        ...(body.reason ? { reason: body.reason } : {}),
      },
      txHash: body.txHash as Hex,
      createdAt: nowS(),
    });
    return c.json({ ok: true }, 201);
  });

  // ---------- fork-only dev helpers (absent on live: the adapter doesn't provide them) ----------

  app.post("/dev/relay", ownerAuth, async (c) => {
    if (!chain.relayUserOp) throw new HTTPException(404, { message: "dev relay only exists on a local fork" });
    const { userOp } = (await c.req.json()) as { userOp: UserOpJSON };
    const owner = c.get("owner");
    // Only relay ops for the owner's own account (or its counterfactual address before linking).
    if (owner.accountAddress && !isAddressEqual(userOp.sender as Address, owner.accountAddress)) {
      throw new HTTPException(403, { message: "can only relay for your own account" });
    }
    try {
      return c.json({ txHash: await chain.relayUserOp(userOp) });
    } catch (e) {
      throw new HTTPException(400, { message: (e as Error).message.split("\n")[0] ?? "relay failed" });
    }
  });

  app.post("/dev/fund", ownerAuth, async (c) => {
    if (!chain.fund) throw new HTTPException(404, { message: "dev funding only exists on a local fork" });
    const { address } = parse(z.object({ address: addressSchema }), await c.req.json());
    await chain.fund(address, "0.05");
    return c.json({ ok: true });
  });

  return app;
}
