import { describe, expect, it } from "vitest";
import { RPC_MAX_BATCH, rpcRejection } from "./rpcGuard.ts";

const call = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });

describe("/rpc guard", () => {
  it("forwards the read-only calls the app uses", () => {
    for (const m of ["eth_chainId", "eth_call", "eth_getBalance", "eth_getTransactionReceipt", "eth_estimateGas"]) {
      expect(rpcRejection(call(m))).toBeNull();
    }
    expect(rpcRejection(JSON.stringify([JSON.parse(call("eth_call")), JSON.parse(call("eth_getCode"))]))).toBeNull();
  });

  it("refuses broadcasting, dev/admin methods, junk and oversized or huge batches", () => {
    expect(rpcRejection(call("eth_sendRawTransaction"))).toMatch(/not allowed/);
    expect(rpcRejection(call("anvil_setBalance"))).toMatch(/not allowed/);
    expect(rpcRejection(call("debug_traceTransaction"))).toMatch(/not allowed/);
    expect(rpcRejection("{not json")).toBe("invalid JSON");
    expect(rpcRejection(JSON.stringify(Array(RPC_MAX_BATCH + 1).fill(JSON.parse(call("eth_call")))))).toMatch(/batch/);
    expect(rpcRejection(" ".repeat(70_000))).toBe("request too large");
  });
});
