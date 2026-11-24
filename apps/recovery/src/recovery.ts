/**
 * Recovery without cyphos-guard: the owner's RECOVERY address (an EOA, e.g. MetaMask) moves everything out of
 * a MetaMask Hybrid DeleGator smart account, or stops every agent at once, using only an EIP-1193 wallet. No
 * cyphos-guard service, no passkey, no bundler.
 *
 * The account only executes calls that come through the ERC-4337 EntryPoint (`onlyEntryPoint`), so the
 * recovery key signs a UserOperation (EIP-712 typed data, which wallets show and sign natively) and then
 * submits it itself via EntryPoint.handleOps, paying the network fee from its own address. The userOp's own gas
 * price is zero, so the account needs no prefund and every wei can leave.
 */
import {
  type Address,
  concat,
  createPublicClient,
  createWalletClient,
  custom,
  type EIP1193Provider,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  hashTypedData,
  isAddressEqual,
  pad,
  parseAbi,
  parseEventLogs,
  toHex,
  zeroAddress,
} from "viem";
import { baseSepolia } from "viem/chains";

export const ENTRY_POINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
export const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const CHAIN = baseSepolia;

const accountAbi = parseAbi([
  "function owner() view returns (address)",
  "function entryPoint() view returns (address)",
  "function execute(bytes32 mode, bytes executionCalldata) payable",
  "function withdrawDeposit(address withdrawAddress, uint256 withdrawAmount)",
  "function getKeyIdHashesCount() view returns (uint256)",
  "function updateSigners(address owner, string[] keyIds, uint256[] xValues, uint256[] yValues)",
  "function getPackedUserOperationTypedDataHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
]);
const entryPointAbi = parseAbi([
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
]);

const vaultAbi = parseAbi([
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function withdraw(address token, address to, uint256 amount)",
]);

export type PackedUserOperation = {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

export type AccountState = {
  account: Address;
  deployed: boolean;
  recovery: Address | null;
  eth: bigint;
  usdc: bigint;
  /** ETH the account holds at the EntryPoint (gas deposit), also withdrawable. */
  deposit: bigint;
  /** Number of passkeys (P-256 signers) on the account. */
  passkeys: number;
};

export class RecoveryError extends Error {
  override name = "RecoveryError";
}

export function clients(provider: EIP1193Provider) {
  const transport = custom(provider);
  return {
    publicClient: createPublicClient({ chain: CHAIN, transport }),
    walletClient: createWalletClient({ chain: CHAIN, transport }),
  };
}

/** Reads what the account holds and who its recovery address is. */
export async function inspect(provider: EIP1193Provider, account: Address): Promise<AccountState> {
  const { publicClient } = clients(provider);
  const code = await publicClient.getCode({ address: account });
  const deployed = !!code && code !== "0x";
  const [eth, usdc, deposit, recovery, passkeys] = await Promise.all([
    publicClient.getBalance({ address: account }),
    publicClient
      .readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] })
      .catch(() => 0n),
    publicClient
      .readContract({ address: ENTRY_POINT_V07, abi: entryPointAbi, functionName: "balanceOf", args: [account] })
      .catch(() => 0n),
    deployed
      ? publicClient
          .readContract({ address: account, abi: accountAbi, functionName: "owner" })
          .then((o) => (isAddressEqual(o, zeroAddress) ? null : o))
          .catch(() => null)
      : Promise.resolve(null),
    deployed
      ? publicClient
          .readContract({ address: account, abi: accountAbi, functionName: "getKeyIdHashesCount" })
          .then(Number)
          .catch(() => 0)
      : Promise.resolve(0),
  ]);
  return { account, deployed, recovery, eth, usdc, deposit, passkeys };
}

