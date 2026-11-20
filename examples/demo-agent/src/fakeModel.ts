/**
 * TEST DOUBLE for the Messages API, used only by `demo:selftest --fake-model` when no Claude credentials
 * are available. It replays a fixed sequence of tool calls, so the REAL Anthropic SDK tool runner, the real
 * tools and the real wallet stack are exercised end to end; only the model's decisions are scripted.
 * It also asserts that requests carry the model, tools, beta and fallback settings the agent is meant to send.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { INVOICES } from "./scenario.ts";

type Req = {
  model: string;
  /** The SDK's tool runner uses message threads: later requests carry only the new messages. */
  thread?: { type: "create" } | { type: "continue"; previous_message_id: string };
  tools?: { name: string }[];
  fallbacks?: unknown;
  messages: { role: string; content: string | { type: string; content?: unknown; text?: string }[] }[];
};

const toolUse = (calls: { name: string; input: Record<string, unknown> }[]) =>
  calls.map((c, i) => ({ type: "tool_use", id: `toolu_${Date.now()}_${i}`, name: c.name, input: c.input }));

const payCall = (id: string) => {
  const inv = INVOICES.find((x) => x.id === id);
  if (!inv) throw new Error(id);
  return {
    name: "pay",
    input: { invoice_id: inv.id, token: inv.token, to: inv.payTo, amount: inv.amount, memo: inv.description },
  };
};

export async function startFakeModel() {
  const problems: string[] = [];
  const turnOf = new Map<string, number>(); // response id → assistant turn index within its thread
  let seq = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const r = JSON.parse(body) as Req;
    const beta = String(req.headers["anthropic-beta"] ?? "");
    if (r.model !== "claude-opus-5-5") problems.push(`model was ${r.model}`);
    if (!beta.includes("server-side-fallback-2026-07-01")) problems.push("missing fallback beta header");
    if (r.fallbacks !== "default") problems.push("missing fallbacks: default");
    let turn: number;
    if (r.thread?.type === "continue") {
      const prev = turnOf.get(r.thread.previous_message_id);
      if (prev === undefined) problems.push(`unknown previous_message_id ${r.thread.previous_message_id}`);
      turn = (prev ?? 0) + 1;
    } else {
      // New thread (or no thread): tools are sent here; history may also be replayed in full.
      const names = (r.tools ?? [])
        .map((t) => t.name)
        .sort()
        .join(",");
      if (names !== "get_balances,list_invoices,pay,wait_for_approval") problems.push(`tools were ${names}`);
      turn = r.messages.filter((m) => m.role === "assistant").length;
    }
    const lastResults = JSON.stringify(r.messages.at(-1)?.content ?? "");
    let content: unknown[];
    let stop = "tool_use";
    switch (turn) {
      case 0:
        content = toolUse([
          { name: "list_invoices", input: {} },
          { name: "get_balances", input: {} },
        ]);
        break;
      case 1: // two payments in ONE turn: the runner executes them concurrently (exercises the nonce lock)
        content = toolUse([payCall("INV-1041"), payCall("INV-1042")]);
        break;
      case 2:
        content = toolUse([payCall("INV-1043")]);
        break;
      case 3: {
        const id = /request_id=([0-9a-f-]{36})/.exec(lastResults)?.[1];
        content = id
          ? toolUse([{ name: "wait_for_approval", input: { request_id: id, timeout_seconds: 60 } }])
          : toolUse([payCall("INV-1044")]);
        break;
      }
      case 4:
        content = toolUse([payCall("INV-1044")]);
        break;
      default:
        content = [{ type: "text", text: "(scripted test model) All invoices processed; see the outcomes above." }];
        stop = "end_turn";
    }
    const id = `msg_fake_${++seq}`;
    turnOf.set(id, turn);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        type: "message",
        role: "assistant",
        model: r.model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, problems, close: () => server.close() };
}
