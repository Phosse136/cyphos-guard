/**
 * Browser-side wallet logic. Everything that needs the owner's authority happens HERE, signed by the
 * passkey via navigator.credentials.get: the server never sees a key and never constructs what we sign.
 */
import {
  type Delegation,
  getSmartAccountsEnvironment,
  Implementation,
  type MetaMaskSmartAccount,
  toMetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import { buildUserOp, userOpToJSON } from "@phoswallet/sdk";
import {
  type Address,
  type Chain,
  createPublicClient,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  toHex,
  zeroAddress,
} from "viem";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import { api, type Me } from "./api";

export const chain: Chain = baseSepolia;
export const environment = getSmartAccountsEnvironment(chain.id);

let client: PublicClient | undefined;
export function publicClient(): PublicClient {
  // Proxied through Next (/rpc) so the browser never needs CORS against the node.
  client ??= createPublicClient({ chain, transport: http(`${window.location.origin}/rpc`) });
  return client;
}

type Owner = NonNullable<Me["owner"]>;

function passkeySigner(owner: Owner) {
  const pubKey = `0x04${owner.x.slice(2).padStart(64, "0")}${owner.y.slice(2).padStart(64, "0")}` as Hex;
  return {
    webAuthnAccount: toWebAuthnAccount({
      credential: { id: owner.credentialId, publicKey: pubKey },
      rpId: window.location.hostname,
    }),
    keyId: owner.keyId,
  };
}

/** Counterfactual account for a freshly registered passkey (+ optional recovery EOA). */
export function newAccount(owner: Owner, recovery: Address | null) {
  return toMetaMaskSmartAccount({
    client: publicClient(),
    implementation: Implementation.Hybrid,
    deployParams: [recovery ?? zeroAddress, [owner.keyId], [BigInt(owner.x)], [BigInt(owner.y)]],
    deploySalt: keccak256(toHex(owner.credentialId)),
    signer: passkeySigner(owner),
  });
}

/** The owner's linked, deployed account. */
export function linkedAccount(owner: Owner & { accountAddress: Address }) {
  return toMetaMaskSmartAccount({
    client: publicClient(),
    implementation: Implementation.Hybrid,
    address: owner.accountAddress,
    signer: passkeySigner(owner),
  });
}

export async function signDelegation(account: MetaMaskSmartAccount, delegation: Omit<Delegation, "signature">) {
  return { ...delegation, signature: await account.signDelegation({ delegation }) };
}

/**
 * Send owner calls as a passkey-signed userOp. Fork: the policy service's dev relay submits it
 * (it can't alter a signed op). Live: a public ERC-4337 bundler (Pimlico by default).
 */
export async function sendOwnerCalls(
  account: MetaMaskSmartAccount,
  fork: boolean,
  calls: { to: Address; data?: Hex; value?: bigint }[],
) {
  if (fork) {
    const op = await buildUserOp(account, publicClient(), calls);
    op.signature = await account.signUserOperation({ ...op, chainId: chain.id });
    return (await api.devRelay(userOpToJSON(op))).txHash;
  }
  const bundlerUrl = process.env.NEXT_PUBLIC_BUNDLER_URL ?? "https://public.pimlico.io/v2/84532/rpc";
  const bundler = createBundlerClient({ account, client: publicClient(), transport: http(bundlerUrl) });
  const hash = await bundler.sendUserOperation({ calls });
  const receipt = await bundler.waitForUserOperationReceipt({ hash });
  if (!receipt.success) throw new Error(`userOp failed (${hash})`);
  return receipt.receipt.transactionHash;
}
