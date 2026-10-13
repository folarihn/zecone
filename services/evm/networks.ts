import { defineChain, type Address } from "viem";

export const NETWORK_IDS = [84532, 11155111, 46630] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];
export type Network = {
  id: NetworkId; name: string; rpc: string; explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: 18 };
  confirmations: number; feeModel: "op-stack" | "ethereum" | "nitro";
  gasBudget: bigint; maxFee: bigint; maxGas: bigint; dataReserve: bigint;
  adapter: string; deploymentFile: string; liquidityKey: string;
  availability: "configured"; features: readonly string[];
  tokens: readonly { address: Address; symbol: string; decimals: number }[];
};
const currency = Object.freeze({ name: "Test Ether", symbol: "ETH", decimals: 18 as const });
const common = { nativeCurrency: currency, availability: "configured" as const,
  liquidityKey: "local-provider", features: Object.freeze(["native", "erc20-allowlist", "known-erc721", "eip1193", "marketplace"]), tokens: Object.freeze([]) };
const registry: Record<NetworkId, Network> = {
  84532: { ...common, id: 84532, name: "Base Sepolia", rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", confirmations: 3, feeModel: "op-stack", gasBudget: 100000000000000n, maxFee: 100000000n, maxGas: 600000n, dataReserve: 40000000000000n, adapter: "base-sepolia-v1", deploymentFile: ".state/marketplace-confirmed.json" },
  11155111: { ...common, id: 11155111, name: "Ethereum Sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io", confirmations: 12, feeModel: "ethereum", gasBudget: 500000000000000n, maxFee: 10000000000n, maxGas: 2000000n, dataReserve: 0n, adapter: "ethereum-sepolia-v2", deploymentFile: ".state/marketplace-11155111-confirmed.json" },
  46630: { ...common, id: 46630, name: "Robinhood Chain Testnet", rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com", confirmations: 20, feeModel: "nitro", gasBudget: 200000000000000n, maxFee: 1000000000n, maxGas: 5000000n, dataReserve: 0n, adapter: "robinhood-testnet-v2", deploymentFile: ".state/marketplace-46630-confirmed.json" },
};
for (const n of Object.values(registry)) Object.freeze(n);
Object.freeze(registry);
export function network(id: unknown): Network {
  if (typeof id !== "number" || !NETWORK_IDS.includes(id as NetworkId)) throw Error("unsupported_testnet");
  return registry[id as NetworkId];
}
export function chainFor(id: number) {
  const n = network(id);
  return defineChain({ id: n.id, name: n.name, testnet: true, nativeCurrency: n.nativeCurrency,
    rpcUrls: { default: { http: [n.rpc] } }, blockExplorers: { default: { name: n.name, url: n.explorer } } });
}
export function chainHex(id: number) { return `0x${network(id).id.toString(16)}`; }
export function parseChain(value: unknown) {
  if (typeof value !== "string" || !/^0x[1-9a-f][0-9a-f]*$/.test(value)) throw Error("invalid_chain_id");
  return network(Number(BigInt(value)));
}
export function validateAddChain(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_chain_configuration");
  const v = value as Record<string, any>, n = parseChain(v.chainId);
  if (Object.keys(v).some(k => !["chainId", "chainName", "rpcUrls", "blockExplorerUrls", "nativeCurrency"].includes(k)) ||
    v.chainName !== n.name || JSON.stringify(v.rpcUrls) !== JSON.stringify([n.rpc]) ||
    JSON.stringify(v.blockExplorerUrls) !== JSON.stringify([n.explorer]) ||
    !v.nativeCurrency || Object.keys(v.nativeCurrency).length !== 3 ||
    v.nativeCurrency.name !== n.nativeCurrency.name || v.nativeCurrency.symbol !== "ETH" || v.nativeCurrency.decimals !== 18)
    throw Error("untrusted_chain_configuration");
  return n;
}
