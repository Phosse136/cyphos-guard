// Same-origin JSON-RPC proxy for the browser (no CORS against the node); target chosen at request time.
// Public deployments: read-only methods only, size-capped and rate-limited per client IP.
import { clientIp, createRateLimiter } from "@cyphos-guard/shared";
import { rpcRejection } from "@/lib/rpcGuard";
import { rpcUrl } from "@/lib/upstream";

export const dynamic = "force-dynamic";

const limiter = createRateLimiter();
const PER_IP = { max: Number(process.env.RPC_RATE_LIMIT_PER_MIN ?? 600), windowSeconds: 60 };

const error = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }, { status, headers });

export async function POST(request: Request) {
  const rate = limiter.take(clientIp(request.headers.get("x-forwarded-for")), PER_IP);
  if (!rate.ok) return error(429, "too many requests", { "retry-after": String(rate.retryAfterSeconds) });
  const body = await request.text();
  const rejection = rpcRejection(body);
  if (rejection) return error(400, rejection);
  const res = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
