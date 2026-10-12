import {
  getAddress,
  hashTypedData,
  isHex,
  decodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
export const DAPP_CHAIN = "0x14a34";
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
export function originOf(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 300 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new RpcError(4100, "Invalid website origin");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new RpcError(4100, "Invalid website origin");
  }
  if (
    u.origin !== value ||
    u.username ||
    u.password ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
    )
  )
    throw new RpcError(4100, "Use an exact HTTPS or localhost origin");
  return u.origin;
}
export function rpcParams(p: unknown): unknown[] {
  if (Array.isArray(p)) return p;
  if (p && typeof p === "object") return [p];
  throw new RpcError(-32602, "Parameters must be an array or object");
}
export function address(v: unknown): Address {
  try {
    if (typeof v !== "string") throw Error();
    return getAddress(v);
  } catch {
    throw new RpcError(-32602, "Invalid address");
  }
}
export function hex(v: unknown, max = 32768): Hex {
  if (
    typeof v !== "string" ||
    !isHex(v, { strict: true }) ||
    v.length % 2 !== 0 ||
    v.length > max
  )
    throw new RpcError(-32602, "Malformed hex data");
  return v;
}
export function quantity(v: unknown): bigint {
  if (
    typeof v !== "string" ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v) ||
    v.length > 66
  )
    throw new RpcError(-32602, "Invalid hex quantity");
  return BigInt(v);
}
export function transaction(p: unknown[], user: Address) {
  if (
    p.length !== 1 ||
    !p[0] ||
    typeof p[0] !== "object" ||
    Array.isArray(p[0])
  )
    throw new RpcError(-32602, "One transaction is required");
  const t = p[0] as Record<string, unknown>;
  if (
    Object.keys(t).some(
      (k) => !["from", "to", "value", "data", "chainId"].includes(k),
    )
  )
    throw new RpcError(
      -32602,
      "Unsupported transaction field; wallet selects nonce and fees",
    );
  if (address(t.from) !== user)
    throw new RpcError(4100, "Sender must be the connected account");
  if (t.chainId !== undefined && quantity(t.chainId) !== 84532n)
    throw new RpcError(4901, "Base Sepolia only");
  const value = t.value === undefined ? 0n : quantity(t.value);
  if (value > 1000000000000000n)
    throw new RpcError(-32602, "Phase 2 value limit is 0.001 test ETH");
  return {
    to: address(t.to),
    data: hex(t.data ?? "0x"),
    value: value.toString(),
  };
}
export function message(p: unknown[], user: Address) {
  if (p.length !== 2 || address(p[1]) !== user)
    throw new RpcError(4100, "Message account mismatch");
  return hex(p[0], 8194);
}
export function typedMessage(p: unknown[], user: Address) {
  if (
    p.length !== 2 ||
    address(p[0]) !== user ||
    typeof p[1] !== "string" ||
    p[1].length > 16000
  )
    throw new RpcError(-32602, "Invalid typed data");
  let t: any;
  try {
    t = JSON.parse(p[1]);
    if (
      !t ||
      typeof t !== "object" ||
      BigInt(t.domain?.chainId) !== 84532n ||
      !t.primaryType ||
      t.primaryType === "EIP712Domain" ||
      !t.types ||
      !t.message
    )
      throw Error();
    address(t.domain.verifyingContract);
    hashTypedData(t);
  } catch {
    throw new RpcError(
      -32602,
      "Typed data needs a valid Base Sepolia domain and verifying contract",
    );
  }
  return t;
}
export function describeCall(data: Hex) {
  const common = parseAbi([
    "function approve(address spender,uint256 amount)",
    "function setApprovalForAll(address operator,bool approved)",
    "function transfer(address to,uint256 amount)",
    "function record(bytes32 note)",
  ]);
  if (data === "0x")
    return {
      method: "Native transfer",
      warning: "Public EVM transfer. Verify the recipient.",
    };
  try {
    const d = decodeFunctionData({ abi: common, data });
    return {
      method: `${d.functionName}(${d.args.map(String).join(", ")})`,
      warning: ["approve", "setApprovalForAll"].includes(d.functionName)
        ? "TOKEN SPENDING PERMISSION: the spender/operator may move your assets. Verify its address and limits."
        : "Decoded selector only; the destination contract can behave differently.",
    };
  } catch {
    return {
      method: "Unknown contract interaction",
      warning:
        "Undecoded calldata. The contract may transfer assets or change permissions. Review every byte.",
    };
  }
}
