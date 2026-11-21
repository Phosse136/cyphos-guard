/**
 * Operator notifications: a message to Telegram / Discord / ntfy when something happens on this instance (new
 * owner, grants, approvals waiting, payments, blocks), plus an optional daily summary. Off unless configured.
 *
 * Never on the request path: sends are fire-and-forget with a timeout, failures are only logged, and a per-minute
 * cap stops floods (extra events are folded into a "+N more" line).
 */

import { decodeErc20Transfer } from "@cyphos-guard/shared";
import { formatEther, formatUnits, type Hex, isAddressEqual } from "viem";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export type NotifyEvent = {
  kind: string;
  account?: string | null;
  agent?: string | null;
  detail?: Record<string, unknown>;
  txHash?: string | null;
};

export type NotifierConfig = {
  telegram?: { botToken: string; chatId: string };
  discord?: { webhookUrl: string };
  ntfy?: { url: string; token?: string };
  /** Event kinds to send ("all" = everything). */
  events: Set<string> | "all";
  /** Link to the approver, appended to messages that need the owner. */
  appUrl?: string;
  /** Basescan links for transactions. */
  explorerTxUrl?: (hash: string) => string;
  maxPerMinute?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
};

const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");

/** One line per event, e.g. "💸 Agent 0x1234…abcd paid 1.2 USDC → 0x9876…dcba". */
export function describeEvent(e: NotifyEvent): { title: string; text: string; urgent: boolean } {
  const d = e.detail ?? {};
  const amount = () => {
    const to = d.to as string | undefined;
    const data = d.data as Hex | undefined;
    const t = data ? decodeErc20Transfer(data) : null;
    if (t && to) {
      const unit = isAddressEqual(to as Hex, USDC) ? "USDC" : `token ${short(to)}`;
      return `${formatUnits(t.amount, 6)} ${unit} → ${short(t.recipient)}`;
    }
    if (d.value !== undefined && to) return `${formatEther(BigInt(String(d.value)))} ETH → ${short(to)}`;
    return "";
  };
  const why = typeof d.reason === "string" && d.reason ? ` (“${d.reason.slice(0, 80)}”)` : "";
  const agent = `Agent ${short(e.agent)}`;
  switch (e.kind) {
    case "owner_registered":
      return { title: "New owner", text: "🆕 A new owner registered a passkey on this instance.", urgent: false };
    case "grant_created":
      return { title: "Agent granted", text: `🔑 ${agent} was granted permissions.`, urgent: false };
    case "grant_revoked":
      return { title: "Agent revoked", text: `⛔ ${agent} was revoked.`, urgent: false };
    case "request_created":
      return { title: "Approval needed", text: `🙋 ${agent} asks for approval: ${amount()}${why}`, urgent: true };
    case "request_approved":
      return { title: "Approved", text: `✅ Approved: ${agent}`, urgent: false };
    case "request_rejected":
      return { title: "Rejected", text: `❌ Rejected: ${agent}`, urgent: false };
    case "request_executed":
      return { title: "Approved payment sent", text: `💸 ${agent} paid (approved): ${amount()}`, urgent: false };
    case "routine_executed":
      return { title: "Payment", text: `💸 ${agent} paid within limits: ${amount()}${why}`, urgent: false };
    case "request_denied":
      return {
        title: "Blocked",
        text: `🛑 ${agent} was blocked (${String(d.code ?? "policy")}): ${amount()}${why}`,
        urgent: false,
      };
    case "x402_paid":
      return {
        title: "x402 API paid",
        text: `🌐 ${agent} paid an API: ${amount()}${typeof d.resource === "string" ? ` for ${d.resource.slice(0, 80)}` : ""}`,
        urgent: false,
      };
    case "owner_tx": {
      const lines = Array.isArray(d.summary) ? (d.summary as unknown[]).map(String).slice(0, 10) : [];
      return {
        title: "Owner transaction",
        text: `👤 Owner ${short(e.account)} (passkey): ${lines.length ? lines.join("; ") : "transaction"}`,
        urgent: false,
      };
    }
    default:
      return { title: e.kind, text: `ℹ️ ${e.kind}`, urgent: false };
  }
}

