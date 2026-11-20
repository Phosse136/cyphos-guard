/**
 * Test helpers: WebAuthn registration/login JSON from a software passkey (same format the browser
 * sends via @simplewebauthn/browser), plus an agent-signed fetch. Used by unit tests and e2e scripts.
 */
import { createHash } from "node:crypto";
import type { SoftPasskey } from "@cyphos-guard/sdk/testing";
import { AGENT_HEADERS, agentAuthMessage } from "@cyphos-guard/shared";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { LocalAccount } from "viem";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export function registrationResponse(passkey: SoftPasskey, challenge: string) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.create", challenge, origin: passkey.origin, crossOrigin: false }),
  );
  const credId = Buffer.from(passkey.credentialId, "base64url");
  const coseKey = new Map<number, number | Uint8Array>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, Buffer.from(passkey.x.toString(16).padStart(64, "0"), "hex")],
    [-3, Buffer.from(passkey.y.toString(16).padStart(64, "0"), "hex")],
  ]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(credId.length);
  const authData = Buffer.concat([
    createHash("sha256").update(passkey.rpId).digest(),
    Buffer.from([0x45]), // UP | UV | AT
    Buffer.alloc(4), // signCount 0
    Buffer.alloc(16), // aaguid
    len,
    credId,
    Buffer.from(isoCBOR.encode(coseKey as never)),
  ]);
  const attestationObject = isoCBOR.encode(
    new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]) as never,
  );
  return {
    id: passkey.credentialId,
    rawId: passkey.credentialId,
    type: "public-key" as const,
    response: {
      clientDataJSON: b64(clientDataJSON),
      attestationObject: b64(attestationObject),
      transports: ["internal"],
    },
    clientExtensionResults: {},
  };
}

export function authenticationResponse(passkey: SoftPasskey, challenge: string) {
  const a = passkey.assert(Buffer.from(challenge, "base64url"));
  return {
    id: passkey.credentialId,
    rawId: passkey.credentialId,
    type: "public-key" as const,
    response: {
      clientDataJSON: b64(a.clientDataJSON),
      authenticatorData: b64(a.authenticatorData),
      signature: b64(a.signature),
    },
    clientExtensionResults: {},
  };
}

/** Builds headers + body for an agent-authenticated request. */
export async function agentRequest(agent: LocalAccount, method: string, path: string, body?: unknown) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const signature = await agent.signMessage({
    message: agentAuthMessage({ method, path, timestamp, nonce, body: text }),
  });
  return {
    method,
    headers: {
      "content-type": "application/json",
      [AGENT_HEADERS.agent]: agent.address,
      [AGENT_HEADERS.timestamp]: String(timestamp),
      [AGENT_HEADERS.signature]: signature,
      [AGENT_HEADERS.nonce]: nonce,
    },
    ...(text ? { body: text } : {}),
  };
}
