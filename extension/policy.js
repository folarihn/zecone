// Public policy, imported by the worker. No wallet credentials.
export const ORIGINS = ["https://opensea.io", "https://www.opensea.io"];
export const CHAINS = ["0x14a34", "0xaa36a7", "0xb626"];
export const METHODS = [
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "wallet_revokePermissions",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
];
export const idValid = (id) =>
  typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
export const accountsValid = (a) =>
  Array.isArray(a) &&
  a.length <= 1 &&
  a.every((v) => typeof v === "string" && /^0x[\da-f]{40}$/i.test(v));
export function senderOrigin(sender, extensionId) {
  if (
    sender?.id !== extensionId ||
    sender.frameId !== 0 ||
    !Number.isInteger(sender.tab?.id) ||
    !sender.documentId
  )
    throw Error("Untrusted extension sender");
  const origin = new URL(sender.url).origin;
  if (!ORIGINS.includes(origin) || sender.origin !== origin)
    throw Error("Unsupported website origin");
  return origin;
}
export function validateRequest(m) {
  if (
    !m ||
    typeof m !== "object" ||
    Array.isArray(m) ||
    Object.keys(m).some(
      (k) => !["kind", "id", "method", "params"].includes(k),
    ) ||
    m.kind !== "request" ||
    !idValid(m.id) ||
    !Array.isArray(m.params) ||
    JSON.stringify(m).length > 17000
  )
    throw Object.assign(Error("Invalid wallet request"), { code: -32602 });
  if (!METHODS.includes(m.method))
    throw Object.assign(Error("Unsupported wallet method"), { code: 4200 });
  if (
    ["wallet_switchEthereumChain", "wallet_addEthereumChain"].includes(
      m.method,
    ) &&
    !CHAINS.includes(m.params[0]?.chainId?.toLowerCase())
  )
    throw Object.assign(Error("Only configured testnets are supported"), {
      code: 4901,
    });
  if (
    m.method === "eth_sendTransaction" &&
    m.params[0]?.chainId !== undefined &&
    !CHAINS.includes(m.params[0].chainId?.toLowerCase())
  )
    throw Object.assign(Error("Mainnet transactions are blocked"), {
      code: 4901,
    });
}
