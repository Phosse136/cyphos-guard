import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "./app.ts";
import { createChainAdapter } from "./chain.ts";
import { notifierFromEnv } from "./notify.ts";
import { openStore } from "./store.ts";

// The MetaMask Smart Accounts Kit sends usage analytics unless Do-Not-Track is set; cyphos-guard opts out.
process.env.DO_NOT_TRACK ??= "1";

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
// Optional operator notifications (Telegram / Discord / ntfy), see deploy/README.md.
const notifier = notifierFromEnv(process.env, origin.startsWith("https://") ? origin : undefined);
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
    ...(process.env.OPEN_REGISTRATION === "1"
      ? { openRegistration: { maxOwners: Number(process.env.MAX_OWNERS ?? 1000) } }
      : {}),
    // Per client IP / agent; generous for one owner and a few agents, tight enough to stop floods.
    ...(notifier ? { onEvent: (e: Parameters<typeof notifier.notify>[0]) => void notifier.notify(e) } : {}),
    rateLimit: {
      perIp: { max: Number(process.env.RATE_LIMIT_PER_IP_PER_MIN ?? 300), windowSeconds: 60 },
      auth: { max: Number(process.env.RATE_LIMIT_AUTH_PER_MIN ?? 20), windowSeconds: 60 },
      agent: { max: Number(process.env.RATE_LIMIT_AGENT_PER_MIN ?? 120), windowSeconds: 60 },
      maxBodyBytes: 256 * 1024,
    },
  },
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  const extras = [
    chain.isFork && "dev relay enabled",
    cosigner && `co-signer ${cosigner.address}`,
    notifier && "notifications on",
  ].filter(Boolean);
  if (process.env.OWNER_SETUP_CODE && store.owners.count() === 0) extras.push("owner setup code required");
  if (process.env.OPEN_REGISTRATION === "1")
    extras.push(`open registration (max ${process.env.MAX_OWNERS ?? 1000} owners)`);
  console.log(`policy-service on http://127.0.0.1:${port}  (${[network, ...extras].join(", ")})`);
});

// Daily summary at NOTIFY_SUMMARY_HOUR (server local time, 0-23), if notifications are on.
const summaryHour = process.env.NOTIFY_SUMMARY_HOUR;
if (notifier && summaryHour !== undefined && summaryHour !== "") {
  let lastDay = -1;
  setInterval(() => {
    const d = new Date();
    if (d.getHours() === Number(summaryHour) && d.getDate() !== lastDay) {
      lastDay = d.getDate();
      void notifier.summary();
    }
  }, 60_000).unref();
}