/** The calls that empty the account into `to`: USDC, ETH and the EntryPoint deposit (whatever is non-zero). */
export function withdrawAllCalls(state: AccountState, to: Address) {
  const calls: { target: Address; value: bigint; callData: Hex; label: string }[] = [];
  if (state.usdc > 0n) {
    calls.push({
      target: USDC,
      value: 0n,
      callData: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, state.usdc] }),
      label: `${state.usdc} USDC base units`,
    });
  }
  if (state.deposit > 0n) {
    // withdrawDeposit is onlyEntryPointOrSelf: the account calls itself.
    calls.push({
      target: state.account,
      value: 0n,
      callData: encodeFunctionData({ abi: accountAbi, functionName: "withdrawDeposit", args: [to, state.deposit] }),
      label: `${state.deposit} wei EntryPoint deposit`,
    });
  }
  if (state.eth > 0n) calls.push({ target: to, value: state.eth, callData: "0x", label: `${state.eth} wei` });
  return calls;
}

export type VaultState = { address: Address; token: Address; balance: bigint };

/**
 * Reads the x402 vaults the user entered. A vault can't be switched off and isn't emptied by the emergency stop
 * (issue #2), so its rest is withdrawn here. Each address must be a vault this account owns; anything else is
 * refused, so a typo or a foreign contract never ends up in the signed call.
 */
export async function inspectVaults(
  provider: EIP1193Provider,
  account: Address,
  addresses: Address[],
): Promise<VaultState[]> {
  const { publicClient } = clients(provider);
  const unique = [...new Map(addresses.map((a) => [a.toLowerCase(), a])).values()];
  return Promise.all(
    unique.map(async (address) => {
      const owner = await publicClient
        .readContract({ address, abi: vaultAbi, functionName: "owner" })
        .catch(() => null);
      if (!owner || !isAddressEqual(owner, account)) {
        throw new RecoveryError(`${address} is not an x402 vault of this account`);
      }
      const token = await publicClient.readContract({ address, abi: vaultAbi, functionName: "token" });
      const balance = await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      });
      return { address, token, balance };
    }),
  );
}

/** The calls (from the account, the vaults' owner) that send each non-empty vault's balance to `to`. */
export function withdrawVaultCalls(vaults: VaultState[], to: Address) {
  return vaults
    .filter((v) => v.balance > 0n)
    .map((v) => ({
      target: v.address,
      value: 0n,
      callData: encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args: [v.token, to, v.balance] }),
      label: `${v.balance} base units from vault ${v.address}`,
    }));
}

/**
 * Emergency stop: removes every passkey from the account and keeps the recovery address as its only signer.
 * The DelegationManager checks the delegator's signature (ERC-1271) at every redemption, so every delegation
 * the passkey ever signed (agent permissions and pending one-shot approvals) stops working at once. No list of
 * delegations is needed, which this page couldn't get without the cyphos-guard service.
 * Afterwards the passkey can't sign for this account any more; the recovery address can still withdraw.
 */
export function stopAgentsCalls(state: AccountState) {
  if (!state.recovery) throw new RecoveryError("the account has no recovery address");
  return [
    {
      target: state.account,
      value: 0n,
      // updateSigners is onlyEntryPointOrSelf: the account calls itself. Same owner, no keys → keys deleted.
      callData: encodeFunctionData({
        abi: accountAbi,
        functionName: "updateSigners",
        args: [state.recovery, [], [], []],
      }),
      label: `remove ${state.passkeys} passkey(s)`,
    },
  ];
}

/** ERC-7579 batch execution: mode 0x01 (batch, default exec type), calldata abi.encode(Execution[]). */
export function encodeBatchExecute(calls: { target: Address; value: bigint; callData: Hex }[]): Hex {
  const mode = pad("0x01", { dir: "right", size: 32 });
  const executions = encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    [calls.map((c) => ({ target: c.target, value: c.value, callData: c.callData }))],
  );
  return encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [mode, executions] });
}

const packUints = (hi: bigint, lo: bigint): Hex => concat([pad(toHex(hi), { size: 16 }), pad(toHex(lo), { size: 16 })]);

