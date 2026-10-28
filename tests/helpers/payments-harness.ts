// In-process harness for the merchant payment API: a real HTTP listener on an
// ephemeral loopback port, a temporary SQLite journal and an injectable clock.
// Synthetic only — no keys, no chain access, no funds.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createPaymentsApp, DEFAULT_CHECKOUT_ADDRESS, type PaymentsApp, type PaymentsConfig } from "../../services/payments/api.ts";
import type { Fetcher } from "../../services/payments/webhooks.ts";

export const DEMO_SECRET = "test-demo-secret";
export const DEMO_PAYOUT = "0x4b5750d7675f14eB844B74477015302Bf31AE2dB";
export const OPERATOR_TOKEN = "op-token-for-tests-only-0123456789-abcdefghijklmnop";
export const ORIGIN = { domain: "127.0.0.1:4333", uri: "http://127.0.0.1:4333/setup" };

export interface Harness {
  app: PaymentsApp;
  base: string;
  clock: { now: number };
  close(): Promise<void>;
  call(path: string, init?: { method?: string; body?: unknown; key?: string | null; headers?: Record<string, string> }): Promise<{
    status: number;
    body: any;
    headers: Headers;
  }>;
}

export async function startHarness(overrides: Partial<PaymentsConfig> = {}, fetcher?: Fetcher): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "zecone-pay-"));
  const clock = { now: 1_800_000_000 };
  const config: PaymentsConfig = {
    dbPath: join(dir, "payments.sqlite"),
    checkoutAddress: DEFAULT_CHECKOUT_ADDRESS,
    mode: "demo",
    demoMerchant: { secret: DEMO_SECRET, payoutAddress: DEMO_PAYOUT },
    siwe: { allowedDomains: [ORIGIN.domain, "localhost:3000"], ttlSeconds: 600 },
    publicCheckoutBaseUrl: "http://localhost:3000",
    operatorToken: OPERATOR_TOKEN,
    exclusiveAllocation: true,
    quoteTtlSeconds: 900,
    maxAmountUsd: "500.00",
    relayerAvailableWei: 50_000_000_000_000_000n,
    demoObserver: { enabled: true, startAfterSeconds: 10, stepSeconds: 2 },
    allowLoopbackHttpWebhooks: true,
    sessionTtlSeconds: 3600,
    fetcher,
    now: () => clock.now,
    ...overrides,
  };
  const app = createPaymentsApp(config);
  const server: Server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    app,
    base,
    clock,
    async call(path, init = {}) {
      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      if (init.body !== undefined) headers["Content-Type"] = "application/json";
      const key = init.key === undefined ? app.demoApiKey : init.key;
      if (key) headers.Authorization = `Bearer ${key}`;
      const res = await fetch(base + path, {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function newWallet(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

/** Full wallet-ownership onboarding through the public API. */
export async function onboard(h: Harness, wallet = newWallet(), name = "Test Merchant") {
  const ch = await h.call("/api/v1/merchants/challenge", {
    key: null,
    body: { address: wallet.address, chainId: 8453, ...ORIGIN, purpose: "register" },
  });
  if (ch.status !== 201) throw new Error(`challenge failed: ${JSON.stringify(ch.body)}`);
  const signature = await wallet.signMessage({ message: ch.body.challenge.message });
  const v = await h.call("/api/v1/merchants/verify", {
    key: null,
    body: { message: ch.body.challenge.message, signature, name },
  });
  if (v.status !== 201 && v.status !== 200) throw new Error(`verify failed: ${JSON.stringify(v.body)}`);
  return { wallet, apiKey: v.body.apiKey as string, session: v.body.session.token as string, merchant: v.body.merchant };
}
