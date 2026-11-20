import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createChainAdapter } from "./chain.ts";
import { openStore } from "./store.ts";

const network = (process.env.NETWORK ?? "fork") as "fork" | "live";
const rpcUrl =
  network === "fork"
    ? (process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545")
    : (process.env.RPC_URL ?? "https://sepolia.base.org");
const port = Number(process.env.POLICY_SERVICE_PORT ?? 8787);
const origin = process.env.APPROVER_ORIGIN ?? "http://localhost:3000";

const chain = await createChainAdapter({ rpcUrl, network });
const store = openStore(process.env.POLICY_DB_PATH ?? "policy-service.sqlite");
const app = createApp({
  store,
  chain,
  config: {
    rpId: process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname,
    rpName: "phoswallet",
    origins: [origin],
    sessionTtlSeconds: 8 * 3600,
    secureCookies: origin.startsWith("https://"),
  },
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`policy-service on http://127.0.0.1:${port}  (${network}${chain.isFork ? ", dev relay enabled" : ""})`);
});
