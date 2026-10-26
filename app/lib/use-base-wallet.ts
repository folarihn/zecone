"use client";
// Minimal EIP-1193 Base wallet hook: connect, network detection, switching to
// Base (adding the chain when the wallet does not know it) and personal_sign.
// Connecting a Base wallet only identifies the merchant's payout address; it
// never grants ZecOne any spending authority.
import { useCallback, useEffect, useState } from "react";
import { getAddress, toHex } from "viem";

export const BASE_MAINNET = 8453;
export const BASE_SEPOLIA = 84532;

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

const CHAINS: Record<number, { chainName: string; rpcUrls: string[]; blockExplorerUrls: string[] }> = {
  [BASE_MAINNET]: { chainName: "Base", rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] },
  [BASE_SEPOLIA]: {
    chainName: "Base Sepolia",
    rpcUrls: ["https://sepolia.base.org"],
    blockExplorerUrls: ["https://sepolia.basescan.org"],
  },
};

export function injectedProvider(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
}

export function chainLabel(chainId: number | null): string | null {
  if (chainId === BASE_MAINNET) return "Base";
  if (chainId === BASE_SEPOLIA) return "Base Sepolia";
  if (chainId === null) return null;
  return `Unsupported network (${chainId})`;
}

export function useBaseWallet() {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const eth = injectedProvider();
    setAvailable(!!eth);
    if (!eth?.on) return;
    const onAccounts = (accounts: unknown) => {
      const list = accounts as string[];
      setAddress(list.length ? getAddress(list[0]) : null);
    };
    const onChain = (hex: unknown) => setChainId(Number(BigInt(hex as string)));
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    const eth = injectedProvider();
    if (!eth) {
      setError("No browser wallet found. Install Coinbase Wallet, MetaMask or another EVM wallet.");
      return null;
    }
    setBusy(true);
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const hex = (await eth.request({ method: "eth_chainId" })) as string;
      const a = getAddress(accounts[0]);
      setAddress(a);
      setChainId(Number(BigInt(hex)));
      return a;
    } catch (e) {
      setError(friendly(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const switchTo = useCallback(async (target: number = BASE_MAINNET) => {
    const eth = injectedProvider();
    if (!eth) return false;
    setError(null);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(target) }] });
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 4902 || code === -32603) {
        try {
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [{ chainId: toHex(target), nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, ...CHAINS[target] }],
          });
        } catch (e2) {
          setError(friendly(e2));
          return false;
        }
      } else {
        setError(friendly(e));
        return false;
      }
    }
    const hex = (await eth.request({ method: "eth_chainId" })) as string;
    setChainId(Number(BigInt(hex)));
    return Number(BigInt(hex)) === target;
  }, []);

  const signMessage = useCallback(
    // `from` avoids a stale closure when connect() and signMessage() run in one handler.
    async (message: string, from?: string | null) => {
      const eth = injectedProvider();
      const signer = from ?? address;
      if (!eth || !signer) throw new Error("Connect a wallet first.");
      return (await eth.request({ method: "personal_sign", params: [toHex(message), signer] })) as `0x${string}`;
    },
    [address],
  );

  const disconnect = useCallback(() => {
    setAddress(null);
    setChainId(null);
  }, []);

  const onBase = chainId === BASE_MAINNET || chainId === BASE_SEPOLIA;
  return { address, chainId, onBase, error, setError, busy, available, connect, switchTo, signMessage, disconnect };
}

export function friendly(e: unknown): string {
  const code = (e as { code?: number }).code;
  if (code === 4001) return "Request rejected in your wallet.";
  if (code === -32002) return "Your wallet already has a pending request — open it to continue.";
  const msg = (e as Error)?.message ?? String(e);
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}
