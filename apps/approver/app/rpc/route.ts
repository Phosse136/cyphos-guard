// Same-origin JSON-RPC proxy for the browser (no CORS against the node); target chosen at request time.
import { rpcUrl } from "@/lib/upstream";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
