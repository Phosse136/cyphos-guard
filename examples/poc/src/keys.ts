/**
 * Generates throwaway test keys into the repo-root .env (git-ignored). Never prints private keys.
 * Existing non-empty values are kept, so re-running is safe.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

const root = resolve(import.meta.dirname, "../../..");
const envPath = resolve(root, ".env");

export function ensureKeys(): { owner: `0x${string}`; agent: `0x${string}` } {
  let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(resolve(root, ".env.example"), "utf8");
  const keys = {} as Record<"POC_OWNER_PRIVATE_KEY" | "POC_AGENT_PRIVATE_KEY", `0x${string}`>;
  let changed = !existsSync(envPath);

  for (const name of ["POC_OWNER_PRIVATE_KEY", "POC_AGENT_PRIVATE_KEY"] as const) {
    const match = env.match(new RegExp(`^${name}=(0x[0-9a-fA-F]{64})\\s*$`, "m"));
    if (match?.[1]) {
      keys[name] = match[1] as `0x${string}`;
      continue;
    }
    keys[name] = generatePrivateKey();
    const line = `${name}=${keys[name]}`;
    env = new RegExp(`^${name}=.*$`, "m").test(env)
      ? env.replace(new RegExp(`^${name}=.*$`, "m"), line)
      : `${env.trimEnd()}\n${line}\n`;
    changed = true;
  }
  if (changed) writeFileSync(envPath, env, { mode: 0o600 });
  process.env.POC_OWNER_PRIVATE_KEY = keys.POC_OWNER_PRIVATE_KEY;
  process.env.POC_AGENT_PRIVATE_KEY = keys.POC_AGENT_PRIVATE_KEY;
  return { owner: keys.POC_OWNER_PRIVATE_KEY, agent: keys.POC_AGENT_PRIVATE_KEY };
}

if (import.meta.main) {
  const { owner, agent } = ensureKeys();
  console.log(`Test keys in ${envPath} (throwaway, testnet only):`);
  console.log(`  owner EOA  ${privateKeyToAddress(owner)}`);
  console.log(`  agent EOA  ${privateKeyToAddress(agent)}`);
}