/** Unsigned userOp with zero gas price (self-submitted by the recovery key, which pays the network fee). */
export async function buildUserOp(
  provider: EIP1193Provider,
  account: Address,
  callData: Hex,
): Promise<PackedUserOperation> {
  const { publicClient } = clients(provider);
  const nonce = await publicClient.readContract({
    address: ENTRY_POINT_V07,
    abi: entryPointAbi,
    functionName: "getNonce",
    args: [account, 0n],
  });
  return {
    sender: account,
    nonce,
    initCode: "0x",
    callData,
    accountGasLimits: packUints(300_000n, 400_000n), // verificationGasLimit ‖ callGasLimit
    preVerificationGas: 0n,
    gasFees: packUints(0n, 0n), // maxPriorityFeePerGas ‖ maxFeePerGas: zero → no prefund from the account
    paymasterAndData: "0x",
    signature: "0x",
  };
}

/** The EIP-712 typed data the Hybrid DeleGator verifies for a userOp (its getPackedUserOperationTypedDataHash). */
export function userOpTypedData(op: PackedUserOperation, chainId: number) {
  return {
    domain: { name: "HybridDeleGator", version: "1", chainId, verifyingContract: op.sender },
    types: {
      PackedUserOperation: [
        { name: "sender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "initCode", type: "bytes" },
        { name: "callData", type: "bytes" },
        { name: "accountGasLimits", type: "bytes32" },
        { name: "preVerificationGas", type: "uint256" },
        { name: "gasFees", type: "bytes32" },
        { name: "paymasterAndData", type: "bytes" },
        { name: "entryPoint", type: "address" },
      ],
    },
    primaryType: "PackedUserOperation" as const,
    message: {
      sender: op.sender,
      nonce: op.nonce,
      initCode: op.initCode,
      callData: op.callData,
      accountGasLimits: op.accountGasLimits,
      preVerificationGas: op.preVerificationGas,
      gasFees: op.gasFees,
      paymasterAndData: op.paymasterAndData,
      entryPoint: ENTRY_POINT_V07,
    },
  };
}

/**
 * Safety check before asking the wallet to sign: our typed data must hash to exactly what the account contract
 * itself will verify. If not (another account type, another EntryPoint), refuse rather than sign a mismatch.
 */
export async function checkTypedDataMatchesAccount(provider: EIP1193Provider, op: PackedUserOperation) {
  const { publicClient } = clients(provider);
  const [onChain, entryPoint] = await Promise.all([
    publicClient.readContract({
      address: op.sender,
      abi: accountAbi,
      functionName: "getPackedUserOperationTypedDataHash",
      args: [op],
    }),
    publicClient.readContract({ address: op.sender, abi: accountAbi, functionName: "entryPoint" }),
  ]);
  if (!isAddressEqual(entryPoint, ENTRY_POINT_V07)) throw new RecoveryError(`unexpected EntryPoint ${entryPoint}`);
  const local = hashTypedData(userOpTypedData(op, CHAIN.id));
  if (local !== onChain) throw new RecoveryError("typed data does not match the account's own hash; not signing");
}

/** Signs with the connected recovery address and submits via EntryPoint.handleOps. Throws if the calls failed. */
export async function signAndSubmit(provider: EIP1193Provider, recovery: Address, op: PackedUserOperation) {
  const { publicClient, walletClient } = clients(provider);
  await checkTypedDataMatchesAccount(provider, op);
  const signature = await walletClient.signTypedData({ account: recovery, ...userOpTypedData(op, CHAIN.id) });
  const signed = { ...op, signature };
  const hash = await walletClient.writeContract({
    account: recovery,
    address: ENTRY_POINT_V07,
    abi: entryPointAbi,
    functionName: "handleOps",
    args: [[signed], recovery],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new RecoveryError(`transaction reverted: ${hash}`);
  const [event] = parseEventLogs({ abi: entryPointAbi, eventName: "UserOperationEvent", logs: receipt.logs });
  if (!event?.args.success) {
    const [why] = parseEventLogs({ abi: entryPointAbi, eventName: "UserOperationRevertReason", logs: receipt.logs });
    throw new RecoveryError(`the account's calls failed (${why?.args.revertReason ?? "no reason"}); tx ${hash}`);
  }
  return hash;
}
