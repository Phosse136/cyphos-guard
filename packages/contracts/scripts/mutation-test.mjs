#!/usr/bin/env node
// Mutation test: plants one known bug at a time in the contracts and checks that the test suite (forge tests,
// plus the Halmos proofs when `halmos` is on PATH) FAILS for every one of them. A mutant that survives means a
// security check nothing would notice losing. Restores each file afterwards, also on Ctrl-C.
//
//   node scripts/mutation-test.mjs            # all mutants
//   node scripts/mutation-test.mjs vault-     # only mutants whose id starts with "vault-"
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAP = "src/ERC20PerTransferCapEnforcer.sol";
const VAULT = "src/X402Vault.sol";
const COSIGN = "src/CosignerEnforcer.sol";

/** [id, file, exact text, replacement]: each a check an attacker would love to see gone. */
const MUTANTS = [
  ["cap-off-by-one", CAP, "<= maxAmount_", "<= maxAmount_ + 1"],
  ["cap-amount-wrong-word", CAP, "callData_[36:68]", "callData_[4:36]"],
  ["cap-any-target", CAP, "target_ == token_", "target_ != address(0) || true"],
  ["cap-value-allowed", CAP, "value_ == 0", "value_ >= 0"],
  ["cap-longer-calldata", CAP, "callData_.length == 68", "callData_.length >= 68"],
  ["cap-any-selector", CAP, "== IERC20.transfer.selector", "!= bytes4(0xffffffff)"],
  ["cap-batch-mode", CAP, "        onlySingleCallTypeMode(_mode)\n", ""],
  ["cap-try-mode", CAP, "        onlyDefaultExecutionMode(_mode)\n", ""],
  ["cap-terms-length", CAP, "_terms.length == 52", "_terms.length >= 52"],
  ["vault-any-seller", VAULT, "!isSeller[to] || ", ""],
  ["vault-zero-value", VAULT, "value == 0 || ", ""],
  ["vault-cap-off-by-one", VAULT, "value > maxPerPayment", "value > maxPerPayment + 1"],
  ["vault-any-hash", VAULT, "if (digest != hash) return INVALID;", ""],
  ["vault-any-signer", VAULT, "signer != agent", "signer == address(0)"],
  ["vault-recover-error-ignored", VAULT, "err != ECDSA.RecoverError.NoError || ", ""],
  ["vault-open-setSeller", VAULT, "bool allowed) external onlyOwner", "bool allowed) external"],
  ["vault-open-withdraw", VAULT, "uint256 amount) external onlyOwner", "uint256 amount) external"],
  ["vault-sig-length", VAULT, "disabled || signature.length < 32 * 7 + 96", "disabled"],
  ["vault-disable-ignored", VAULT, "if (disabled || ", "if ("],
  ["vault-open-disable", VAULT, "function disable() external onlyOwner", "function disable() external"],
  ["cosign-no-deadline", COSIGN, "block.timestamp <= deadline_", "true"],
  [
    "cosign-replay-check",
    COSIGN,
    "require(!usedCosignatures[msg.sender][digest_]",
    "require(true || !usedCosignatures[msg.sender][digest_]",
  ],
  ["cosign-not-consumed", COSIGN, "usedCosignatures[msg.sender][digest_] = true;", ""],
  ["cosign-any-signer", COSIGN, "recovered_ == cosigner_", "recovered_ != address(0)"],
  ["cosign-any-execution", COSIGN, "keccak256(_executionCallData), salt_", "bytes32(0), salt_"],
  ["cosign-any-redeemer", COSIGN, "_delegationHash, _redeemer, keccak256", "_delegationHash, address(0), keccak256"],
  [
    "cosign-any-delegation",
    COSIGN,
    "getCosignDigest(msg.sender, _delegationHash,",
    "getCosignDigest(msg.sender, bytes32(0),",
  ],
  ["cosign-batch-mode", COSIGN, "        onlySingleCallTypeMode(_mode)\n", ""],
];

const only = process.argv[2];
const halmos = spawnSync("halmos", ["--version"], { encoding: "utf8" }).status === 0;
const env = { ...process.env, FOUNDRY_INVARIANT_RUNS: "32", FOUNDRY_DYNAMIC_TEST_LINKING: "false" };
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, env, encoding: "utf8" }).status === 0;
const suitePasses = () =>
  run("forge", ["test"]) &&
  (!halmos || run("halmos", ["--contract", "SymbolicProofs", "--default-bytes-lengths", "0,4,52,65,67,68,69,100"]));

if (!suitePasses()) {
  console.error("The unmutated suite fails; fix that first.");
  process.exit(1);
}
console.log(`baseline green${halmos ? " (forge + halmos)" : " (forge only; halmos not on PATH)"}`);

let restore = null;
process.on("SIGINT", () => {
  restore?.();
  process.exit(130);
});

const survived = [];
for (const [id, file, from, to] of MUTANTS) {
  if (only && !id.startsWith(only)) continue;
  const path = join(root, file);
  const original = readFileSync(path, "utf8");
  if (original.split(from).length !== 2) throw new Error(`${id}: pattern not found exactly once in ${file}`);
  restore = () => writeFileSync(path, original);
  writeFileSync(path, original.replace(from, to));
  try {
    const compiles = run("forge", ["build"]);
    const killed = !compiles || !suitePasses();
    console.log(`${killed ? "killed  " : "SURVIVED"}  ${id}${compiles ? "" : " (does not compile)"}`);
    if (!killed) survived.push(id);
  } finally {
    restore();
    restore = null;
  }
}
if (survived.length) {
  console.error(`\n${survived.length} mutant(s) survived: ${survived.join(", ")}`);
  process.exit(1);
}
console.log("\nall mutants killed");
