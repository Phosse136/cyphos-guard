#!/usr/bin/env node
/**
 * cyphos-guard CLI
 *
 *   cyphos-guard agent new   [--env .env] [--var CYPHOS_AGENT_PRIVATE_KEY] [--approver URL] [--force]
 *   cyphos-guard agent show  [--env .env] [--var CYPHOS_AGENT_PRIVATE_KEY] [--rpc URL]
 *
 * Testnet only (Base Sepolia). The private key is written to the env file and never printed.
 */
import { parseArgs } from "node:util";
import { createPublicClient, formatEther, http } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { AgentKeyExists, DEFAULT_VAR, newAgent, readAgentKey } from "./agent.ts";

// The MetaMask Smart Accounts Kit sends usage analytics unless Do-Not-Track is set; cyphos-guard opts out.
process.env.DO_NOT_TRACK ??= "1";

const USAGE = `Usage:
  cyphos-guard agent new   [--env .env] [--var ${DEFAULT_VAR}] [--approver URL] [--force]
  cyphos-guard agent show  [--env .env] [--var ${DEFAULT_VAR}] [--rpc URL]`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: "string", default: ".env" },
    var: { type: "string", default: DEFAULT_VAR },
    approver: { type: "string", default: "http://localhost:3000" },
    rpc: { type: "string", default: process.env.RPC_URL ?? "https://sepolia.base.org" },
    force: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
const [group, cmd] = positionals;
if (values.help || group !== "agent" || (cmd !== "new" && cmd !== "show")) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const gasOf = async (address: `0x${string}`) =>
  createPublicClient({ chain: baseSepolia, transport: http(values.rpc) })
    .getBalance({ address })
    .then(formatEther, () => "unknown (RPC unreachable)");

if (cmd === "new") {
  try {
    const r = newAgent({ envPath: values.env, variable: values.var, force: values.force });
    const approver = values.approver.replace(/\/$/, "");
    console.log(`New agent key created.

  Agent address  ${r.address}
  Private key    stored in ${r.envPath} as ${r.variable} (mode 600, not printed)
${r.replaced ? `  Replaced       ${r.replaced} (old key overwritten; move its leftover gas first if it had any)\n` : ""}${r.gitWarning ? `\n  WARNING: ${r.gitWarning}\n` : ""}
Next:
  1. Gas: send ~0.002 Base Sepolia test ETH to ${r.address}
     (it pays only transaction fees; it never holds the owner's funds).
  2. Give the OWNER only the address above. They open ${approver}, paste it into
     "Agent address", set the limits and grant with their passkey.
  3. Point your agent at the policy service:
       ${r.variable} (already in ${values.env})
       CYPHOS_POLICY_SERVICE_URL=${approver}/api   NETWORK=live
     Check anytime:  cyphos-guard agent show --env ${values.env}`);
  } catch (e) {
    if (e instanceof AgentKeyExists) {
      console.error(`${e.message}\nShow it with: cyphos-guard agent show --env ${values.env}`);
      process.exit(2);
    }
    throw e;
  }
} else {
  const key = readAgentKey(values.env, values.var);
  if (!key) {
    console.error(`No ${values.var} in ${values.env}. Create one with: cyphos-guard agent new --env ${values.env}`);
    process.exit(1);
  }
  const address = privateKeyToAddress(key);
  console.log(`Agent address  ${address}\nGas balance    ${await gasOf(address)} ETH (Base Sepolia)`);
}
