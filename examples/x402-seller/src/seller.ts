/**
 * A tiny x402 seller (paywalled HTTP API) built on the OFFICIAL x402 server logic (@x402/core
 * x402ResourceServer + @x402/evm exact scheme). Used to prove cyphos-guard's x402 client against the
 * reference implementation, on a fork (local facilitator) and live (public testnet facilitator).
 */

import { x402Facilitator } from "@x402/core/facilitator";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { type FacilitatorClient, HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { Hono } from "hono";
import { type Address, type Chain, createWalletClient, http, type LocalAccount, publicActions } from "viem";
import { baseSepolia } from "viem/chains";

export const NETWORK = "eip155:84532" as const;
export const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** Public x402 testnet facilitator (Base Sepolia). */
export const PUBLIC_TESTNET_FACILITATOR = "https://x402.org/facilitator";

/** The public testnet facilitator over HTTP. */
export const httpFacilitator = (url = PUBLIC_TESTNET_FACILITATOR): FacilitatorClient =>
  new HTTPFacilitatorClient({ url });

/** An in-process facilitator that settles with `key` against `rpcUrl` (e.g. a local fork). */
export function localFacilitator(account: LocalAccount, rpcUrl: string, chain: Chain = baseSepolia): FacilitatorClient {
  const client = createWalletClient({ account, chain, transport: http(rpcUrl) }).extend(publicActions);
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (a: never) => client.readContract(a),
    verifyTypedData: (a: never) => client.verifyTypedData(a),
    writeContract: (a: never) => client.writeContract(a),
    sendTransaction: (a: never) => client.sendTransaction(a),
    waitForTransactionReceipt: (a: never) => client.waitForTransactionReceipt(a),
    getCode: (a: never) => client.getCode(a),
  } as never);
  const facilitator = new x402Facilitator().register(NETWORK, new ExactEvmFacilitatorScheme(signer));
  return {
    verify: (p, r) => facilitator.verify(p, r),
    settle: (p, r) => facilitator.settle(p, r),
    getSupported: async () => facilitator.getSupported() as never,
  };
}

export type Product = { path: string; description: string; amount: bigint; body: unknown };

/** Hono app: each product's path answers 402 until paid in USDC to `payTo`, then returns its body. */
export async function createSellerApp({
  payTo,
  facilitator,
  products,
}: {
  payTo: Address;
  facilitator: FacilitatorClient;
  products: Product[];
}) {
  const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmServerScheme());
  await server.initialize();
  const app = new Hono();
  for (const product of products) {
    app.get(product.path, async (c) => {
      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo,
        network: NETWORK,
        price: { asset: USDC, amount: product.amount.toString(), extra: { name: "USDC", version: "2" } },
        maxTimeoutSeconds: 120,
      });
      const resource = { url: c.req.url, description: product.description, mimeType: "application/json" };
      const unpaid = async (error?: string) => {
        const required = await server.createPaymentRequiredResponse(requirements, resource, error);
        return c.json({ error: error ?? "payment required" }, 402, {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required),
        });
      };
      const header = c.req.header("PAYMENT-SIGNATURE");
      if (!header) return unpaid();
      const payload = decodePaymentSignatureHeader(header);
      const match = server.findMatchingRequirements(requirements, payload);
      if (!match) return unpaid("payment does not match the requirements");
      const verified = await server.verifyPayment(payload, match);
      if (!verified.isValid) return unpaid(verified.invalidReason ?? "invalid payment");
      const settled = await server.settlePayment(payload, match);
      const headers = { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) };
      if (!settled.success) return c.json({ error: settled.errorReason ?? "settlement failed" }, 402, headers);
      return c.json(product.body as never, 200, headers);
    });
  }
  return app;
}
