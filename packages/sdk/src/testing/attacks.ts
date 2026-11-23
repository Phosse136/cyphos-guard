/**
 * The attack catalog: what an attacker who STOLE THE AGENT'S KEY (or a prompt-injected agent) can try against a
 * grant, sent straight to the chain, bypassing the SDK and the policy service. Every attack must revert.
 *
 * Each run also has positive controls (a legitimate payment of exactly the cap must work), so an attack can't
 * look "blocked" because of an unrelated failure such as an empty account or a broken RPC: if a control fails,
 * the run is inconclusive, not green.
 *
 * Everything here is a read-only eth_call, so the same catalog runs in CI on a fork (attacks.fork.test.ts) and
 * against the live chain (the canary) without spending anything. Attacks that need state changes (expiry,
 * revoke, period exhaustion, replays) live in the fork test only.
 */

import {
  createDelegation,
  createExecution,
  type Delegation,
  ExecutionMode,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import { signDelegation } from "@metamask/smart-accounts-kit/actions";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import {
  type Address,
  concat,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  http,
  isAddressEqual,
  type LocalAccount,
  maxUint256,
  type PublicClient,
  pad,
  parseAbi,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type Execution, encodeRedeem, revertReason } from "../delegations.ts";
import { perTransferCapEnforcerAddress } from "../transferCap.ts";
import { encodeVaultSignature } from "../vault.ts";

const isCap = (enforcer: Address) => isAddressEqual(enforcer, perTransferCapEnforcerAddress);

export type AttackTarget = {
  environment: SmartAccountsEnvironment;
  chainId: number;
  /** The owner's smart account (delegator). */
  account: Address;
  /** The agent's key: the attacker has it. */
  agent: LocalAccount;
  /** Where the attacker wants the money to go. */
  attacker: Address;
  /** The ERC-20 the grant is for (USDC). */
  token: Address;
  /** Another ERC-20 the account holds (Base Sepolia WETH by default), for "wrong token". */
  otherToken: Address;
  /** A signed erc20Transfer grant delegation: `perTx` max per payment, only to `recipient`. */
  erc20: { delegation: Delegation; recipient: Address; perTx: bigint };
  /** A signed x402 grant delegation that tops up `vault`; the vault pays only `seller`, at most `perTx`. */
  x402?: { delegation: Delegation; vault: Address; seller: Address; perTx: bigint; tokenName: string; version: string };
};

/** One eth_call. `expect` = the revert reason it must fail with (null = a control: it must succeed). */
export type Probe = {
  id: string;
  title: string;
  /** Why this would be a hole if it went through. */
  why: string;
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
  expect: RegExp | null;
};

export type ProbeResult = Probe & { ok: boolean; reason: string; verdict: "blocked" | "allowed" | "FAIL" };

const usdcAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, bytes signature)",
  "function increaseAllowance(address spender, uint256 increment)",
  "function nonces(address owner) view returns (uint256)",
]);
const accountAbi = parseAbi(["function execute((address target, uint256 value, bytes callData) execution)"]);

export const BASE_SEPOLIA_WETH: Address = "0x4200000000000000000000000000000000000006";

const transfer = (token: Address, to: Address, amount: bigint): Execution => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
});
const redeemWithMode = (d: Delegation, mode: ExecutionMode, executions: Execution[]) =>
  DelegationManager.encode.redeemDelegations({
    delegations: [[d]],
    modes: [mode],
    executions: [executions.map((e) => createExecution({ target: e.to, value: e.value ?? 0n, callData: e.data }))],
  });
/** Same delegation, with some caveats changed after the owner signed it. */
const tampered = (d: Delegation, edit: (c: Delegation["caveats"]) => Delegation["caveats"]): Delegation => ({
  ...d,
  caveats: edit(d.caveats),
});

