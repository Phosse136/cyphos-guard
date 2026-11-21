import { encodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";
import { createNotifier, describeEvent, notifierFromEnv } from "./notify.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SHOP = "0x2222222222222222222222222222222222222222";
const AGENT = "0x1111111111111111111111111111111111111111";
const usdcPay = (amount: bigint) => ({
  to: USDC,
  value: "0",
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [SHOP, amount] }),
});

function fakeFetch(status = 200) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), headers: (init.headers ?? {}) as Record<string, string> });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("operator notifications", () => {
  it("describes payments, approvals and blocks in one readable line", () => {
    expect(
      describeEvent({ kind: "routine_executed", agent: AGENT, detail: { ...usdcPay(1_200_000n), reason: "API usage" } })
        .text,
    ).toBe("💸 Agent 0x1111…1111 paid within limits: 1.2 USDC → 0x2222…2222 (“API usage”)");
    const ask = describeEvent({ kind: "request_created", agent: AGENT, detail: usdcPay(4_000_000n) });
    expect(ask.urgent).toBe(true);
    expect(ask.text).toMatch(/asks for approval: 4 USDC/);
    expect(
      describeEvent({
        kind: "request_denied",
        agent: AGENT,
        detail: { code: "forbidden", to: SHOP, value: "300000000000000" },
      }).text,
    ).toMatch(/blocked \(forbidden\): 0.0003 ETH/);
  });

  it("sends to Telegram, Discord and ntfy; urgent events link to the app; Discord can't be made to @everyone", async () => {
    const { f, calls } = fakeFetch();
    const n = createNotifier({
      telegram: { botToken: "T0KEN", chatId: "42" },
      discord: { webhookUrl: "https://discord.example/hook" },
      ntfy: { url: "https://ntfy.example/topic" },
      events: "all",
      appUrl: "https://app.example",
      fetch: f,
    });
    await n.notify({
      kind: "request_created",
      agent: AGENT,
      detail: { ...usdcPay(4_000_000n), reason: "@everyone pay me" },
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.telegram.org/botT0KEN/sendMessage",
      "https://discord.example/hook",
      "https://ntfy.example/topic",
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ chat_id: "42" });
    expect(calls[0]?.body).toMatch(/Open https:\/\/app.example to approve/);
    expect(JSON.parse(calls[1]?.body ?? "{}").allowed_mentions).toEqual({ parse: [] });
    expect(calls[2]?.headers).toMatchObject({ Priority: "high", Click: "https://app.example" });
  });

  it("filters by event kind, caps floods per minute and reports what it held back", async () => {
    let t = 0;
    const { f, calls } = fakeFetch();
    const n = createNotifier({
      discord: { webhookUrl: "https://d/x" },
      events: new Set(["routine_executed"]),
      maxPerMinute: 2,
      fetch: f,
      now: () => t,
    });
    await n.notify({ kind: "grant_created", agent: AGENT }); // filtered out
    for (let i = 0; i < 5; i++) await n.notify({ kind: "routine_executed", agent: AGENT, detail: usdcPay(1n) });
    expect(calls).toHaveLength(2);
    t += 61_000;
    await n.notify({ kind: "routine_executed", agent: AGENT, detail: usdcPay(1n) });
    expect(calls.map((c) => JSON.parse(c.body).content).join("\n")).toMatch(/and 3 more event/);
  });

  it("never throws when a channel fails, and the summary counts every event", async () => {
    const { f } = fakeFetch(500);
    const logs: string[] = [];
    const n = createNotifier({
      telegram: { botToken: "x", chatId: "1" },
      events: "all",
      fetch: f,
      log: (m) => logs.push(m),
    });
    await expect(n.notify({ kind: "grant_created", agent: AGENT })).resolves.toBeDefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(logs[0]).toMatch(/notification failed: HTTP 500/);
    const ok = fakeFetch();
    const m = createNotifier({ discord: { webhookUrl: "https://d/x" }, events: new Set(), fetch: ok.f });
    await m.notify({ kind: "routine_executed" });
    await m.notify({ kind: "routine_executed" });
    await m.summary();
    expect(JSON.parse(ok.calls[0]?.body ?? "{}").content).toMatch(/2× Payment/);
    // counts from the database win (restart-proof); zero kinds are left out
    await m.summary({ owner_tx: 1, owner_registered: 2, x402_paid: 0 });
    const text = JSON.parse(ok.calls[1]?.body ?? "{}").content as string;
    expect(text).toMatch(/1× Owner transaction/);
    expect(text).toMatch(/2× New owner/);
    expect(text).not.toMatch(/x402/);
  });

  it("is off unless a channel is configured", () => {
    expect(notifierFromEnv({})).toBeNull();
    expect(notifierFromEnv({ TELEGRAM_BOT_TOKEN: "x" })).toBeNull(); // needs the chat id too
    expect(notifierFromEnv({ NTFY_URL: "https://ntfy.sh/topic" })?.enabled).toBe(true);
  });
});
