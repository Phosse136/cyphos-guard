/**
 * What the public /rpc proxy forwards: read-only JSON-RPC methods the approver (and the smart-account kit /
 * bundler client it uses) actually needs. Everything else, notably eth_sendRawTransaction and anvil_*, is refused,
 * so the proxy can't be used as a free relay or to broadcast transactions.
 */
export const RPC_ALLOWED_METHODS = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
]);
export const RPC_MAX_BODY_BYTES = 64 * 1024;
export const RPC_MAX_BATCH = 20;

/** null if the JSON-RPC body may be forwarded, else why not. */
export function rpcRejection(body: string): string | null {
  if (body.length > RPC_MAX_BODY_BYTES) return "request too large";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "invalid JSON";
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0 || calls.length > RPC_MAX_BATCH) return "invalid batch size";
  for (const call of calls) {
    const method = (call as { method?: unknown } | null)?.method;
    if (typeof method !== "string" || !RPC_ALLOWED_METHODS.has(method)) return `method not allowed: ${String(method)}`;
  }
  return null;
}
