# Releasing to npm

The publishable packages are `@cyphos-guard/shared`, `contracts`, `sdk`, `mcp` and `cli`. Inside the monorepo they
point at their TypeScript sources; `publishConfig` switches them to the compiled `dist/` on publish. All are still
`"private": true`, so nothing can be published by accident.

Verified (2026-11-21): packed tarballs installed with plain `npm` into an empty project; the SDK made a signed
request against the public instance and compiled a policy, `npx cyphos-guard agent new` created a key file (mode
600), `npx cyphos-guard-mcp` started over stdio and listed its tools, and a consumer TypeScript project typechecked
with zero errors in our type files.

## Steps

1. npm account with 2FA; create the npm **organization `cyphos-guard`** (for the `@cyphos-guard/*` scope).
2. Set versions (e.g. `0.1.0`) in the five `package.json` files and remove `"private": true` from them.
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
