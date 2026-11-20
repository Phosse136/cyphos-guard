import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { PaymentPayloadV2Schema } from "@x402/core/schemas";
import { type Address, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  decodeX402Header,
  encodeX402Header,
  type PaymentRequired,
  type PaymentRequirements,
  selectRequirement,
  signExactEip3009,
} from "./x402.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const SELLER = privateKeyToAddress(generatePrivateKey());
const OTHER = privateKeyToAddress(generatePrivateKey());
const req = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: USDC,
  payTo: SELLER,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
  ...over,
});
const required = (accepts: PaymentRequirements[]): PaymentRequired => ({
  x402Version: 2,
  resource: { url: "https://api.example/data" },
  accepts,
});

describe("x402 client", () => {
  it("decodes a PAYMENT-REQUIRED header made by the reference implementation", () => {
    const header = encodePaymentRequiredHeader(required([req()]) as never);
    expect(decodeX402Header<PaymentRequired>(header).accepts[0]?.payTo).toBe(SELLER);
  });

  it("picks exact/EIP-3009 on this chain in a granted token, preferring allowed sellers", () => {
    const ctx = { chainId: 84532, tokens: [USDC], sellers: [SELLER] };
    const pick = (accepts: PaymentRequirements[]) => selectRequirement(required(accepts), ctx);
    expect(pick([req({ payTo: OTHER }), req()])?.payTo).toBe(SELLER);
    expect(pick([req({ payTo: OTHER })])?.payTo).toBe(OTHER); // payable, but will escalate
    expect(pick([req({ network: "eip155:8453" })])).toBeNull(); // mainnet: never
    expect(pick([req({ scheme: "upto" })])).toBeNull();
    expect(pick([req({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } })])).toBeNull();
    expect(pick([req({ asset: OTHER })])).toBeNull(); // token not granted
    expect(pick([req({ extra: {} })])).toBeNull(); // no EIP-712 domain
    expect(pick([req({ amount: "0" })])).toBeNull();
    expect(selectRequirement({ ...required([req()]), x402Version: 1 }, ctx)).toBeNull();
  });

  it("signs a TransferWithAuthorization the reference schema accepts and that verifies for the agent", async () => {
    const agent = privateKeyToAccount(generatePrivateKey());
    const r = req();
    const payload = await signExactEip3009(agent, r, 84532);
    const header = encodeX402Header({
      x402Version: 2,
      resource: { url: "https://api.example/data" },
      accepted: r,
      payload,
    });
    const decoded = decodePaymentSignatureHeader(header);
    expect(PaymentPayloadV2Schema.safeParse(decoded).success).toBe(true);
    const a = payload.authorization;
    expect(a).toMatchObject({ from: agent.address, to: SELLER, value: "10000", validAfter: "0" });
    expect(
      await verifyTypedData({
        address: agent.address,
        domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: { ...a, value: 10000n, validAfter: 0n, validBefore: BigInt(a.validBefore) },
        signature: payload.signature,
      }),
    ).toBe(true);
  });
});