export function createNotifier(cfg: NotifierConfig) {
  const doFetch = cfg.fetch ?? fetch;
  const now = cfg.now ?? Date.now;
  const log = cfg.log ?? ((m: string) => console.warn(m));
  const maxPerMinute = cfg.maxPerMinute ?? 20;
  const channels = [cfg.telegram, cfg.discord, cfg.ntfy].filter(Boolean).length;
  let windowStart = now();
  let sentInWindow = 0;
  let suppressed = 0;
  const counts = new Map<string, number>();

  const post = async (url: string, init: RequestInit) => {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };
  const send = (title: string, text: string, urgent: boolean) => {
    const tasks: Promise<void>[] = [];
    if (cfg.telegram) {
      tasks.push(
        post(`https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.telegram.chatId, text, disable_web_page_preview: true }),
        }),
      );
    }
    if (cfg.discord) {
      tasks.push(
        post(cfg.discord.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // allowed_mentions: none, so an agent's reason text can never ping @everyone.
          body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
        }),
      );
    }
    if (cfg.ntfy) {
      const headers: Record<string, string> = { Title: title, Priority: urgent ? "high" : "default" };
      if (cfg.appUrl) headers.Click = cfg.appUrl;
      if (cfg.ntfy.token) headers.Authorization = `Bearer ${cfg.ntfy.token}`;
      tasks.push(post(cfg.ntfy.url, { method: "POST", headers, body: text }));
    }
    for (const t of tasks) t.catch((e) => log(`notification failed: ${(e as Error).message}`));
    return Promise.allSettled(tasks);
  };

  return {
    enabled: channels > 0,
    /** Fire-and-forget; resolves when the sends settled (for tests). Never throws. */
    notify(e: NotifyEvent): Promise<unknown> {
      counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
      if (!channels || (cfg.events !== "all" && !cfg.events.has(e.kind))) return Promise.resolve();
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        sentInWindow = 0;
        if (suppressed > 0) {
          const n = suppressed;
          suppressed = 0;
          sentInWindow++;
          void send("Notifications", `… and ${n} more event(s) in the last minute (rate-limited).`, false);
        }
      }
      if (sentInWindow >= maxPerMinute) {
        suppressed++;
        return Promise.resolve();
      }
      sentInWindow++;
      const { title, text, urgent } = describeEvent(e);
      const link =
        urgent && cfg.appUrl
          ? `\nOpen ${cfg.appUrl} to approve or reject.`
          : e.txHash && cfg.explorerTxUrl
            ? `\n${cfg.explorerTxUrl(e.txHash)}`
            : "";
      return send(title, text + link, urgent);
    },
    /**
     * Sends "last 24 h: …". Pass `fromStore` (counts read from the database) so restarts don't lose events;
     * without it, the in-memory counts since the last summary are used. Resets the in-memory counts.
     */
    summary(fromStore?: Record<string, number>): Promise<unknown> {
      const source = fromStore ? Object.entries(fromStore) : [...counts.entries()];
      const parts = source.filter(([, n]) => n > 0).map(([k, n]) => `${n}× ${describeEvent({ kind: k }).title}`);
      counts.clear();
      if (!channels) return Promise.resolve();
      return send(
        "Daily summary",
        `📊 cyphos-guard, last 24 h: ${parts.length ? parts.join(", ") : "no activity"}`,
        false,
      );
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;

/** Reads notifier settings from the environment; null if no channel is configured. */
export function notifierFromEnv(env: NodeJS.ProcessEnv, appUrl?: string): Notifier | null {
  const telegram =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
      : undefined;
  const discord = env.DISCORD_WEBHOOK_URL ? { webhookUrl: env.DISCORD_WEBHOOK_URL } : undefined;
  const ntfy = env.NTFY_URL ? { url: env.NTFY_URL, ...(env.NTFY_TOKEN ? { token: env.NTFY_TOKEN } : {}) } : undefined;
  if (!telegram && !discord && !ntfy) return null;
  const list = (env.NOTIFY_EVENTS ?? "all").trim();
  return createNotifier({
    ...(telegram ? { telegram } : {}),
    ...(discord ? { discord } : {}),
    ...(ntfy ? { ntfy } : {}),
    events: list === "all" ? "all" : new Set(list.split(/[\s,]+/).filter(Boolean)),
    ...(appUrl ? { appUrl } : {}),
    explorerTxUrl: (h) => `https://sepolia.basescan.org/tx/${h}`,
  });
}
