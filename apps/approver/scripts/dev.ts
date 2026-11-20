/**
 * `pnpm dev` (repo root): local fork + policy service + approver, all in one terminal.
 * NETWORK=live skips the fork and points everything at Base Sepolia.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { ensureFork } from "@phoswallet/sdk/testing";

const network = process.env.NETWORK ?? "fork";
const root = resolve(import.meta.dirname, "../../..");
if (network === "fork") {
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
