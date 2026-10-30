import { RpcError, address, hex, quantity } from "./dapp-policy.ts";
export const READ_METHODS = [
  "net_version",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_call",
  "eth_estimateGas",
  "eth_getTransactionReceipt",
];
const block = (v: unknown) => {
  if (
    ["latest", "pending", "safe", "finalized", "earliest"].includes(String(v))
  )
    return v;
  quantity(v);
  return v;
};
// Public RPC reads only, bounded arguments; no custom endpoints or state overrides.
export function readParams(method: string, p: unknown[]) {
  if (["net_version", "eth_blockNumber"].includes(method)) {
    if (p.length) throw new RpcError(-32602, "No parameters");
    return [];
  }
  if (["eth_getBalance", "eth_getCode"].includes(method)) {
    if (p.length < 1 || p.length > 2)
      throw new RpcError(-32602, "Address and optional block required");
    return [address(p[0]), block(p[1] ?? "latest")];
  }
  if (method === "eth_getTransactionReceipt") {
    if (
      p.length !== 1 ||
      typeof p[0] !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(p[0])
    )
      throw new RpcError(-32602, "Transaction hash required");
    return p;
  }
  if (
    !["eth_call", "eth_estimateGas"].includes(method) ||
    p.length < 1 ||
    p.length > 2 ||
    !p[0] ||
    typeof p[0] !== "object" ||
    Array.isArray(p[0])
  )
    throw new RpcError(-32602, "Invalid read request");
  const t = p[0] as Record<string, unknown>;
  if (
    Object.keys(t).some(
      (k) => !["to", "from", "value", "data", "gas"].includes(k),
    )
  )
    throw new RpcError(-32602, "Unsupported call field");
  const call: Record<string, unknown> = { to: address(t.to) };
  if (t.from !== undefined) call.from = address(t.from);
  if (t.data !== undefined) call.data = hex(t.data, 16000);
  if (t.value !== undefined) {
    quantity(t.value);
    call.value = t.value;
  }
  if (t.gas !== undefined) {
    if (quantity(t.gas) > 5000000n)
      throw new RpcError(-32602, "Read gas limit exceeded");
    call.gas = t.gas;
  }
  return [call, block(p[1] ?? "latest")];
}
