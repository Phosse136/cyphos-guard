import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentKeyExists, newAgent, readAgentKey } from "./agent.ts";

const dir = () => mkdtempSync(join(tmpdir(), "cyphos-cli-"));

describe("agent new", () => {
  it("creates the env file with mode 600 and a key matching the returned address", () => {
    const envPath = join(dir(), ".env");
    const r = newAgent({ envPath });
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const key = readAgentKey(envPath);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(privateKeyToAddress(key as `0x${string}`)).toBe(r.address);
  });

  it("appends to an existing env file, keeps other lines and tightens its permissions", () => {
    const envPath = join(dir(), ".env");
    writeFileSync(envPath, "FOO=bar\nRPC_URL=x", { mode: 0o644 });
    newAgent({ envPath, variable: "DEMO_AGENT_PRIVATE_KEY" });
    const text = readFileSync(envPath, "utf8");
    expect(text).toMatch(/^FOO=bar\nRPC_URL=x\nDEMO_AGENT_PRIVATE_KEY=0x[0-9a-f]{64}\n$/);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("fills an empty placeholder line (as in .env.example) instead of adding a second one", () => {
    const envPath = join(dir(), ".env");
    writeFileSync(envPath, "CYPHOS_AGENT_PRIVATE_KEY=\nOTHER=1\n");
    newAgent({ envPath });
    expect(readFileSync(envPath, "utf8").match(/CYPHOS_AGENT_PRIVATE_KEY=/g)).toHaveLength(1);
    expect(readAgentKey(envPath)).not.toBeNull();
  });

  it("refuses to overwrite an existing key; --force replaces it and reports the old address", () => {
    const envPath = join(dir(), ".env");
    const first = newAgent({ envPath });
    expect(() => newAgent({ envPath })).toThrow(AgentKeyExists);
    expect(privateKeyToAddress(readAgentKey(envPath) as `0x${string}`)).toBe(first.address);
    const second = newAgent({ envPath, force: true });
    expect(second.replaced).toBe(first.address);
    expect(second.address).not.toBe(first.address);
  });

  it("warns when the env file is in a git repo but not ignored", () => {
    const d = dir();
    execFileSync("git", ["init", "-q", d]);
    expect(newAgent({ envPath: join(d, "agent.env") }).gitWarning).toMatch(/NOT git-ignored/);
    writeFileSync(join(d, ".gitignore"), "ignored.env\n");
    expect(newAgent({ envPath: join(d, "ignored.env") }).gitWarning).toBeUndefined();
  });

  it("rejects invalid variable names", () => {
    expect(() => newAgent({ envPath: join(dir(), ".env"), variable: "bad name" })).toThrow(/invalid/);
  });

  it("cli: never prints the private key", () => {
    const envPath = join(dir(), ".env");
    const out = execFileSync("node", [resolve(import.meta.dirname, "cli.ts"), "agent", "new", "--env", envPath], {
      encoding: "utf8",
    });
    const key = readAgentKey(envPath) as string;
    expect(out).toContain(privateKeyToAddress(key as `0x${string}`));
    expect(out).not.toContain(key.slice(2));
  });
});
