/** Test fixtures (fork only): an EIP-1193 wallet backed by a private key, and a recoverable Hybrid account. */
import { fundUsdc } from "@cyphos-guard/sdk/testing";
import { Implementation, toMetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import {
  type Address,
  type Chain,
  createWalletClient,
  type EIP1193Provider,
  type Hex,
  http,
  type PublicClient,
  parseAbi,
  parseEther,
  parseUnits,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { ENTRY_POINT_V07 } from "./recovery.ts";

const chain: Chain = baseSepolia;

export function testWallet(key: Hex, FORK: string): EIP1193Provider {
  const signer = privateKeyToAccount(key);
  const wallet = createWalletClient({ account: signer, chain, transport: http(FORK) });
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [signer.address];
      if (method === "wallet_switchEthereumChain") return null; // already on Base Sepolia (the fork)
      if (method === "eth_signTypedData_v4") {
        const typed = JSON.parse(String(params?.[1]));
        delete typed.types.EIP712Domain;
        return signer.signTypedData(typed);
      }
      if (method === "eth_sendTransaction") {
        const [tx] = params as [{ to: Address; data: Hex; value?: Hex; gas?: Hex }];
        return wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          ...(tx.value ? { value: BigInt(tx.value) } : {}),
          ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
        });
      }
      const res = await fetch(FORK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
      });
      const json = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (json.error) throw new Error(json.error.message);
      return json.result;
    },
    on: () => {},
    removeListener: () => {},
  } as unknown as EIP1193Provider;
}

/** Deploys a Hybrid DeleGator whose owner EOA is `recovery`, funded with 0.003 ETH, 14.8 USDC, 0.001 ETH deposit. */
export async function recoverableAccount(
  publicClient: PublicClient,
  FORK: string,
  recovery: Address,
): Promise<Address> {
  const funder = privateKeyToAccount(generatePrivateKey());
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [funder.address, toHex(parseEther("5"))] as never,
  });
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [recovery, toHex(parseEther("0.01"))] as never,
  });
  const sa = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [recovery, [], [], []],
    deploySalt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    signer: { account: privateKeyToAccount(generatePrivateKey()) },
  });
  const { factory, factoryData } = await sa.getFactoryArgs();
  const w = createWalletClient({ account: funder, chain, transport: http(FORK) });
  await publicClient.waitForTransactionReceipt({
    hash: await w.sendTransaction({ to: factory as Address, data: factoryData as Hex }),
  });
  await publicClient.waitForTransactionReceipt({
    hash: await w.sendTransaction({ to: sa.address, value: parseEther("0.003") }),
  });
  await fundUsdc(publicClient, sa.address, parseUnits("14.8", 6));
  await publicClient.waitForTransactionReceipt({
    hash: await w.writeContract({
      address: ENTRY_POINT_V07,
      abi: parseAbi(["function depositTo(address account) payable"]),
      functionName: "depositTo",
      args: [sa.address],
      value: parseEther("0.001"),
    }),
  });
  return sa.address;
}
