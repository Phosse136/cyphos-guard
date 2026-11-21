// Same-origin proxy to the policy service so the HttpOnly session cookie stays first-party.
// Target chosen at request time (see lib/upstream.ts).
import { AGENT_HEADERS } from "@cyphos-guard/shared";
import { policyServiceUrl } from "@/lib/upstream";

export const dynamic = "force-dynamic";

async function proxy(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(request.url);
  const target = `${policyServiceUrl()}/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const headers = new Headers();
  // Agents reach the service through this proxy on a public deployment, so their signed-request headers must
  // pass (the signature covers the service-relative path, which is what the proxy forwards to).
  // x-forwarded-for: the client IP as set by Caddy, for the service's per-IP rate limits.
  for (const name of ["content-type", "cookie", "x-forwarded-for", ...Object.values(AGENT_HEADERS)]) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    redirect: "manual",
  });
  const out = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json" });
  for (const c of res.headers.getSetCookie()) out.append("set-cookie", c);
  const retryAfter = res.headers.get("retry-after"); // rate limits: tell clients how long to back off
  if (retryAfter) out.set("retry-after", retryAfter);
  return new Response(await res.text(), { status: res.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
