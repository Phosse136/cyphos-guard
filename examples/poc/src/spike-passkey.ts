/**
 * Phase 2 spike (ADR 0001 open risk #2): can a *passkey* owner of a Hybrid account
 *   a) sign a delegation that the DelegationManager accepts (EIP-712 → WebAuthn → isValidSignature)?
 *   b) sign a one-shot approval that works exactly once and only for the pinned call?
 *   c) sign a userOp (revoke) that the EntryPoint accepts?
 * Runs on a local fork with a software authenticator (same bytes a real authenticator produces).
 */
import { getSmartAccountsEnvironment, Implementation, toMetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import {
  buildApprovalDelegation,
  deployAccount,
  encodeRedeem,
  executeAsOwner,
  revertReason,
  revokeCall,
} from "@phoswallet/sdk";
import { createSoftPasskey, ensureFork } from "@phoswallet/sdk/testing";
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type PublicClient,
  parseEther,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const chain: Chain = baseSepolia;
const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";
await ensureFork(FORK, process.env.RPC_URL || "https://sepolia.base.org");

const publicClient: PublicClient = createPublicClient({ chain, transport: http(FORK) });
const setBalance = (a: `0x${string}`, eth: string) =>
  publicClient.request({ method: "anvil_setBalance" as never, params: [a, toHex(parseEther(eth))] as never });

// Recovery EOA (deploys + relays userOps here; never signs for the account in this spike) and agent.
const relayer = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const relayerWallet = createWalletClient({ account: relayer, chain, transport: http(FORK) });
const agentWallet = createWalletClient({ account: agent, chain, transport: http(FORK) });
await setBalance(relayer.address, "1");
await setBalance(agent.address, "1");
const env = getSmartAccountsEnvironment(chain.id);

const passkey = createSoftPasskey();
// keyId must be the SAME string at deploy time and signing time (the kit hashes it as a string).
const keyId = toHex(passkey.credentialId);
const account = await toMetaMaskSmartAccount({
  client: publicClient,
  implementation: Implementation.Hybrid,
  // EOA owner = zero address: the passkey is the ONLY signer, so every signature below must be WebAuthn.
  deployParams: ["0x0000000000000000000000000000000000000000", [keyId], [passkey.x], [passkey.y]],
  deploySalt: keccak256(toHex(passkey.credentialId)),
  signer: { webAuthnAccount: passkey.account, keyId },
});
await deployAccount(account, relayerWallet, publicClient);
await setBalance(account.address, "0.01");
console.log(`passkey-only Hybrid account deployed at ${account.address}`);

const results: [string, boolean, string][] = [];
const tryRedeem = async (delegation: Parameters<typeof encodeRedeem>[0], to: `0x${string}`, value: bigint) => {
  const data = encodeRedeem(delegation, { to, value });
  try {
    await publicClient.call({ account: agent, to: env.DelegationManager, data });
  } catch (e) {
    return { ok: false, reason: revertReason(e) };
  }
  const hash = await agentWallet.sendTransaction({ to: env.DelegationManager, data });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  return { ok: r.status === "success", reason: r.status };
};

// (b) one-shot approval, signed by the passkey
const payee = privateKeyToAddress(generatePrivateKey());
const now = Number((await publicClient.getBlock()).timestamp);
const unsigned = buildApprovalDelegation({
  environment: env,
  delegator: account.address,
  agent: agent.address,
  execution: { to: payee, value: parseEther("0.002") },
  expiresAt: now + 900,
});
const approval = { ...unsigned, signature: await account.signDelegation({ delegation: unsigned }) };

let r = await tryRedeem(approval, payee, parseEther("0.002"));
results.push(["a+b) passkey-signed approval redeems for the pinned call", r.ok, r.reason]);
r = await tryRedeem(approval, payee, parseEther("0.002"));
results.push(["b) same approval cannot be replayed", !r.ok, r.reason]);

// fresh approval, then try a different amount / recipient
const unsigned2 = buildApprovalDelegation({
  environment: env,
  delegator: account.address,
  agent: agent.address,
  execution: { to: payee, value: parseEther("0.001") },
  expiresAt: now + 900,
});
const approval2 = { ...unsigned2, signature: await account.signDelegation({ delegation: unsigned2 }) };
r = await tryRedeem(approval2, payee, parseEther("0.003"));
results.push(["b) approval cannot be used for a bigger amount", !r.ok, r.reason]);
r = await tryRedeem(approval2, privateKeyToAddress(generatePrivateKey()), parseEther("0.001"));
results.push(["b) approval cannot be used for another recipient", !r.ok, r.reason]);

// tampered signature must fail
// Flip one byte of `r` (ABI word 2: keyIdHash, r, s, ...). Note: the encoding ends in zero padding, so
// tampering the *last* bytes would not change the signature's meaning at all.
const sig = approval2.signature;
const at = 2 + 64 + 10;
const flipped = (Number.parseInt(sig.slice(at, at + 2), 16) ^ 0xff).toString(16).padStart(2, "0");
const tampered = { ...approval2, signature: `${sig.slice(0, at)}${flipped}${sig.slice(at + 2)}` as `0x${string}` };
r = await tryRedeem(tampered, payee, parseEther("0.001"));
results.push(["a) tampered passkey signature is rejected", !r.ok, r.reason]);

// (c) passkey-signed userOp: revoke approval2, then it must not redeem
let revoked = true;
let revokeErr = "";
try {
  await executeAsOwner(account, relayerWallet, publicClient, [revokeCall(env, approval2)]);
} catch (e) {
  revoked = false;
  revokeErr = revertReason(e);
}
results.push(["c) passkey-signed userOp (disableDelegation) accepted by EntryPoint", revoked, revokeErr]);
r = await tryRedeem(approval2, payee, parseEther("0.001"));
results.push(["c) revoked approval no longer redeems", !r.ok, r.reason]);

for (const [label, pass, detail] of results)
  console.log(`${pass ? "✔" : "✘ FAIL"} ${label}${detail ? `  [${detail}]` : ""}`);
const failed = results.filter(([, p]) => !p).length;
console.log(
  failed
    ? `\n${failed} spike check(s) FAILED`
    : "\nSpike passed: passkey signing works for delegations, approvals and userOps.",
);
process.exit(failed ? 1 : 0);
