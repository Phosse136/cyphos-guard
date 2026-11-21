/**
 * Live demo buyer: the agent pays the demo seller's x402 APIs through cyphos-guard.
 *   DEMO_AGENT_PRIVATE_KEY, POLICY_SERVICE_URL (e.g. https://app.cyphosguard.com/api), SELLER_URL (default local)
 * /market-data (0.5 USDC) should pay within limits; /deep-report (3 USDC) should ask the owner first.
 */
import { createCyphosGuard } from "@cyphos-guard/sdk";
import { type Chain, createPublicClient, formatUnits, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// The MetaMask Smart Accounts Kit sends usage analytics unless Do-Not-Track is set; cyphos-guard opts out.
process.env.DO_NOT_TRACK ??= "1";

const chain: Chain = baseSepolia;
const rpcUrl = process.env.RPC_URL ?? "https://sepolia.base.org";
const publicClient: PublicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const pw = createCyphosGuard({
  policyServiceUrl: process.env.POLICY_SERVICE_URL ?? "http://127.0.0.1:8787",
  publicClient,
  rpcUrl,
  agent: privateKeyToAccount(process.env.DEMO_AGENT_PRIVATE_KEY as `0x${string}`),
});
const seller = process.env.SELLER_URL ?? "http://127.0.0.1:4021";

for (const [path, reason] of [
  ["/market-data", "current ETH price for the invoice report"],
  ["/deep-report", "weekly market report for the owner"],
] as const) {
  console.log(`\n→ GET ${seller}${path}`);
  const r = await pw.payX402(`${seller}${path}`, {}, { reason, wait: { timeoutMs: 10 * 60_000 } });
  const how = r.topUp ? (r.topUp.via === "approval" ? "approved by the owner" : "within limits") : "agent balance";
  console.log(
    r.paid
      ? `  ✔ paid ${formatUnits(r.payment?.amount ?? 0n, 6)} USDC (${how})  https://sepolia.basescan.org/tx/${r.settlement?.transaction}`
      : `  ✘ not paid: HTTP ${r.response.status} ${r.settlement?.errorReason ?? ""}`,
  );
  console.log(`  response: ${await r.response.text()}`);
}
