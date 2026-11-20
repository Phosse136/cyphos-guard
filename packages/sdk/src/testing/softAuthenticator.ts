/**
 * Software WebAuthn authenticator for tests and scripts (NOT for real use: the key lives in memory).
 *
 * Produces exactly what a platform authenticator returns from navigator.credentials.get():
 * authenticatorData = sha256(rpId) ‖ flags(UP|UV) ‖ signCount, clientDataJSON with the base64url
 * challenge, and a DER ECDSA-P256 signature over authenticatorData ‖ sha256(clientDataJSON).
 * Plug it into viem's toWebAuthnAccount({ getFn }) to exercise the on-chain WebAuthn verifier
 * without a browser.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import type { Hex } from "viem";
import { toWebAuthnAccount, type WebAuthnAccount } from "viem/account-abstraction";

export type SoftPasskey = {
  credentialId: string;
  rpId: string;
  origin: string;
  /** Raw WebAuthn assertion for `challenge` (as navigator.credentials.get would return), for login flows. */
  assert(challenge: Uint8Array): { authenticatorData: Buffer; clientDataJSON: Buffer; signature: Buffer };
  /** Uncompressed public key 0x04‖x‖y. */
  publicKey: Hex;
  x: bigint;
  y: bigint;
  account: WebAuthnAccount;
};

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export function createSoftPasskey({ rpId = "localhost", origin = "http://localhost:3000" } = {}): SoftPasskey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const xHex = Buffer.from(jwk.x ?? "", "base64url").toString("hex");
  const yHex = Buffer.from(jwk.y ?? "", "base64url").toString("hex");
  const credentialId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const pub = `0x04${xHex}${yHex}` as Hex;
  let signCount = 0;

  const getFn = async (options?: { publicKey?: { challenge?: ArrayBuffer | Uint8Array } }) => {
    const challenge = options?.publicKey?.challenge;
    if (!challenge) throw new Error("no challenge");
    const challengeBytes = new Uint8Array(
      challenge instanceof ArrayBuffer ? challenge : (challenge as Uint8Array).buffer,
    );
    return assertion(privateKey, credentialId, rpId, origin, challengeBytes, ++signCount);
  };

  return {
    credentialId,
    rpId,
    origin,
    assert: (challenge) => {
      const a = assertion(privateKey, credentialId, rpId, origin, challenge, ++signCount).response;
      return {
        authenticatorData: Buffer.from(a.authenticatorData),
        clientDataJSON: Buffer.from(a.clientDataJSON),
        signature: Buffer.from(a.signature),
      };
    },
    publicKey: pub,
    x: BigInt(`0x${xHex}`),
    y: BigInt(`0x${yHex}`),
    account: toWebAuthnAccount({ credential: { id: credentialId, publicKey: pub }, getFn: getFn as never, rpId }),
  };
}

function assertion(key: KeyObject, id: string, rpId: string, origin: string, challenge: Uint8Array, count: number) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin, crossOrigin: false }),
  );
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(count);
  const authenticatorData = Buffer.concat([
    createHash("sha256").update(rpId).digest(),
    Buffer.from([0x05]), // UP | UV
    counter,
  ]);
  const signature = sign(
    "sha256",
    Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
    key, // DER encoding by default, like real authenticators
  );
  const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return {
    id,
    rawId: ab(Buffer.from(id, "base64url")),
    type: "public-key",
    response: {
      authenticatorData: ab(authenticatorData),
      clientDataJSON: ab(clientDataJSON),
      signature: ab(signature),
      userHandle: null,
    },
  };
}
