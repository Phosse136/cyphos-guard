import type { NextConfig } from "next";

const policyService = process.env.POLICY_SERVICE_URL ?? "http://127.0.0.1:8787";
const rpc =
  (process.env.NETWORK ?? "fork") === "fork"
    ? (process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545")
    : (process.env.RPC_URL ?? "https://sepolia.base.org");

const config: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: ["@cyphos-guard/sdk", "@cyphos-guard/shared"],
  // Type checking runs via `pnpm typecheck` (tsc), not inside `next build`.
  typescript: { ignoreBuildErrors: true },
  // Same-origin proxying: the session cookie stays first-party and the browser never needs CORS.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${policyService}/:path*` },
      { source: "/rpc", destination: rpc },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" }, // no clickjacking of the approve button
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default config;
