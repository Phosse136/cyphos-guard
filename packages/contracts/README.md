# contracts

Foundry project for cyphos-guard's own enforcer(s), built against MetaMask Delegation Framework **v1.3.0** (git
submodule, the version deployed on Base Sepolia).

- `src/CosignerEnforcer.sol`: requires a fresh co-signer signature per redemption (see ADR 0005)
- `pnpm --filter @cyphos-guard/contracts build`: `forge build` + export ABI/bytecode to `generated/` (committed, used by the SDK)
- `pnpm --filter @cyphos-guard/contracts test`: Foundry tests

After cloning: `git submodule update --init --recursive`.
