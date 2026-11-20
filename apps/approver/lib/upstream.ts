/**
 * Upstream targets, read at REQUEST time (not build time). Next.js bakes `rewrites()` destinations into the
 * build, so a build made for the fork would keep talking to the fork RPC in live mode. Route handlers avoid that.
 */
export const policyServiceUrl = () => process.env.POLICY_SERVICE_URL ?? "http://127.0.0.1:8787";

export const rpcUrl = () =>
  (process.env.NETWORK ?? "fork") === "fork"
    ? (process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545")
    : (process.env.RPC_URL ?? "https://sepolia.base.org");
