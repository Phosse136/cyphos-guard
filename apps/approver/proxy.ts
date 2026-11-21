/**
 * Nonce-based Content Security Policy (Next.js proxy). Every page response gets a fresh random nonce; only scripts
 * carrying it may run ('strict-dynamic' lets those load their own chunks). An injected inline script can't guess it.
 * Next.js reads the CSP from the request headers and stamps the nonce on its own scripts, which requires dynamic
 * rendering (see app/layout.tsx).
 *
 * Styles keep 'unsafe-inline': adding a nonce to style-src would make browsers ignore 'unsafe-inline' and break
 * inline style attributes, and styles can't run code.
 */
import { type NextRequest, NextResponse } from "next/server";

const bundlerOrigin = new URL(process.env.NEXT_PUBLIC_BUNDLER_URL ?? "https://public.pimlico.io/v2/84532/rpc").origin;

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${bundlerOrigin}${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the /api and /rpc proxies or static assets.
      source: "/((?!api|rpc|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
