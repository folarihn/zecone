"use client";
import { useCallback, useEffect, useState } from "react";
import { getAddress } from "viem";
import { LogOut, Wallet } from "lucide-react";

const BASE_MAINNET = 8453;
const BASE_SEPOLIA = 84532;

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

function injected(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
}

/**
 * Base wallet connectivity (EIP-1193 via viem address helpers). Connecting a
 * Base wallet is not the same as connecting a Zcash wallet: this only lets a
 * merchant select its Base address as the payout recipient.
 */
export default function BaseWallet({ onAddress }: { onAddress?: (address: string | null) => void }) {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateAccount = useCallback(
    (address: string | null) => {
      setAccount(address);
      onAddress?.(address);
    },
    [onAddress],
  );

  async function connect() {
    setError(null);
    const eth = injected();
    if (!eth) {
      setError("No injected EVM wallet detected.");
      return;
    }
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const chainHex = (await eth.request({ method: "eth_chainId" })) as string;
      const normalized = getAddress(accounts[0]);
      setAccount(normalized);
      setChainId(Number(BigInt(chainHex)));
      updateAccount(normalized);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function disconnect() {
    setAccount(null);
    setChainId(null);
    updateAccount(null);
  }

  useEffect(() => {
    const eth = injected();
    if (!eth?.on) return;
    const onAccounts = (accounts: unknown) => {
      const list = accounts as string[];
      if (list.length > 0) {
        const normalized = getAddress(list[0]);
        setAccount(normalized);
        updateAccount(normalized);
      } else {
        setAccount(null);
        updateAccount(null);
      }
    };
    const onChain = (chainHex: unknown) => setChainId(Number(BigInt(chainHex as string)));
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [updateAccount]);

  const onBase = chainId === BASE_MAINNET || chainId === BASE_SEPOLIA;
  const chainLabel =
    chainId === BASE_MAINNET
      ? "Base mainnet · 8453"
      : chainId === BASE_SEPOLIA
        ? "Base Sepolia · 84532"
        : chainId !== null
          ? `Unsupported network · ${chainId}`
          : null;

  return (
    <div className="rounded-xl border border-line bg-canvas p-3">
      {account ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-mono text-[12.5px] text-ink">{account}</div>
            <div className={`mt-0.5 text-[12px] font-medium ${onBase ? "text-green" : "text-amber"}`}>
              {chainLabel}
            </div>
          </div>
          <button
            onClick={disconnect}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink"
          >
            <LogOut size={13} /> Disconnect
          </button>
        </div>
      ) : (
        <button
          onClick={connect}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface py-2.5 text-[13.5px] font-medium text-ink transition-colors hover:bg-canvas"
        >
          <Wallet size={15} /> Connect Base wallet
        </button>
      )}
      {error && <p className="mt-2 text-[12px] text-red">{error}</p>}
    </div>
  );
}
