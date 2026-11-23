# contracts

Foundry project for cyphos-guard's own contracts, built against MetaMask Delegation Framework **v1.3.0** (git
submodule, the version deployed on Base Sepolia).

- `src/CosignerEnforcer.sol`: requires a fresh co-signer signature per redemption (see ADR 0005)
- `src/ERC20PerTransferCapEnforcer.sol`: stateless cap on every single ERC-20 `transfer` under a delegation; pins
  single-call mode, target, selector and calldata length (see ADR 0006)
- `src/X402Vault.sol`: ERC-1271 payer for x402 that only approves USDC payments to listed sellers, up to a cap, signed
  by the agent ([security review](../../docs/security/x402-vault-review.md); experimental, not audited)
- `pnpm --filter @cyphos-guard/contracts build`: `forge build` + export ABI/bytecode to `generated/` (committed, used by the SDK)
- `pnpm --filter @cyphos-guard/contracts test`: Foundry tests

After cloning: `git submodule update --init --recursive`.
