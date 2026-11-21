import { revokeCall } from "@cyphos-guard/sdk";
import { type Delegation, getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import {
  type Address,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  pad,
  parseAbi,
  parseEther,
  toHex,
} from "viem";
import { describe, expect, it } from "vitest";
import { decodeOwnerOp, describeOwnerOp, entryPointAbi, type OwnerCall, onlyRevokes } from "./ownerTx.ts";

const env = getSmartAccountsEnvironment(84532);
const ACCOUNT = "0x13fED70ad7b46E2c14bc418b7E7D32565bDf127A" as Address;
const OTHER = "0x5555555555555555555555555555555555555555" as Address;
const TO = "0x066A6dFC2ba90896ba22Ad6b4E9427f5aa7FFCF5" as Address;
const VAULT = "0x6563dDa8a8d1Daee0aCE8d17E460DbD01C548Fc0" as Address;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const executeAbi = parseAbi(["function execute(bytes32 mode, bytes executionCalldata)"]);

const single = (c: OwnerCall): Hex =>
  encodeFunctionData({
    abi: executeAbi,
    functionName: "execute",
    args: [pad("0x00", { dir: "right", size: 32 }), concat([c.to, toHex(c.value, { size: 32 }), c.data])],
  });
const batch = (calls: OwnerCall[]): Hex =>
  encodeFunctionData({
    abi: executeAbi,
    functionName: "execute",
    args: [
      pad("0x01", { dir: "right", size: 32 }),
      encodeAbiParameters(
        [{ type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
        [calls.map((c) => [c.to, c.value, c.data] as const)],
      ),
    ],
  });
const handleOps = (ops: { sender: Address; callData: Hex; initCode?: Hex }[]): Hex =>
  encodeFunctionData({
    abi: entryPointAbi,
    functionName: "handleOps",
    args: [
      ops.map((o) => ({
        sender: o.sender,
        nonce: 0n,
        initCode: o.initCode ?? "0x",
        callData: o.callData,
        accountGasLimits: pad("0x01"),
        preVerificationGas: 1n,
        gasFees: pad("0x01"),
        paymasterAndData: "0x" as Hex,
        signature: "0x" as Hex,
      })),
      OTHER,
    ],
  });
const describeInput = (input: Hex) => {
  const op = decodeOwnerOp(input, ACCOUNT);
  return op ? describeOwnerOp(op, ACCOUNT, env.DelegationManager) : null;
};

describe("owner tx decoding (from the handleOps input, never from the client)", () => {
  it("account creation: initCode + the no-op self-call", () => {
    const input = handleOps([
      { sender: ACCOUNT, callData: single({ to: ACCOUNT, value: 0n, data: "0x" }), initCode: "0x1234" },
    ]);
    expect(describeInput(input)).toEqual(["created the account"]);
  });

  it("sending ETH and USDC out (single and batch)", () => {
    expect(
      describeInput(
        handleOps([{ sender: ACCOUNT, callData: single({ to: TO, value: parseEther("0.01"), data: "0x" }) }]),
      ),
    ).toEqual(["sent 0.01 ETH → 0x066A…FCF5"]);
    const usdc = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TO, 2_500_000n] });
    expect(
      describeInput(
        handleOps([
          {
            sender: ACCOUNT,
            callData: batch([
              { to: USDC, value: 0n, data: usdc },
              { to: TO, value: parseEther("0.5"), data: "0x" },
            ]),
          },
        ]),
      ),
    ).toEqual(["sent 2.5 USDC → 0x066A…FCF5", "sent 0.5 ETH → 0x066A…FCF5"]);
  });

  it("recovery change, vault withdraw, vault deploy", () => {
    const transfer = encodeFunctionData({
      abi: parseAbi(["function transferOwnership(address)"]),
      functionName: "transferOwnership",
      args: [TO],
    });
    const withdraw = encodeFunctionData({
      abi: parseAbi(["function withdraw(address token, address to, uint256 amount)"]),
      functionName: "withdraw",
      args: [USDC, ACCOUNT, 1_000_000n],
    });
    const input = handleOps([
      {
        sender: ACCOUNT,
        callData: batch([
          { to: ACCOUNT, value: 0n, data: transfer },
          { to: VAULT, value: 0n, data: withdraw },
          { to: "0x4e59b44847b379578588920cA78FbF26c0B4956C", value: 0n, data: "0xabcdef" },
        ]),
      },
    ]);
    expect(describeInput(input)).toEqual([
      "changed the recovery address → 0x066A…FCF5",
      "withdrew 1 USDC from vault 0x6563…8Fc0 → 0x13fE…127A",
      "deployed an x402 vault",
    ]);
  });

  it("revokes are recognised (selector from MetaMask's own ABI) and not reported twice", () => {
    const data = revokeCall(env, {
      delegate: TO,
      delegator: ACCOUNT,
      authority: pad("0x00", { size: 32 }),
      caveats: [],
      salt: 1n,
      signature: "0x",
    } as unknown as Delegation).data;
    const op = decodeOwnerOp(
      handleOps([{ sender: ACCOUNT, callData: single({ to: env.DelegationManager, value: 0n, data }) }]),
      ACCOUNT,
    );
    expect(op && onlyRevokes(op, env.DelegationManager)).toBe(true);
    expect(op && describeOwnerOp(op, ACCOUNT, env.DelegationManager)).toEqual(["revoked a delegation"]);
  });

  it("the kit's real encodings: empty callData for the deploy op, execute(Execution) for one call", () => {
    const legacy = encodeFunctionData({
      abi: parseAbi(["function execute((address target, uint256 value, bytes callData) execution)"]),
      functionName: "execute",
      args: [{ target: TO, value: parseEther("0.2"), callData: "0x" }],
    });
    expect(legacy.slice(0, 10)).toBe("0x5c1c6dcd");
    expect(describeInput(handleOps([{ sender: ACCOUNT, callData: legacy }]))).toEqual(["sent 0.2 ETH → 0x066A…FCF5"]);
    const transfer = encodeFunctionData({
      abi: parseAbi(["function transferOwnership(address)"]),
      functionName: "transferOwnership",
      args: [TO],
    });
    // a lone self-call is sent as the raw callData
    expect(describeInput(handleOps([{ sender: ACCOUNT, callData: transfer }]))).toEqual([
      "changed the recovery address → 0x066A…FCF5",
    ]);
    expect(describeInput(handleOps([{ sender: ACCOUNT, callData: "0x", initCode: "0x12" }]))).toEqual([
      "created the account",
    ]);
  });

  it("ignores other senders' ops in the same bundle and garbage input", () => {
    const input = handleOps([{ sender: OTHER, callData: single({ to: TO, value: 1n, data: "0x" }) }]);
    expect(decodeOwnerOp(input, ACCOUNT)).toBeNull();
    expect(decodeOwnerOp("0xdeadbeef", ACCOUNT)).toBeNull();
    expect(describeInput(handleOps([{ sender: ACCOUNT, callData: "0x12345678" }]))).toEqual([
      "called 0x13fE…127A (0x12345678)",
    ]);
  });
});
