# Releasing to npm

The publishable packages are `@cyphos-guard/shared`, `contracts`, `sdk`, `mcp` and `cli`. Inside the monorepo they
point at their TypeScript sources; `publishConfig` switches them to the compiled `dist/` on publish. **0.1.0 was published on
2026-11-21** (npm org `cyphos-guard`, MCP Registry `io.github.Phosse136/cyphos-guard`, `packages/mcp/server.json`). 2026-11-23: contracts 0.2.0, shared 0.1.1, sdk 0.2.0, mcp 0.1.2 (per-payment cap
on-chain, ADR 0006); cli stays 0.1.0. Only bump the packages that changed.

Verified (2026-11-21): packed tarballs installed with plain `npm` into an empty project; the SDK made a signed
request against the public instance and compiled a policy, `npx cyphos-guard agent new` created a key file (mode
600), `npx cyphos-guard-mcp` started over stdio and listed its tools, and a consumer TypeScript project typechecked
with zero errors in our type files.

## Steps

1. npm account with 2FA; create the npm **organization `cyphos-guard`** (for the `@cyphos-guard/*` scope).
2. Bump the version in the changed `package.json` files and in `packages/mcp/server.json` (both `version` fields).
3. `pnpm build:packages`
4. Dry run: `pnpm -r --filter "./packages/*" publish --dry-run --access public --no-git-checks`
5. Publish: `pnpm -r --filter "./packages/*" publish --access public` (pnpm replaces `workspace:*` with the versions).
6. MCP Registry: add `"mcpName": "io.github.<github-user>/cyphos-guard"` to `packages/mcp/package.json` before step 5,
   then `mcp-publisher init` → edit `server.json` (npm package, transport stdio, env vars
   `CYPHOS_AGENT_PRIVATE_KEY`, `CYPHOS_POLICY_SERVICE_URL`, `NETWORK`) → `mcp-publisher login github` →
   `mcp-publisher publish`. See https://modelcontextprotocol.io/registry/quickstart

Notes: consumers see an npm deprecation warning for `uuid@9` via `@metamask/utils` (MetaMask's dependency; our
override only applies inside the repo). MetaMask's own `.d.ts` has one error under `skipLibCheck: false` (TS 5.9);
most projects use `skipLibCheck: true`.

Publishing with a passkey as npm 2FA: run the publish in a real terminal (npm prints a browser link per package), e.g.
`pnpm pack` each package and `npm publish ./<tarball> --access public`. New packages show a `0.0.0-stage` placeholder
for a few minutes while npm processes them.
