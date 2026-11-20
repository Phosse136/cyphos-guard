/**
 * `pnpm dev` (repo root): local fork + policy service + approver, all in one terminal.
 * NETWORK=live skips the fork and points everything at Base Sepolia.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureFork } from "@cyphos-guard/sdk/testing";
import { generatePrivateKey } from "viem/accounts";

const network = process.env.NETWORK ?? "fork";
const root = resolve(import.meta.dirname, "../../..");
/** Fork dev: a throwaway co-signer key in .env (ADR 0005). On live, set COSIGNER_PRIVATE_KEY yourself. */
function ensureCosignerKey() {
  const envPath = resolve(root, ".env");
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(resolve(root, ".env.example"), "utf8");
  if (/^COSIGNER_PRIVATE_KEY=0x[0-9a-fA-F]{64}\s*$/m.test(env)) return;
  const line = `COSIGNER_PRIVATE_KEY=${generatePrivateKey()}`;
  const next = /^COSIGNER_PRIVATE_KEY=.*$/m.test(env)
    ? env.replace(/^COSIGNER_PRIVATE_KEY=.*$/m, line)
    : `${env.trimEnd()}\n${line}\n`;
  writeFileSync(envPath, next, { mode: 0o600 });
  console.log("[dev]      generated a throwaway co-signer key in .env (COSIGNER_PRIVATE_KEY)");
}

if (network === "fork") {
  ensureCosignerKey();
  // Each `pnpm dev` starts a FRESH fork, so the policy service's fork database must start fresh too:
  // otherwise it would remember a passkey, account and grants that don't exist on the new fork.
  const db = resolve(root, ".dev/policy-fork.sqlite");
  mkdirSync(dirname(db), { recursive: true });
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  process.env.POLICY_DB_PATH = db;
  console.log("[dev]      fresh fork database (.dev/policy-fork.sqlite)");
  await ensureFork(
    process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545",
    process.env.RPC_URL ?? "https://sepolia.base.org",
  );
  console.log("[fork]     anvil fork of Base Sepolia on http://127.0.0.1:8545");
}

const children: ChildProcess[] = [];
const run = (name: string, cwd: string, args: string[]) => {
  const child = spawn("pnpm", args, {
    cwd: resolve(root, cwd),
    env: { ...process.env, NETWORK: network, NEXT_TELEMETRY_DISABLED: "1" },
  });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((l) => `[${name.padEnd(8)}] ${l}`)
      .join("\n");
  child.stdout?.on("data", (c: Buffer) => console.log(prefix(c)));
  child.stderr?.on("data", (c: Buffer) => console.error(prefix(c)));
  child.on("exit", (code) => {
    console.log(`[${name}] exited (${code}); stopping everything`);
    process.exit(code ?? 1);
  });
  children.push(child);
};

run("service", "apps/policy-service", ["dev"]);
run("approver", "apps/approver", ["dev"]);
console.log("\nOpen http://localhost:3000 (use localhost, not 127.0.0.1: the passkey is bound to that hostname)\n");

const stop = () => {
  for (const c of children) c.kill();
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
