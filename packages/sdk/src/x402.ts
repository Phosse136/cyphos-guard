/**
 * x402 client (protocol v2, HTTP transport, "exact" scheme with EIP-3009 tokens such as USDC).
 *
 * Wire format per the x402 v2 spec, cross-checked against the reference implementation (@x402/core,
 * @x402/evm 2.30): the server answers 402 with a base64-JSON `PAYMENT-REQUIRED` header; the client retries
 * with a base64-JSON `PAYMENT-SIGNATURE` header carrying a signed EIP-3009 TransferWithAuthorization; the
 * server's facilitator settles it and returns `PAYMENT-RESPONSE`.
 *
 * cyphos-guard pays as the AGENT (its own EOA signs the authorization): only the owner's passkey can sign
 * for the smart account. The money comes from the account just in time (see payX402 in cyphosGuard.ts).
 */
import { type Address, getAddress, type Hex, type LocalAccount, toHex } from "viem";

export const X402_HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
} as const;

export type PaymentRequirements = {
  scheme: string;
  /** CAIP-2, e.g. "eip155:84532". */
  network: string;
  /** Token base units, decimal string. */
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string; assetTransferMethod?: string; [k: string]: unknown };
};

export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource?: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};

export type SettlementResponse = {
  success: boolean;
  transaction?: Hex;
  network?: string;
  payer?: Address;
  errorReason?: string;
  [k: string]: unknown;
};

export class X402Error extends Error {
  override name = "X402Error";
}

/** UTF-8 JSON ↔ standard base64, as the reference implementation does. */
export const encodeX402Header = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
export function decodeX402Header<T>(header: string): T {
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
  } catch {
    throw new X402Error("malformed x402 header (expected base64 JSON)");
  }
}

const isUint = (s: unknown) => typeof s === "string" && /^\d+$/.test(s) && BigInt(s) > 0n;

/**
 * The payment option cyphos-guard can pay: exact / EIP-3009 on this chain, in one of `tokens`. Prefers an
 * option whose payTo is an allowed seller (pays without asking); otherwise the first payable one (escalates).
 */
export function selectRequirement(
  required: PaymentRequired,
  { chainId, tokens, sellers }: { chainId: number; tokens: Address[]; sellers: Address[] },
): PaymentRequirements | null {
  if (required.x402Version !== 2 || !Array.isArray(required.accepts)) return null;
  const lower = (a: string) => a.toLowerCase();
  const payable = required.accepts.filter(
    (r) =>
      r.scheme === "exact" &&
      r.network === `eip155:${chainId}` &&
      (r.extra?.assetTransferMethod ?? "eip3009") === "eip3009" &&
      typeof r.extra?.name === "string" &&
      typeof r.extra?.version === "string" &&
      isUint(r.amount) &&
      Number.isInteger(r.maxTimeoutSeconds) &&
      r.maxTimeoutSeconds > 0 &&
      tokens.some((t) => lower(t) === lower(r.asset)),
  );
  return payable.find((r) => sellers.some((s) => lower(s) === lower(r.payTo))) ?? payable[0] ?? null;
}

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The `payload` of an exact/EIP-3009 PaymentPayload, signed by `signer` (same fields as @x402/evm). */
export async function signExactEip3009(signer: LocalAccount, req: PaymentRequirements, chainId: number) {
  if (!req.extra?.name || !req.extra?.version)
    throw new X402Error("payment requirements lack the token's EIP-712 domain");
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: getAddress(signer.address),
    to: getAddress(req.payTo),
    value: req.amount,
    validAfter: "0",
    validBefore: String(now + req.maxTimeoutSeconds),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await signer.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: getAddress(req.asset) },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return { authorization, signature };
}
