/**
 * Demo scenario: an accounts-payable agent pays its owner's AI-infrastructure invoices.
 *
 *   INV-1041  1.20 USDC  Inference API, monthly usage    → routine: within limits, paid alone
 *   INV-1042  0.0005 ETH GPU spot credits                → routine: within limits, paid alone
 *   INV-1043  4.00 USDC  Inference API, annual prepay    → big: above 2 USDC/payment → owner approves with passkey
 *   INV-1044  0.0003 ETH "DataHarvest" dataset access    → forbidden: vendor is on the owner's denylist
 *
 * The agent has no idea which vendor is denylisted: it tries to pay, and phoswallet blocks it.
 * Addresses are derived from fixed labels so invoices and the grant match across runs.
 */
import type { PolicyInput } from "@phoswallet/shared";
import { type Address, keccak256, parseEther, parseUnits, toHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

const demoAddress = (label: string): Address => privateKeyToAddress(keccak256(toHex(`phoswallet-demo:${label}`)));

export const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Circle test USDC, Base Sepolia
export const VENDORS = {
  inferenceApi: demoAddress("inference-api"),
  gpuMarket: demoAddress("gpu-market"),
  dataHarvest: demoAddress("data-harvest"),
} as const;

export type Invoice = {
  id: string;
  vendor: string;
  description: string;
  token: "USDC" | "ETH";
  amount: string;
  payTo: Address;
};

export const INVOICES: Invoice[] = [
  {
    id: "INV-1041",
    vendor: "Inference API Co.",
    description: "Inference API usage, November",
    token: "USDC",
    amount: "1.20",
    payTo: VENDORS.inferenceApi,
  },
  {
    id: "INV-1042",
    vendor: "GPU Spot Market",
    description: "GPU spot credits (2 h)",
    token: "ETH",
    amount: "0.0005",
    payTo: VENDORS.gpuMarket,
  },
  {
    id: "INV-1043",
    vendor: "Inference API Co.",
    description: "Annual plan prepayment (20% discount)",
    token: "USDC",
    amount: "4.00",
    payTo: VENDORS.inferenceApi,
  },
  {
    id: "INV-1044",
    vendor: "DataHarvest Ltd.",
    description: "Dataset access fee",
    token: "ETH",
    amount: "0.0003",
    payTo: VENDORS.dataHarvest,
  },
];

/** The grant the owner gives the agent (via the approver form, or programmatically in the self-test). */
export function demoPolicy(agent: Address, now: number, cosigner?: Address): PolicyInput {
  return {
    version: 1,
    chainId: 84532,
    agent,
    name: "accounts-payable agent",
    validFrom: now - 60,
    expiresAt: now + 7 * 86_400,
    permissions: [
      {
        kind: "erc20Transfer",
        token: USDC,
        recipients: [VENDORS.inferenceApi],
        perTx: parseUnits("2", 6),
        perPeriod: { amount: parseUnits("5", 6), periodSeconds: 86_400 },
      },
      {
        kind: "nativeTransfer",
        recipients: [VENDORS.gpuMarket],
        perPeriod: { amount: parseEther("0.001"), periodSeconds: 86_400 },
      },
    ],
    escalation: {
      enabled: true,
      approvalTtlSeconds: 900,
      hardMax: [
        { token: "native", amount: parseEther("0.01") },
        { token: USDC, amount: parseUnits("20", 6) },
      ],
    },
    forbidden: { targets: [VENDORS.dataHarvest] },
    ...(cosigner ? { cosigner } : {}),
  };
}
