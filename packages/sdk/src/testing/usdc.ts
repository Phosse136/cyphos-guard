/** Circle's test USDC on Base Sepolia, and a fork-only helper to mint balances via storage writes. */
import { type Address, encodeAbiParameters, erc20Abi, keccak256, type PublicClient, toHex } from "viem";

export const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * Fork only: sets `holder`'s USDC balance by writing the token's balance mapping slot directly
 * (anvil_setStorageAt). The slot index is discovered by probing, not hardcoded.
 */
export async function fundUsdc(client: PublicClient, holder: Address, amount: bigint) {
  const symbol = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "symbol" });
  if (symbol !== "USDC") throw new Error(`unexpected token at ${USDC}: ${symbol}`);
  for (let slot = 0n; slot < 32n; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot]));
    const before = await client.getStorageAt({ address: USDC, slot: key });
    await client.request({
      method: "anvil_setStorageAt" as never,
      params: [USDC, key, toHex(amount, { size: 32 })] as never,
    });
    const bal = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
    if (bal === amount) return slot;
    await client.request({
      method: "anvil_setStorageAt" as never,
      params: [USDC, key, before ?? toHex(0n, { size: 32 })] as never,
    });
  }
  throw new Error("could not find USDC balance slot");
}
