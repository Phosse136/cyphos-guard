/**
 * `pnpm demo:setup`: prepares the interactive demo (run `pnpm dev` first, create your passkey account in
 * the approver). Generates the agent's throwaway key into .env, funds its gas on the fork, and prints a link
 * that prefills the approver's grant form with the demo policy.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Chain, createPublicClient, formatEther, http, type PublicClient, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { VENDORS } from "./scenario.ts";

const KEY = "DEMO_AGENT_PRIVATE_KEY";
const root = resolve(import.meta.dirname, "../../..");
const envPath = resolve(root, ".env");

/** Reads or creates the demo agent key in .env (never printed). */
export function ensureAgentKey(): `0x${string}` {
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(resolve(root, ".env.example"), "utf8");
  const found = env.match(new RegExp(`^${KEY}=(0x[0-9a-fA-F]{64})\\s*$`, "m"))?.[1];
  if (found) return found as `0x${string}`;
  const key = generatePrivateKey();
  const line = `${KEY}=${key}`;
  const next = new RegExp(`^${KEY}=.*$`, "m").test(env)
    ? env.replace(new RegExp(`^${KEY}=.*$`, "m"), line)
    : `${env.trimEnd()}\n${line}\n`;
  writeFileSync(envPath, next, { mode: 0o600 });
  return key;
}

/** Grant-form values for the demo policy (same limits as scenario.ts demoPolicy). */
export function demoPrefill(agent: string) {
  return {
    agent,
    usdcRecipient: VENDORS.inferenceApi,
    usdcDaily: "5",
    usdcPerTx: "2",
    ethRecipient: VENDORS.gpuMarket,
    ethDaily: "0.001",
    hardMaxEth: "0.01",
    hardMaxUsdc: "20",
    days: "7",
    forbidden: VENDORS.dataHarvest,
  };
}

/** Approver link that prefills the grant form (honoured on a local fork only). */
export function prefillLink(agent: string, origin = "http://localhost:3000") {
  return `${origin}/?grant=${Buffer.from(JSON.stringify(demoPrefill(agent))).toString("base64url")}`;
}

if (import.meta.main) {
  const network = process.env.NETWORK ?? "fork";
  const rpc =
    network === "fork"
      ? (process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545")
      : (process.env.RPC_URL ?? "https://sepolia.base.org");
  const chain: Chain = baseSepolia;
  const client: PublicClient = createPublicClient({ chain, transport: http(rpc) });
  const agent = privateKeyToAccount(ensureAgentKey());

  console.log(`Demo agent: ${agent.address}  (key in .env as ${KEY}, throwaway, testnet only)`);
  if (network === "fork") {
    try {
      await client.request({
        method: "anvil_setBalance" as never,
        params: [agent.address, toHex(parseEther("0.05"))] as never,
      });
      console.log("Funded the agent with 0.05 ETH for its own gas (fork).");
    } catch {
      console.error("Could not reach the local fork. Start everything first with `pnpm dev`.");
      process.exit(1);
    }
  } else {
    const bal = await client.getBalance({ address: agent.address });
    console.log(`Agent gas balance: ${formatEther(bal)} ETH. On Base Sepolia, send it ~0.002 test ETH from a faucet.`);
    console.log("Your smart account also needs ~10 test USDC (https://faucet.circle.com, Base Sepolia).");
  }

  const prefill = demoPrefill(agent.address);
  const link = prefillLink(agent.address);
  console.log(`
Next:
  1. In the approver (signed in, account created), open this link to prefill the grant form:
     ${network === "fork" ? link : "(prefill is fork-only; enter these values by hand:)"}
${network === "fork" ? "" : `     ${JSON.stringify(prefill, null, 2).replace(/\n/g, "\n     ")}\n`}  2. Check the values, click "Grant (sign with passkey)".
  3. Run the agent:  pnpm demo:agent
  4. When INV-1043 shows up under "Pending approvals", approve it with your passkey.`);
}
