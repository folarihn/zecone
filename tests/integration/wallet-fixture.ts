// Injected EIP-1193 test wallet. Signing happens in Node with an ephemeral viem
// account (real EIP-191 signatures over the exact message the page requests);
// the page only sees a provider object. It can never send a transaction.
import type { Page } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hexToString, type Hex } from "viem";

export async function installTestWallet(page: Page, opts: { chainId?: number } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const signed: string[] = [];
  await page.exposeFunction("__zeconeTestSign", async (hex: Hex) => {
    const message = hexToString(hex);
    signed.push(message);
    return account.signMessage({ message });
  });
  await page.addInitScript(
    ({ address, chainId }) => {
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      let chain = chainId;
      const emit = (ev: string, v: unknown) => (listeners[ev] ?? []).forEach((f) => f(v));
      (window as unknown as { ethereum: unknown }).ethereum = {
        isZecOneTestWallet: true,
        on(ev: string, f: (...a: unknown[]) => void) {
          (listeners[ev] ??= []).push(f);
        },
        removeListener(ev: string, f: (...a: unknown[]) => void) {
          listeners[ev] = (listeners[ev] ?? []).filter((x) => x !== f);
        },
        async request({ method, params }: { method: string; params?: unknown[] }) {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [address];
            case "eth_chainId":
              return "0x" + chain.toString(16);
            case "wallet_switchEthereumChain": {
              chain = parseInt((params![0] as { chainId: string }).chainId, 16);
              emit("chainChanged", "0x" + chain.toString(16));
              return null;
            }
            case "personal_sign": {
              const [msg, from] = params as [string, string];
              if (from.toLowerCase() !== address.toLowerCase()) throw Object.assign(new Error("wrong account"), { code: 4100 });
              return (window as unknown as { __zeconeTestSign: (h: string) => Promise<string> }).__zeconeTestSign(msg);
            }
            default:
              throw Object.assign(new Error(`test wallet does not support ${method}`), { code: 4200 });
          }
        },
      };
    },
    { address: account.address, chainId: opts.chainId ?? 8453 },
  );
  return { address: account.address, signed };
}
