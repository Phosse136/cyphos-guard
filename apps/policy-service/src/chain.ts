/**
 * Everything the policy service needs from the chain, behind one interface (mocked in unit tests).
 * The service never trusts client claims about on-chain state; it reads the chain itself.
 */
import {
  type Delegation,
  getSmartAccountsEnvironment,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import { DelegationManager, HybridDeleGator } from "@metamask/smart-accounts-kit/contracts";
import { hashDelegation } from "@metamask/smart-accounts-kit/utils";
import {
  type Execution,
  encodeRedeem,
  revertReason,
  submitUserOp,
  type UserOpJSON,
  userOpFromJSON,
} from "@phoswallet/sdk";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  isAddressEqual,
  type PublicClient,
  parseEther,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export type ChainAdapter = {
  chainId: number;
  isFork: boolean;
  environment: SmartAccountsEnvironment;
  /** Chain time (unix s). Used for expiries so they match the on-chain TimestampEnforcer, even on a fast-forwarded fork. */
  now(): Promise<number>;
  /** eth_call the agent's redemption; null if it would succeed, else the revert reason. */
  simulateRedeem(agent: Address, delegation: Delegation, execution: Execution): Promise<string | null>;
  isDisabled(delegation: Delegation): Promise<boolean>;
  /** True if `hash` is a successful tx sent by `from` to the DelegationManager. */
  isSuccessfulRedeem(hash: Hex, from: Address): Promise<boolean>;
  /** True if `account` is deployed and has the passkey (keyId → x,y) as a signer. */
  accountHasPasskey(account: Address, keyId: string, x: Hex, y: Hex): Promise<boolean>;
  /** Fork only. Submits a passkey-signed userOp via EntryPoint.handleOps from a throwaway relayer key. */
  relayUserOp?(op: UserOpJSON): Promise<Hex>;
  /** Fork only. anvil_setBalance. */
  fund?(address: Address, ether: string): Promise<void>;
};

export async function createChainAdapter(opts: { rpcUrl: string; network: "fork" | "live" }): Promise<ChainAdapter> {
  const chain: Chain = baseSepolia;
  const client: PublicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== baseSepolia.id)
    throw new Error(`RPC is chain ${chainId}; phoswallet only runs on Base Sepolia (84532)`);
  const environment = getSmartAccountsEnvironment(chainId);

  let isFork = false;
  if (opts.network === "fork") {
    // Belt and braces: dev-only features require an actual anvil node, not just a config flag.
    try {
      await client.request({ method: "anvil_nodeInfo" as never });
      isFork = true;
    } catch {
      throw new Error("NETWORK=fork but the RPC is not an anvil node; refusing to enable dev relay/funding");
    }
  }

  const adapter: ChainAdapter = {
    chainId,
    isFork,
    environment,
    now: async () => Number((await client.getBlock()).timestamp),
    async simulateRedeem(agent, delegation, execution) {
      try {
        await client.call({
          account: agent,
          to: environment.DelegationManager,
          data: encodeRedeem(delegation, execution),
        });
        return null;
      } catch (e) {
        return revertReason(e);
      }
    },
    isDisabled: (delegation) =>
      DelegationManager.read.disabledDelegations({
        client,
        contractAddress: environment.DelegationManager,
        delegationHash: hashDelegation(delegation),
      }),
    async isSuccessfulRedeem(hash, from) {
      const [tx, receipt] = await Promise.all([
        client.getTransaction({ hash }),
        client.getTransactionReceipt({ hash }).catch(() => null),
      ]);
      return (
        receipt?.status === "success" &&
        isAddressEqual(tx.from, from) &&
        !!tx.to &&
        isAddressEqual(tx.to, environment.DelegationManager)
      );
    },
    async accountHasPasskey(account, keyId, x, y) {
      if (!(await client.getCode({ address: account }))) return false;
      try {
        const [kx, ky] = await HybridDeleGator.read.getKey({ client, hybridDeleGatorAddress: account, keyId });
        return kx === BigInt(x) && ky === BigInt(y);
      } catch {
        return false;
      }
    },
  };

  if (isFork) {
    const relayer = privateKeyToAccount(generatePrivateKey()); // in-memory, fork-only, never persisted
    const relayerWallet = createWalletClient({ account: relayer, chain, transport: http(opts.rpcUrl) });
    const setBalance = (a: Address, eth: string) =>
      client.request({ method: "anvil_setBalance" as never, params: [a, toHex(parseEther(eth))] as never });
    await setBalance(relayer.address, "100");
    adapter.relayUserOp = (op) => submitUserOp(userOpFromJSON(op), relayerWallet, client);
    adapter.fund = async (address, ether) => {
      await setBalance(address, ether);
    };
  }
  return adapter;
}
