/**
 * Everything the policy service needs from the chain, behind one interface (mocked in unit tests).
 * The service never trusts client claims about on-chain state; it reads the chain itself.
 */

import {
  cosignerEnforcerAddress,
  deployCosignerEnforcer,
  deployPerTransferCapEnforcer,
  type Execution,
  encodeRedeem,
  perTransferCapEnforcerAddress,
  readVault,
  revertReason,
  submitUserOp,
  type UserOpJSON,
  userOpFromJSON,
} from "@cyphos-guard/sdk";
import { fundUsdc } from "@cyphos-guard/sdk/testing";
import {
  type Delegation,
  getSmartAccountsEnvironment,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import { DelegationManager, HybridDeleGator } from "@metamask/smart-accounts-kit/contracts";
import { decodeDelegations, hashDelegation } from "@metamask/smart-accounts-kit/utils";
import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  isAddressEqual,
  type PublicClient,
  parseAbi,
  parseEther,
  parseEventLogs,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { decodeOwnerOp, entryPointAbi, type OwnerOp } from "./ownerTx.ts";

export type VerifiedRedeem = { delegator: Address; to: Address; value: bigint; data: Hex };

const redeemAbi = parseAbi([
  "function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallDatas)",
]);

export type ChainAdapter = {
  chainId: number;
  isFork: boolean;
  environment: SmartAccountsEnvironment;
  /** Chain time (unix s). Used for expiries so they match the on-chain TimestampEnforcer, even on a fast-forwarded fork. */
  now(): Promise<number>;
  /** eth_call the agent's redemption; null if it would succeed, else the revert reason. */
  simulateRedeem(agent: Address, delegation: Delegation, execution: Execution): Promise<string | null>;
  isDisabled(delegation: Delegation): Promise<boolean>;
  /**
   * If `hash` is a successful redeemDelegations tx sent by `from`, returns what it executed (decoded from
   * the tx itself) and whose account it spent from (root delegator). Otherwise null.
   */
  verifiedRedeem(hash: Hex, from: Address): Promise<VerifiedRedeem | null>;
  /** A deployed X402Vault's configuration, or null if there is no contract at `vault`. */
  readX402Vault(
    vault: Address,
    sellers: Address[],
  ): Promise<{
    owner: Address;
    agent: Address;
    token: Address;
    maxPerPayment: bigint;
    allSellersListed: boolean;
  } | null>;
  /** Total `token` moved from → to by the successful tx `hash` (ERC-20 Transfer logs), or null if it failed. */
  erc20Transferred(hash: Hex, token: Address, from: Address, to: Address): Promise<bigint | null>;
  /**
   * The owner's own userOp in tx `hash`: only if it's a successful EntryPoint.handleOps tx containing a successful
   * userOp sent by `account`. Calls are decoded from the tx input, not taken from the client.
   */
  ownerOp(hash: Hex, account: Address): Promise<OwnerOp | null>;
  /** True if `account` is deployed and has the passkey (keyId → x,y) as a signer. */
  accountHasPasskey(account: Address, keyId: string, x: Hex, y: Hex): Promise<boolean>;
  /**
   * Makes sure our caveat enforcers (CosignerEnforcer, ERC20PerTransferCapEnforcer) exist at their CREATE2
   * addresses. Fork: deploys them with the dev relayer. Live: only checks (deploy once with
   * `pnpm contracts:deploy`). Returns which ones are deployed.
   */
  ensureEnforcers(): Promise<{ cosigner: boolean; perTransferCap: boolean }>;
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
    throw new Error(`RPC is chain ${chainId}; cyphos-guard only runs on Base Sepolia (84532)`);
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
    async verifiedRedeem(hash, from) {
      const [tx, receipt] = await Promise.all([
        client.getTransaction({ hash }),
        client.getTransactionReceipt({ hash }).catch(() => null),
      ]);
      if (
        receipt?.status !== "success" ||
        !isAddressEqual(tx.from, from) ||
        !tx.to ||
        !isAddressEqual(tx.to, environment.DelegationManager)
      ) {
        return null;
      }
      try {
        const { args } = decodeFunctionData({ abi: redeemAbi, data: tx.input });
        const [contexts, , executions] = args;
        const chainOf = decodeDelegations(contexts[0] as Hex); // leaf → root
        const root = chainOf.at(-1);
        const exec = executions[0] as Hex; // single execution: target(20) ‖ value(32) ‖ callData
        if (!root || !exec || exec.length < 2 + 104) return null;
        return {
          delegator: getAddress(root.delegator),
          to: getAddress(`0x${exec.slice(2, 42)}`),
          value: BigInt(`0x${exec.slice(42, 106)}`),
          data: `0x${exec.slice(106)}` as Hex,
        };
      } catch {
        return null;
      }
    },
    async readX402Vault(vault, sellers) {
      if (!(await client.getCode({ address: vault }))) return null;
      return readVault(client, vault, sellers).catch(() => null);
    },
    async erc20Transferred(hash, token, from, to) {
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt?.status !== "success") return null;
      return parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
        .filter(
          (l) => isAddressEqual(l.address, token) && isAddressEqual(l.args.from, from) && isAddressEqual(l.args.to, to),
        )
        .reduce((sum, l) => sum + l.args.value, 0n);
    },
    async ownerOp(hash, account) {
      const [tx, receipt] = await Promise.all([
        client.getTransaction({ hash }).catch(() => null),
        client.getTransactionReceipt({ hash }).catch(() => null),
      ]);
      if (!tx?.to || !receipt || receipt.status !== "success") return null;
      if (!isAddressEqual(tx.to, environment.EntryPoint)) return null;
      const ok = parseEventLogs({ abi: entryPointAbi, eventName: "UserOperationEvent", logs: receipt.logs }).some(
        (l) =>
          isAddressEqual(l.address, environment.EntryPoint) && isAddressEqual(l.args.sender, account) && l.args.success,
      );
      return ok ? decodeOwnerOp(tx.input, account) : null;
    },
    ensureEnforcers: async () => ({
      cosigner: !!(await client.getCode({ address: cosignerEnforcerAddress })),
      perTransferCap: !!(await client.getCode({ address: perTransferCapEnforcerAddress })),
    }),
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
    adapter.ensureEnforcers = async () => {
      await deployCosignerEnforcer(relayerWallet, client);
      await deployPerTransferCapEnforcer(relayerWallet, client);
      return { cosigner: true, perTransferCap: true };
    };
    adapter.fund = async (address, ether) => {
      await setBalance(address, ether);
      await fundUsdc(client, address, 100_000_000n); // 100 test USDC (fork only, storage write)
    };
  }
  return adapter;
}
