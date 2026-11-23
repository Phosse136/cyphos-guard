/**
 * `pnpm contracts:deploy`: deploys cyphos-guard's caveat enforcers (CosignerEnforcer, ERC20PerTransferCapEnforcer)
 * to live Base Sepolia (once per chain) through the standard CREATE2 deployer, paid by the PoC owner key from .env.
 * The addresses are deterministic, so anyone can deploy them and everyone gets the same contracts. Nobody owns or
 * controls them.
 */
import {
  cosignerEnforcerAddress,
  deployCosignerEnforcer,
  deployPerTransferCapEnforcer,
  perTransferCapEnforcerAddress,
} from "@cyphos-guard/sdk";
import { type Chain, createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const key = process.env.POC_OWNER_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error("POC_OWNER_PRIVATE_KEY missing in .env (run `pnpm poc:keys`)");
const rpc = process.env.RPC_URL || "https://sepolia.base.org";
const chain: Chain = baseSepolia;
const client: PublicClient = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpc) });

for (const [name, address, deploy] of [
  ["CosignerEnforcer", cosignerEnforcerAddress, deployCosignerEnforcer],
  ["ERC20PerTransferCapEnforcer", perTransferCapEnforcerAddress, deployPerTransferCapEnforcer],
] as const) {
  const hash = await deploy(wallet, client);
  console.log(
    hash
      ? `${name} deployed at ${address}\n  tx https://sepolia.basescan.org/tx/${hash}`
      : `${name} already deployed at ${address}`,
  );
}
