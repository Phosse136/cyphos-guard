# approver

Next.js owner app: passkey login, pending approvals, agents (grant / one-click revoke), activity.
Everything with owner authority is signed in the browser by the passkey. The server never builds what you sign.

- `pnpm dev` from the repo root starts fork + policy service + this app
- `pnpm e2e:browser` from the repo root: UI end-to-end in Chromium with a virtual WebAuthn authenticator
- Live mode: `NETWORK=live`; userOps go to `NEXT_PUBLIC_BUNDLER_URL` (Pimlico public endpoint by default)
