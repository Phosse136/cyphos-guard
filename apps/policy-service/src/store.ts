/**
 * Persistence for the policy service. Uses Node's built-in `node:sqlite` (no native build step).
 * Everything goes through the `Store` type, so swapping in Postgres/Drizzle later touches one file.
 *
 * Nothing stored here is a secret that can move funds: signed delegations can only be redeemed by
 * their delegate, and the service holds no keys.
 */
import { DatabaseSync } from "node:sqlite";
import type {
  ActivityJSON,
  ApprovalRequestJSON,
  GrantJSON,
  RequestStatus,
  SignedDelegationJSON,
} from "@cyphos-guard/shared";
import type { Address, Hex } from "viem";

export type Owner = {
  id: number;
  credentialId: string;
  /** COSE public key, base64url (for login verification). */
  publicKey: string;
  /** P-256 coordinates (for the on-chain Hybrid signer). */
  x: Hex;
  y: Hex;
  counter: number;
  transports: string[];
  accountAddress: Address | null;
  createdAt: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owners (
  id INTEGER PRIMARY KEY,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  x TEXT NOT NULL, y TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  account_address TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL, agent TEXT NOT NULL, name TEXT,
  policy TEXT NOT NULL, delegations TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS grants_agent ON grants(agent, status);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL, agent TEXT NOT NULL,
  target TEXT NOT NULL, value TEXT NOT NULL, data TEXT NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  decided_at INTEGER, tx_hash TEXT, delegation TEXT
);
CREATE INDEX IF NOT EXISTS requests_status ON requests(account, status);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL, agent TEXT, kind TEXT NOT NULL,
  detail TEXT NOT NULL, tx_hash TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_account ON activity(account, id);
`;

type Row = Record<string, unknown>;
const s = (v: unknown) => v as string;
const n = (v: unknown) => Number(v);

function toOwner(r: Row): Owner {
  return {
    id: n(r.id),
    credentialId: s(r.credential_id),
    publicKey: s(r.public_key),
    x: s(r.x) as Hex,
    y: s(r.y) as Hex,
    counter: n(r.counter),
    transports: JSON.parse(s(r.transports)),
    accountAddress: (r.account_address as Address | null) ?? null,
    createdAt: n(r.created_at),
  };
}
function toGrant(r: Row): GrantJSON {
  return {
    id: s(r.id),
    account: s(r.account) as Address,
    agent: s(r.agent) as Address,
    name: (r.name as string | null) ?? null,
    policy: JSON.parse(s(r.policy)),
    delegations: JSON.parse(s(r.delegations)),
    status: s(r.status) as GrantJSON["status"],
    createdAt: n(r.created_at),
    revokedAt: r.revoked_at == null ? null : n(r.revoked_at),
  };
}
function toRequest(r: Row): ApprovalRequestJSON {
  return {
    id: s(r.id),
    account: s(r.account) as Address,
    agent: s(r.agent) as Address,
    to: s(r.target) as Address,
    value: s(r.value),
    data: s(r.data) as Hex,
    reason: s(r.reason),
    status: s(r.status) as RequestStatus,
    createdAt: n(r.created_at),
    expiresAt: n(r.expires_at),
    decidedAt: r.decided_at == null ? null : n(r.decided_at),
    txHash: (r.tx_hash as Hex | null) ?? null,
    delegation: r.delegation == null ? null : JSON.parse(s(r.delegation)),
  };
}
function toActivity(r: Row): ActivityJSON {
  return {
    id: n(r.id),
    account: s(r.account) as Address,
    agent: (r.agent as Address | null) ?? null,
    kind: s(r.kind) as ActivityJSON["kind"],
    detail: JSON.parse(s(r.detail)),
    txHash: (r.tx_hash as Hex | null) ?? null,
    createdAt: n(r.created_at),
  };
}

export function openStore(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  const one = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).get(...p) as Row | undefined;
  const all = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).all(...p) as Row[];
  const run = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).run(...p);

  return {
    close: () => db.close(),

    owners: {
      count: () => n(one("SELECT COUNT(*) c FROM owners")?.c),
      countSince: (since: number) => n(one("SELECT COUNT(*) c FROM owners WHERE created_at >= ?", since)?.c),
      create: (o: Omit<Owner, "id" | "accountAddress">) => {
        const r = run(
          "INSERT INTO owners (credential_id, public_key, x, y, counter, transports, created_at) VALUES (?,?,?,?,?,?,?)",
          o.credentialId,
          o.publicKey,
          o.x,
          o.y,
          o.counter,
          JSON.stringify(o.transports),
          o.createdAt,
        );
        return n(r.lastInsertRowid);
      },
      byId: (id: number) => {
        const r = one("SELECT * FROM owners WHERE id = ?", id);
        return r ? toOwner(r) : null;
      },
      byCredential: (credentialId: string) => {
        const r = one("SELECT * FROM owners WHERE credential_id = ?", credentialId);
        return r ? toOwner(r) : null;
      },
      all: () => all("SELECT * FROM owners").map(toOwner),
      setCounter: (id: number, counter: number) => run("UPDATE owners SET counter = ? WHERE id = ?", counter, id),
      setAccount: (id: number, account: Address) =>
        run("UPDATE owners SET account_address = ? WHERE id = ?", account, id),
    },

    sessions: {
      create: (tokenHash: string, ownerId: number, expiresAt: number) =>
        run("INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES (?,?,?)", tokenHash, ownerId, expiresAt),
      ownerFor: (tokenHash: string, now: number) => {
        const r = one("SELECT owner_id FROM sessions WHERE token_hash = ? AND expires_at > ?", tokenHash, now);
        return r ? n(r.owner_id) : null;
      },
      delete: (tokenHash: string) => run("DELETE FROM sessions WHERE token_hash = ?", tokenHash),
    },

    grants: {
      create: (g: Omit<GrantJSON, "revokedAt" | "status">) =>
        run(
          "INSERT INTO grants (id, account, agent, name, policy, delegations, status, created_at) VALUES (?,?,?,?,?,?,'active',?)",
          g.id,
          g.account,
          g.agent,
          g.name,
          JSON.stringify(g.policy),
          JSON.stringify(g.delegations),
          g.createdAt,
        ),
      byId: (id: string) => {
        const r = one("SELECT * FROM grants WHERE id = ?", id);
        return r ? toGrant(r) : null;
      },
      forAccount: (account: string) =>
        all("SELECT * FROM grants WHERE lower(account) = lower(?) ORDER BY created_at DESC", account).map(toGrant),
      activeForAgent: (agent: string) =>
        all("SELECT * FROM grants WHERE lower(agent) = lower(?) AND status = 'active'", agent).map(toGrant),
      activeFor: (account: string, agent: string) =>
        all(
          "SELECT * FROM grants WHERE lower(account) = lower(?) AND lower(agent) = lower(?) AND status = 'active' ORDER BY created_at DESC",
          account,
          agent,
        ).map(toGrant),
      markRevoked: (id: string, at: number) =>
        run("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?", at, id),
    },

    requests: {
      create: (r: Omit<ApprovalRequestJSON, "status" | "decidedAt" | "txHash" | "delegation">) =>
        run(
          "INSERT INTO requests (id, account, agent, target, value, data, reason, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)",
          r.id,
          r.account,
          r.agent,
          r.to,
          r.value,
          r.data,
          r.reason,
          r.createdAt,
          r.expiresAt,
        ),
      byId: (id: string) => {
        const r = one("SELECT * FROM requests WHERE id = ?", id);
        return r ? toRequest(r) : null;
      },
      list: (account: string, status?: RequestStatus, limit = 200) =>
        (status
          ? all(
              "SELECT * FROM requests WHERE lower(account) = lower(?) AND status = ? ORDER BY created_at DESC",
              account,
              status,
            )
          : all(
              "SELECT * FROM requests WHERE lower(account) = lower(?) ORDER BY created_at DESC LIMIT ?",
              account,
              limit,
            )
        ).map(toRequest),
      /** Expire pending/approved requests whose window has passed. Returns the ids it expired. */
      expire: (now: number) => {
        const rows = all("SELECT id FROM requests WHERE status IN ('pending','approved') AND expires_at <= ?", now);
        run("UPDATE requests SET status = 'expired' WHERE status IN ('pending','approved') AND expires_at <= ?", now);
        return rows.map((r) => s(r.id));
      },
      /** Conditional transition: only succeeds from `from` status (prevents double-approve races). */
      transition: (
        id: string,
        from: RequestStatus,
        to: RequestStatus,
        patch: { decidedAt?: number; delegation?: SignedDelegationJSON; txHash?: Hex } = {},
      ) => {
        const r = run(
          `UPDATE requests SET status = ?,
             decided_at = COALESCE(?, decided_at),
             delegation = COALESCE(?, delegation),
             tx_hash = COALESCE(?, tx_hash)
           WHERE id = ? AND status = ?`,
          to,
          patch.decidedAt ?? null,
          patch.delegation ? JSON.stringify(patch.delegation) : null,
          patch.txHash ?? null,
          id,
          from,
        );
        return Number(r.changes) === 1;
      },
    },

    activity: {
      add: (a: Omit<ActivityJSON, "id">) =>
        run(
          "INSERT INTO activity (account, agent, kind, detail, tx_hash, created_at) VALUES (?,?,?,?,?,?)",
          a.account,
          a.agent,
          a.kind,
          JSON.stringify(a.detail),
          a.txHash,
          a.createdAt,
        ),
      /** Events per kind since `since` (unix s), across all accounts: for the operator's daily summary. */
      countsSince: (since: number): Record<string, number> =>
        Object.fromEntries(
          all("SELECT kind, COUNT(*) c FROM activity WHERE created_at >= ? GROUP BY kind", since).map((r) => [
            String(r.kind),
            n(r.c),
          ]),
        ),
      forAgent: (agent: string, limit = 100) =>
        all("SELECT * FROM activity WHERE lower(agent) = lower(?) ORDER BY id DESC LIMIT ?", agent, limit).map(
          toActivity,
        ),
      /** Newest first. `beforeId` pages backwards (exclusive). */
      list: (account: string, limit = 100, beforeId?: number) =>
        (beforeId !== undefined
          ? all(
              "SELECT * FROM activity WHERE lower(account) = lower(?) AND id < ? ORDER BY id DESC LIMIT ?",
              account,
              beforeId,
              limit,
            )
          : all("SELECT * FROM activity WHERE lower(account) = lower(?) ORDER BY id DESC LIMIT ?", account, limit)
        ).map(toActivity),
    },
  };
}

export type Store = ReturnType<typeof openStore>;
