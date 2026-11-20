/** Starts a local anvil fork of Base Sepolia if nothing is listening on `forkUrl` yet. */
import { type ChildProcess, spawn } from "node:child_process";
import { toHex } from "viem";

const BASE_SEPOLIA = 84532;

export async function rpcUp(url: string) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return ((await res.json()) as { result?: string }).result === toHex(BASE_SEPOLIA);
  } catch {
    return false;
  }
}

export async function ensureFork(forkUrl: string, upstream: string): Promise<ChildProcess | undefined> {
  if (await rpcUp(forkUrl)) return undefined;
  const port = new URL(forkUrl).port || "8545";
  const anvil = spawn("anvil", ["--fork-url", upstream, "--port", port, "--silent"], { stdio: "ignore" });
  anvil.on("error", () => {
    console.error("Could not start anvil. Install Foundry (https://getfoundry.sh).");
    process.exit(1);
  });
  process.on("exit", () => anvil.kill());
  for (let i = 0; i < 60; i++) {
    if (await rpcUp(forkUrl)) return anvil;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("anvil fork did not come up");
}
