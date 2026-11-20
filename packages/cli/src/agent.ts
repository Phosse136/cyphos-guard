/**
 * Agent key management for agent developers: create the agent's own key pair locally, store the private key in
 * a .env file (mode 600) and hand the OWNER only the address. The key never leaves this machine; cyphos-guard
 * (service and approver) never sees it. That split is what keeps cyphos-guard non-custodial.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

export const DEFAULT_VAR = "CYPHOS_AGENT_PRIVATE_KEY";
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export class AgentKeyExists extends Error {
  readonly variable: string;
  readonly address: Address;
  readonly envPath: string;
  constructor(variable: string, address: Address, envPath: string) {
    super(`${variable} is already set in ${envPath} (agent ${address}). Use --force to replace it.`);
    this.variable = variable;
    this.address = address;
    this.envPath = envPath;
  }
}

const lineRe = (v: string) => new RegExp(`^${v}=(.*)$`, "m");

/** The agent key stored under `variable` in `envPath`, or null. */
export function readAgentKey(envPath: string, variable = DEFAULT_VAR): Hex | null {
  if (!existsSync(envPath)) return null;
  const value = readFileSync(envPath, "utf8").match(lineRe(variable))?.[1]?.trim() ?? "";
  return KEY_RE.test(value) ? (value as Hex) : null;
}

export type NewAgentResult = {
  address: Address;
  envPath: string;
  variable: string;
  /** Address of the key that --force replaced (so its gas can still be recovered). */
  replaced?: Address;
  /** Set when envPath is inside a git repo but NOT git-ignored. */
  gitWarning?: string;
};

/** Creates a fresh agent key in `envPath` (created if missing, always chmod 600). Refuses to overwrite. */
export function newAgent({
  envPath,
  variable = DEFAULT_VAR,
  force = false,
}: {
  envPath: string;
  variable?: string;
  force?: boolean;
}): NewAgentResult {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(variable)) throw new Error(`invalid variable name: ${variable}`);
  const path = resolve(envPath);
  const existing = readAgentKey(path, variable);
  if (existing && !force) throw new AgentKeyExists(variable, privateKeyToAddress(existing), path);

  const key = generatePrivateKey();
  const env = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${variable}=${key}`;
  const next = lineRe(variable).test(env)
    ? env.replace(lineRe(variable), line)
    : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(path, next, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync's mode applies only to new files

  return {
    address: privateKeyToAddress(key),
    envPath: path,
    variable,
    ...(existing ? { replaced: privateKeyToAddress(existing) } : {}),
    ...gitCheck(path),
  };
}

/** Warns if the env file sits in a git work tree without being ignored (the key would end up in a commit). */
function gitCheck(path: string): { gitWarning?: string } {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dirname(path), ...args], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  try {
    if (git("rev-parse", "--is-inside-work-tree") !== "true") return {};
  } catch {
    return {}; // not a repo, or git not installed
  }
  try {
    git("check-ignore", "-q", path);
    return {};
  } catch {
    return { gitWarning: `${path} is inside a git repository but NOT git-ignored. Add it to .gitignore.` };
  }
}
