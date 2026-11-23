/**
 * cyphos-guard canary (testnet only). See canary.ts and deploy/README.md.
 *
 *   node src/cli.ts init-keys --keys /etc/cyphos-guard/canary.keys     # once: two fresh TESTNET keys, mode 600
 *   node src/cli.ts setup --keys … --state /var/lib/cyphos-guard-canary/state.json
 *   node src/cli.ts run   --keys … --state … [--pay | --pay-every 86400] [--public …/stats/canary.json]
 *
 * --pay makes one real guarded payment (0.01 USDC, to the canary's own account); --pay-every N only when the last
 * one is at least N seconds ago (the hourly timer uses a day).
 *
 * Env: RPC_URL, BUNDLER_URL, CANARY_APP_URL (https://app.cyphosguard.com), CANARY_SITE_URL (https://cyphosguard.com),
 * and the operator notification settings of the policy service (TELEGRAM_*, DISCORD_WEBHOOK_URL, NTFY_*).
 * Exit code of run: 0 ok, 1 degraded, 2 breach (an attack went through).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { notifierFromEnv } from "@cyphos-guard/policy-service/notify";
import { createPublicClient, type Hex, http } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { type CanaryState, CHAIN, decideAlert, keysFrom, publicStatus, runCanary, setupCanary } from "./canary.ts";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    keys: { type: "string" },
    state: { type: "string" },
    public: { type: "string" },
    pay: { type: "boolean", default: false },
    "pay-every": { type: "string" },
  },
});
const die = (m: string, code = 2): never => {
  console.error(m);
  process.exit(code);
};

const writeAtomic = (path: string, content: string, mode = 0o644) => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
};
const json = (v: unknown) => `${JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2)}\n`;

function readKeys(path: string) {
  const env = Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("=", 2) as [string, string]),
  );
  const owner = env.CANARY_OWNER_KEY as Hex | undefined;
  const agent = env.CANARY_AGENT_KEY as Hex | undefined;
  if (!owner?.match(/^0x[0-9a-fA-F]{64}$/) || !agent?.match(/^0x[0-9a-fA-F]{64}$/))
    die(`${path}: needs CANARY_OWNER_KEY and CANARY_AGENT_KEY`);
  return keysFrom(owner as Hex, agent as Hex);
}

const rpcUrl = process.env.RPC_URL || "https://sepolia.base.org";
const client = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });

if (command === "init-keys") {
  const path = values.keys ?? die("--keys <file> required");
  if (existsSync(path)) die(`${path} exists; not overwriting`);
  writeFileSync(
    path,
    `# cyphos-guard canary: TESTNET (Base Sepolia) keys, generated ${new Date().toISOString()}. Never fund with real money.\nCANARY_OWNER_KEY=${generatePrivateKey()}\nCANARY_AGENT_KEY=${generatePrivateKey()}\n`,
    { mode: 0o600, flag: "wx" },
  );
  const k = readKeys(path);
  console.log(`wrote ${path}\nowner EOA: ${k.owner.address}\nagent:     ${k.agent.address}`);
} else if (command === "setup") {
  const keys = readKeys(values.keys ?? die("--keys <file> required"));
  const statePath = values.state ?? die("--state <file> required");
  const previous = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as CanaryState) : undefined;
  const r = await setupCanary({ client, rpcUrl, keys, ...(previous ? { previous } : {}) });
  if ("fund" in r) {
    console.log(
      `Send to the canary owner ${r.fund.address} on Base Sepolia:\n  ${r.fund.eth} ETH  (https://portal.cdp.coinbase.com/products/faucet)\n  ${r.fund.usdc} USDC (https://faucet.circle.com)\nthen run setup again.`,
    );
    process.exit(3);
  }
  writeAtomic(statePath, json({ ...r.state, last: previous?.last }));
  console.log(
    `canary ready: account ${r.state.account}, vault ${r.state.vault}, grant until ${new Date(r.state.expiresAt * 1000).toISOString()}`,
  );
} else if (command === "run") {
  const keys = readKeys(values.keys ?? die("--keys <file> required"));
  const statePath = values.state ?? die("--state <file> required");
  if (!existsSync(statePath)) die(`${statePath} missing: run setup first`);
  let state = JSON.parse(readFileSync(statePath, "utf8")) as CanaryState;
  // Renew the grant (max 90 days) a month before it ends; setup keeps it otherwise.
  if (state.expiresAt - Math.floor(Date.now() / 1000) < 30 * 86_400) {
    const r = await setupCanary({ client, rpcUrl, keys, previous: state });
    if ("state" in r) {
      state = { ...r.state, ...(state.last ? { last: state.last } : {}) };
      writeAtomic(statePath, json(state));
      console.log("grant renewed");
    } else console.log(`grant renewal needs funds: send ${r.fund.eth} ETH / ${r.fund.usdc} USDC to ${r.fund.address}`);
  }
  const app = (process.env.CANARY_APP_URL || "https://app.cyphosguard.com").replace(/\/$/, "");
  const site = (process.env.CANARY_SITE_URL || "https://cyphosguard.com").replace(/\/$/, "");
  const report = await runCanary({
    client,
    rpcUrl,
    keys,
    state,
    ...(process.env.BUNDLER_URL ? { bundlerUrl: process.env.BUNDLER_URL } : {}),
    pay:
      values.pay ||
      (values["pay-every"] !== undefined &&
        Math.floor(Date.now() / 1000) - (state.lastPayAt ?? 0) >= Number(values["pay-every"])),
    endpoints: {
      [`${site}/`]: "cyphos-guard",
      [`${site}/recover/`]: "cyphos-guard",
      [`${app}/`]: "cyphos-guard",
      [`${app}/api/health`]: (j) => {
        const h = j as { ok?: boolean; chainId?: number; fork?: boolean };
        return h.ok && h.chainId === 84532 && h.fork === false ? null : `unexpected health ${JSON.stringify(j)}`;
      },
      [`${app}/stats/stats.json`]: (j) => {
        const age = Math.floor(Date.now() / 1000) - Number((j as { generatedAt?: number }).generatedAt ?? 0);
        return age < 3 * 3600 ? null : `stats are ${Math.round(age / 60)} min old`;
      },
    },
  });

  const alert = decideAlert(state.last, report);
  const notifier = notifierFromEnv(process.env);
  if (alert.send && notifier) await notifier.message(alert.title, alert.text, alert.urgent);
  writeAtomic(
    statePath,
    json({
      ...state,
      last: { status: report.status, at: report.at, alertedAt: alert.send ? report.at : state.last?.alertedAt },
      ...(report.txHash && report.checks.every((c) => c.ok || !c.name.startsWith("real"))
        ? { lastPayAt: report.at }
        : {}),
    }),
  );
  if (values.public) writeAtomic(values.public, json(publicStatus(report, state)));

  for (const c of report.checks)
    console.log(`${c.ok ? "ok  " : c.level === "warn" ? "warn" : "FAIL"}  ${c.name}: ${c.detail}`);
  console.log(
    `status: ${report.status}${alert.send ? (notifier ? " (alert sent)" : " (alert due, no channel configured)") : ""}`,
  );
  process.exit(report.status === "ok" ? 0 : report.status === "degraded" ? 1 : 2);
} else {
  die("usage: canary init-keys|setup|run --keys <file> [--state <file>] [--pay] [--public <file>]");
}
