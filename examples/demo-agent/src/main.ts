/**
 * `pnpm demo:agent`: runs the Claude accounts-payable agent against the running policy service
 * (`pnpm dev`) and your grant. You approve the big invoice in the approver app with your passkey.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createCyphosGuard, PolicyViolation } from "@cyphos-guard/sdk";
import { type Chain, createPublicClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { MODEL, runAgent } from "./agent.ts";
import { startFakeModel } from "./fakeModel.ts";
import { createPrinter } from "./print.ts";

// The MetaMask Smart Accounts Kit sends usage analytics unless Do-Not-Track is set; cyphos-guard opts out.
process.env.DO_NOT_TRACK ??= "1";

const key = process.env.DEMO_AGENT_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) {
  console.error("No demo agent key. Run `pnpm demo:setup` first.");
  process.exit(2);
}
// --fake-model: scripted TEST DOUBLE for the Messages API (used by the browser demo test); not Claude.
const fake = process.argv.includes("--fake-model");
if (!fake && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("No Claude credentials. Add ANTHROPIC_API_KEY to .env (see .env.example).");
  process.exit(2);
}

const live = (process.env.NETWORK ?? "fork") === "live";
const rpcUrl = live
  ? (process.env.RPC_URL ?? "https://sepolia.base.org")
  : (process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545");
const chain: Chain = baseSepolia;
const publicClient: PublicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const pw = createCyphosGuard({
  policyServiceUrl: process.env.POLICY_SERVICE_URL ?? `http://127.0.0.1:${process.env.POLICY_SERVICE_PORT ?? 8787}`,
  publicClient,
  agent: privateKeyToAccount(key),
});
const print = createPrinter({ live });

try {
  const account = await pw.getAccount();
  const who = fake ? "SCRIPTED test model (not Claude)" : `Claude (${MODEL})`;
  print.heading(`${who} as accounts-payable agent for ${account}: "Please pay the open invoices."`);
} catch (e) {
  if (e instanceof PolicyViolation) {
    console.error("This agent has no grant yet. Run `pnpm demo:setup` and grant it in the approver.");
    process.exit(2);
  }
  throw e;
}

const fakeModel = fake ? await startFakeModel() : null;
try {
  const client = fakeModel ? new Anthropic({ baseURL: fakeModel.url, apiKey: "test-double" }) : new Anthropic();
  await runAgent({ pw, publicClient, client, onText: print.text, onEvent: print.event });
  fakeModel?.close();
} catch (e) {
  if (e instanceof Anthropic.AuthenticationError)
    console.error("Claude API rejected the credentials (check ANTHROPIC_API_KEY).");
  else if (e instanceof Anthropic.RateLimitError) console.error("Claude API rate limit hit; try again in a minute.");
  else if (e instanceof Anthropic.APIError) console.error(`Claude API error ${e.status}: ${e.message}`);
  else throw e;
  process.exit(1);
}
