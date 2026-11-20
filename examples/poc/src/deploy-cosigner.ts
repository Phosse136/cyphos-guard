/**
 * `pnpm contracts:deploy`: deploys the CosignerEnforcer to live Base Sepolia (once per chain) through the
 * standard CREATE2 deployer, paid by the PoC owner key from .env. The address is deterministic, so anyone can
 * deploy it and everyone gets the same contract. Nobody owns or controls it.
 */
import { cosignerEnforcerAddress, deployCosignerEnforcer } from "@cyphos-guard/sdk";
import { type Chain, createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const key = process.env.POC_OWNER_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error("POC_OWNER_PRIVATE_KEY missing in .env (run `pnpm poc:keys`)");
const rpc = process.env.RPC_URL || "https://sepolia.base.org";
const chain: Chain = baseSepolia;
const client: PublicClient = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpc) });
const hash = await deployCosignerEnforcer(wallet, client);
console.log(
  hash
    ? `CosignerEnforcer deployed at ${cosignerEnforcerAddress}\n  tx https://sepolia.basescan.org/tx/${hash}`
    : `CosignerEnforcer already deployed at ${cosignerEnforcerAddress}`,
);
