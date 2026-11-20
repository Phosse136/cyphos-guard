/**
 * Live demo seller: a paywalled API on Base Sepolia, settled by the public x402 testnet facilitator.
 *   pnpm --filter @cyphos-guard/x402-seller start      (PORT=4021, X402_PAY_TO=<address> optional)
 * The default payTo is a demo address derived from a public label: anyone can recompute its key, so the test
 * USDC it receives is effectively burned. Testnet only.
 */
import { serve } from "@hono/node-server";
import { type Address, keccak256, parseUnits, toHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { createSellerApp, httpFacilitator, PUBLIC_TESTNET_FACILITATOR } from "./seller.ts";

export const DEMO_SELLER: Address = privateKeyToAddress(keccak256(toHex("cyphos-guard-demo:x402-api")));
const payTo = (process.env.X402_PAY_TO as Address | undefined) ?? DEMO_SELLER;
const port = Number(process.env.PORT ?? 4021);

const app = await createSellerApp({
  payTo,
  facilitator: httpFacilitator(process.env.X402_FACILITATOR_URL ?? PUBLIC_TESTNET_FACILITATOR),
  products: [
    {
      path: "/market-data",
      description: "Market data snapshot",
      amount: parseUnits("0.5", 6),
      body: { pair: "ETH/USDC", price: 3120.55, source: "demo" },
    },
    {
      path: "/deep-report",
      description: "Deep research report",
      amount: parseUnits("3", 6),
      body: { title: "Weekly AI infra market report", pages: 12, source: "demo" },
    },
  ],
});
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () =>
  console.log(`x402 demo seller on http://127.0.0.1:${port}  payTo ${payTo}  (Base Sepolia, x402.org facilitator)`),
);
