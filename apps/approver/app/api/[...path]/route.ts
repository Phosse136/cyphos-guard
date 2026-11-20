// Same-origin proxy to the policy service so the HttpOnly session cookie stays first-party.
// Target chosen at request time (see lib/upstream.ts).
import { policyServiceUrl } from "@/lib/upstream";

export const dynamic = "force-dynamic";

async function proxy(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(request.url);
  const target = `${policyServiceUrl()}/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const headers = new Headers();
  for (const name of ["content-type", "cookie"]) {
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
  return new Response(await res.text(), { status: res.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
