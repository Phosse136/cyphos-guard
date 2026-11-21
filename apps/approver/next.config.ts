import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";
const bundlerOrigin = new URL(process.env.NEXT_PUBLIC_BUNDLER_URL ?? "https://public.pimlico.io/v2/84532/rpc").origin;

/**
 * Content Security Policy. The browser may only talk to this origin (/api, /rpc) and the ERC-4337 bundler, so an
 * injected script couldn't send data anywhere else. Next.js hydration uses inline scripts, hence
 * 'unsafe-inline' for scripts (nonces would require dynamic rendering of every page). Dev adds eval + websockets
 * for hot reload.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${bundlerOrigin}${dev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: ["@cyphos-guard/sdk", "@cyphos-guard/shared"],
  // Type checking runs via `pnpm typecheck` (tsc), not inside `next build`.
  typescript: { ignoreBuildErrors: true },
  // /api and /rpc are proxied by route handlers (app/api, app/rpc) so targets are chosen at runtime, not baked
  // into the build like rewrites() destinations are.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" }, // no clickjacking of the approve button
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy", value: csp },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
          },
        ],
      },
    ];
  },
};

export default config;