/** Builds the catalog for one grant. Async because some attacks need the agent's own signatures. */
export async function buildAttacks(t: AttackTarget, now: number): Promise<Probe[]> {
  const { erc20 } = t;
  const agent = t.agent.address;
  const dm = t.environment.DelegationManager;
  const viaGrant = (execution: Execution) => ({ from: agent, to: dm, data: encodeRedeem(erc20.delegation, execution) });
  const pay = (amount: bigint, to = erc20.recipient) => viaGrant(transfer(t.token, to, amount));

  // The agent (whose key the attacker holds) re-delegates its whole authority to the attacker, unrestricted.
  const sub = createDelegation({
    environment: t.environment,
    from: agent,
    to: t.attacker,
    parentDelegation: erc20.delegation,
    caveats: [],
  });
  // A local account signs without any network round-trip; the transport is never used.
  const agentWallet = createWalletClient({ account: t.agent, transport: http("http://127.0.0.1:1") });
  const subSigned: Delegation = {
    ...sub,
    signature: await signDelegation(agentWallet, {
      delegation: sub,
      delegationManager: dm,
      chainId: t.chainId,
      allowInsecureUnrestrictedDelegation: true, // exactly what an attacker would do
    }),
  };
  const chain = (execution: Execution) =>
    DelegationManager.encode.redeemDelegations({
      delegations: [[subSigned, erc20.delegation]],
      modes: [ExecutionMode.SingleDefault],
      executions: [[createExecution({ target: execution.to, value: 0n, callData: execution.data })]],
    });

  const dirtyRecipientWord = concat([
    "0xa9059cbb", // transfer(address,uint256)
    concat(["0xff0000000000000000000000", erc20.recipient]), // the recipient's 32-byte word, with high bits set
    toHex(1n, { size: 32 }),
  ]);
  const perTxWord = erc20.perTx;

  const probes: Probe[] = [
    {
      id: "control-cap",
      title: "Legitimate payment of exactly the per-payment cap to the allowed recipient",
      why: "Positive control: must go through, or the run proves nothing.",
      ...pay(perTxWord),
      expect: null,
    },
    {
      id: "A01-over-cap",
      title: "Pay one unit more than the per-payment cap",
      why: "The cap would be decoration.",
      ...pay(perTxWord + 1n),
      expect: /ERC20PerTransferCapEnforcer:amount-exceeded/,
    },
    {
      id: "A02-other-recipient",
      title: "Pay the attacker instead of the allowed recipient",
      why: "A stolen key could drain the account to any address.",
      ...pay(1n, t.attacker),
      expect: /AllowedCalldataEnforcer:invalid-calldata/,
    },
    {
      id: "A03-approve",
      title: "approve(attacker, max) instead of transfer",
      why: "The attacker could pull everything later with transferFrom, outside every cap.",
      ...viaGrant({
        to: t.token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [t.attacker, maxUint256] }),
      }),
      expect: /invalid-method|invalid-execution-length/,
    },
    {
      id: "A04-increase-allowance",
      title: "increaseAllowance(attacker, max)",
      why: "Same as approve, through USDC's other allowance function.",
      ...viaGrant({
        to: t.token,
        data: encodeFunctionData({ abi: usdcAbi, functionName: "increaseAllowance", args: [t.attacker, maxUint256] }),
      }),
      expect: /invalid-method|invalid-execution-length/,
    },
    {
      id: "A05-transfer-from",
      title: "transferFrom(account, attacker, cap)",
      why: "Moves funds with a different selector and recipient position.",
      ...viaGrant({
        to: t.token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transferFrom",
          args: [t.account, t.attacker, perTxWord],
        }),
      }),
      expect: /invalid-method|invalid-execution-length/,
    },
    {
      id: "A06-batch",
      title: "Batch mode: two cap-sized payments in one redemption",
      why: "A batch could hide a second transfer from a per-call check.",
      from: agent,
      to: dm,
      data: redeemWithMode(erc20.delegation, ExecutionMode.BatchDefault, [
        transfer(t.token, erc20.recipient, perTxWord),
        transfer(t.token, erc20.recipient, perTxWord),
      ]),
      expect: /CaveatEnforcer:invalid-call-type/,
    },
    {
      id: "A07-try-mode",
      title: "Try mode instead of default execution",
      why: "A failing inner call would not revert, so state could be consumed inconsistently.",
      from: agent,
      to: dm,
      data: redeemWithMode(erc20.delegation, ExecutionMode.SingleTry, [transfer(t.token, erc20.recipient, 1n)]),
      expect: /CaveatEnforcer:invalid-execution-type/,
    },
    {
      id: "A08-other-token",
      title: "Use the grant to move a different token (WETH)",
      why: "The grant is for one token; others in the account must be out of reach.",
      ...viaGrant(transfer(t.otherToken, erc20.recipient, 1n)),
      expect: /invalid-contract/,
    },
    {
      id: "A09-attach-eth",
      title: "Attach ETH to the token transfer",
      why: "Native ETH would leave the account under an ERC-20 grant.",
      ...viaGrant({ ...transfer(t.token, erc20.recipient, 1n), value: 1n }),
      expect: /ValueLteEnforcer:value-too-high|invalid-value/,
    },
    {
      id: "A10-trailing-bytes",
      title: "Valid transfer with extra bytes appended",
      why: "Parsers that read fixed offsets can disagree with the token about what the call means.",
      ...viaGrant({ to: t.token, data: concat([transfer(t.token, erc20.recipient, 1n).data as Hex, pad("0x01")]) }),
      expect: /invalid-execution-length/,
    },
    {
      id: "A11-dirty-address-word",
      title: "Recipient word with high bits set (ABI-dirty address)",
      why: "Some tokens mask the upper bits, so a sloppy allowlist check could be fooled.",
      ...viaGrant({ to: t.token, data: dirtyRecipientWord }),
      expect: /AllowedCalldataEnforcer:invalid-calldata/,
    },
    {
      id: "A12-strip-cap-caveat",
      title: "Remove the per-payment cap caveat from the signed delegation",
      why: "The caveats must be covered by the owner's signature.",
      from: agent,
      to: dm,
      data: encodeRedeem(
        tampered(erc20.delegation, (c) => c.filter((x) => !isCap(x.enforcer))),
        transfer(t.token, t.attacker, perTxWord * 10n),
      ),
      expect: /InvalidERC1271Signature|InvalidEOASignature/,
    },
    {
      id: "A13-raise-cap-terms",
      title: "Rewrite the cap in the caveat terms to the maximum",
      why: "Terms changed after signing must invalidate the delegation.",
      from: agent,
      to: dm,
      data: encodeRedeem(
        tampered(erc20.delegation, (c) =>
          c.map((x) => (isCap(x.enforcer) ? { ...x, terms: concat([t.token, toHex(maxUint256)]) } : x)),
        ),
        transfer(t.token, erc20.recipient, perTxWord * 10n),
      ),
      expect: /InvalidERC1271Signature|InvalidEOASignature/,
    },
    {
      id: "A14-stranger-redeems",
      title: "Someone other than the agent redeems the agent's delegation",
      why: "A leaked delegation (not key) must be useless.",
      ...pay(1n),
      from: t.attacker,
      expect: /InvalidDelegate/,
    },
    {
      id: "A15-redelegate-to-attacker",
      title: "Agent re-delegates unrestricted to the attacker, attacker pays himself",
      why: "Re-delegation must not shed the root's caveats.",
      from: t.attacker,
      to: dm,
      data: chain(transfer(t.token, t.attacker, 1n)),
      expect: /AllowedCalldataEnforcer:invalid-calldata/,
    },
    {
      id: "A16-redelegate-over-cap",
      title: "Re-delegated chain pays the allowed recipient above the cap",
      why: "Same as A15, for the amount.",
      from: t.attacker,
      to: dm,
      data: chain(transfer(t.token, erc20.recipient, perTxWord + 1n)),
      expect: /ERC20PerTransferCapEnforcer:amount-exceeded/,
    },
    {
      id: "A17-call-account-directly",
      title: "Call the smart account's execute() directly with the agent key",
      why: "The agent key must have no authority over the account outside delegations.",
      from: agent,
      to: t.account,
      data: encodeFunctionData({
        abi: accountAbi,
        functionName: "execute",
        args: [{ target: t.token, value: 0n, callData: transfer(t.token, t.attacker, 1n).data as Hex }],
      }),
      expect: /NotEntryPoint/,
    },
  ];

  if (t.x402) probes.push(...(await x402Attacks(t, t.x402, now)));
  return probes;
}

