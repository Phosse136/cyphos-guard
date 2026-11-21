import type { NextConfig } from "next";

// Content-Security-Policy is set per request with a fresh nonce in proxy.ts.

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
