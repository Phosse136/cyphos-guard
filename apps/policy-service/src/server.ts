import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
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

// Co-signer (ADR 0005): a key that can only BLOCK redemptions; it never has authority over funds.
let cosigner = process.env.COSIGNER_PRIVATE_KEY
  ? privateKeyToAccount(process.env.COSIGNER_PRIVATE_KEY as `0x${string}`)
  : undefined;
if (cosigner && !(await chain.ensureCosignerEnforcer())) {
  console.warn("CosignerEnforcer is not deployed on this chain; co-signing disabled (run `pnpm contracts:deploy`).");
  cosigner = undefined;
}
const store = openStore(process.env.POLICY_DB_PATH ?? "policy-service.sqlite");
const app = createApp({
  store,
  chain,
  config: {
    rpId: process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname,
    rpName: "cyphos-guard",
    origins: [origin],
    sessionTtlSeconds: 8 * 3600,
    secureCookies: origin.startsWith("https://"),
    ...(cosigner ? { cosigner } : {}),
    ...(process.env.OWNER_SETUP_CODE ? { setupCode: process.env.OWNER_SETUP_CODE } : {}),
  },
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  const extras = [chain.isFork && "dev relay enabled", cosigner && `co-signer ${cosigner.address}`].filter(Boolean);
  if (process.env.OWNER_SETUP_CODE && store.owners.count() === 0) extras.push("owner setup code required");
  console.log(`policy-service on http://127.0.0.1:${port}  (${[network, ...extras].join(", ")})`);
});