async function x402Attacks(t: AttackTarget, x: NonNullable<AttackTarget["x402"]>, now: number): Promise<Probe[]> {
  const agent = t.agent.address;
  const dm = t.environment.DelegationManager;
  const topUp = (to: Address, amount: bigint) => ({
    from: agent,
    to: dm,
    data: encodeRedeem(x.delegation, transfer(t.token, to, amount)),
  });
  const domain = { name: x.tokenName, version: x.version, chainId: t.chainId, verifyingContract: t.token } as const;
  const validBefore = BigInt(now + 600);
  const nonce = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
  /** An EIP-3009 authorization FROM the vault, signed by `signer`, wrapped in the vault's signature format. */
  const authorize = async (
    primaryType: "TransferWithAuthorization" | "ReceiveWithAuthorization",
    to: Address,
    value: bigint,
    signer: LocalAccount = t.agent,
  ) => {
    const n = nonce();
    const message = { from: x.vault, to, value, validAfter: 0n, validBefore, nonce: n };
    const signature = await signer.signTypedData({
      domain,
      types: { [primaryType]: authorizationFields },
      primaryType,
      message,
    } as never);
    const wrapped = encodeVaultSignature(
      { to, value: String(value), validAfter: "0", validBefore: String(validBefore), nonce: n },
      signature,
    );
    const functionName =
      primaryType === "TransferWithAuthorization" ? "transferWithAuthorization" : "receiveWithAuthorization";
    return encodeFunctionData({
      abi: usdcAbi,
      functionName,
      args: [x.vault, to, value, 0n, validBefore, n, wrapped],
    });
  };
  const stranger = privateKeyToAccount(generatePrivateKey());
  const permitNonce = 0n;
  const permitSig = await t.agent.signTypedData({
    domain,
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: x.vault, spender: t.attacker, value: maxUint256, nonce: permitNonce, deadline: validBefore },
  });

  return [
    {
      id: "control-x402-topup",
      title: "Legitimate x402 top-up of exactly the cap into the vault",
      why: "Positive control.",
      ...topUp(x.vault, x.perTx),
      expect: null,
    },
    {
      id: "control-x402-payment",
      title: "Legitimate vault payment of exactly the cap to the listed seller",
      why: "Positive control (the vault must hold at least the cap).",
      from: t.attacker, // anyone may submit an EIP-3009 authorization
      to: t.token,
      data: await authorize("TransferWithAuthorization", x.seller, x.perTx),
      expect: null,
    },
    {
      id: "X01-topup-to-agent",
      title: "x402 top-up to the agent's own address instead of the vault",
      why: "The agent would hold funds no on-chain seller list applies to.",
      ...topUp(agent, 1n),
      expect: /AllowedCalldataEnforcer:invalid-calldata/,
    },
    {
      id: "X02-topup-to-attacker",
      title: "x402 top-up straight to the attacker",
      why: "A drain disguised as a top-up.",
      ...topUp(t.attacker, 1n),
      expect: /AllowedCalldataEnforcer:invalid-calldata/,
    },
    {
      id: "X03-topup-over-cap",
      title: "x402 top-up one unit above the cap",
      why: "Top-ups only ever cover one payment.",
      ...topUp(x.vault, x.perTx + 1n),
      expect: /ERC20PerTransferCapEnforcer:amount-exceeded/,
    },
    {
      id: "X04-vault-pays-attacker",
      title: "Agent signs a vault payment to the attacker",
      why: "The seller list is the point of the vault.",
      from: t.attacker,
      to: t.token,
      data: await authorize("TransferWithAuthorization", t.attacker, 1n),
      expect: /invalid signature/,
    },
    {
      id: "X05-vault-over-cap",
      title: "Agent signs a vault payment above the cap to the listed seller",
      why: "Per-payment cap of the vault.",
      from: t.attacker,
      to: t.token,
      data: await authorize("TransferWithAuthorization", x.seller, x.perTx + 1n),
      expect: /invalid signature/,
    },
    {
      id: "X06-stranger-signs",
      title: "A key other than the agent's signs a vault payment to the seller",
      why: "Only the agent may spend from the vault.",
      from: t.attacker,
      to: t.token,
      data: await authorize("TransferWithAuthorization", x.seller, 1n, stranger),
      expect: /invalid signature/,
    },
    {
      id: "X07-receive-with-authorization",
      title: "receiveWithAuthorization from the vault (the attacker as receiver)",
      why: "A second EIP-3009 entry point the vault must not approve.",
      from: t.attacker,
      to: t.token,
      data: await authorize("ReceiveWithAuthorization", t.attacker, 1n),
      expect: /invalid signature/,
    },
    {
      id: "X08-permit",
      title: "Agent signs an EIP-2612 permit for the attacker on the vault's USDC",
      why: "An allowance would let the attacker pull the vault empty.",
      from: t.attacker,
      to: t.token,
      data: encodeFunctionData({
        abi: usdcAbi,
        functionName: "permit",
        args: [x.vault, t.attacker, maxUint256, validBefore, permitSig],
      }),
      expect: /invalid signature/,
    },
  ];
}

const authorizationFields = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

/** Runs one probe as an eth_call. */
export async function runProbe(client: PublicClient, p: Probe): Promise<ProbeResult> {
  let ok = false;
  let reason = "";
  try {
    await client.call({ account: p.from, to: p.to, data: p.data, value: p.value });
    ok = true;
  } catch (e) {
    reason = revertReason(e);
  }
  const verdict = p.expect === null ? (ok ? "allowed" : "FAIL") : !ok && p.expect.test(reason) ? "blocked" : "FAIL";
  return { ...p, ok, reason, verdict };
}

/** Runs the whole catalog. `inconclusive` = a positive control failed, so "blocked" results prove nothing. */
export async function runAttackSuite(client: PublicClient, target: AttackTarget) {
  const now = Number((await client.getBlock()).timestamp);
  const results = [];
  for (const p of await buildAttacks(target, now)) results.push(await runProbe(client, p));
  const controls = results.filter((r) => r.expect === null);
  const attacks = results.filter((r) => r.expect !== null);
  return {
    results,
    inconclusive: controls.some((r) => !r.ok),
    holes: attacks.filter((r) => r.ok),
    wrongReason: attacks.filter((r) => !r.ok && r.verdict === "FAIL"),
  };
}
