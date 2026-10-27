import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { Dashboard, WalletSummary } from "./view.ts";

const exec = promisify(execFile);

export type ZcashNetwork = "testnet" | "mainnet";
export type ZcashNetworkView = {
  network: "zcash-testnet" | "zcash-mainnet";
  label: string;
  mode: "TESTNET" | "READ_ONLY";
  receivingAddress: string | null;
  accountFingerprint: string | null;
  addressStandard: "ZIP-316";
  receivers: {
    orchard: boolean;
    sapling: boolean;
    transparent: boolean;
    unknownTypecodes: number[];
  } | null;
  summary: WalletSummary | null;
  sync: {
    tip: number;
    scanned: number;
    complete: boolean;
    source: string;
  } | null;
  capabilities: {
    receive: boolean;
    balance: boolean;
    history: boolean;
    sign: false;
    broadcast: false;
  };
  sendUnavailableReason: string;
  secretMaterialLoaded: false;
  broadcast: false;
};

type MainnetConfig = {
  version: 1;
  mode: "READ_ONLY";
  binary: string;
  wallet: string;
  expectedAccount: string;
  expectedAddress: string;
};

function exactConfig(value: unknown): MainnetConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid mainnet browser-wallet configuration.");
  const v = value as Record<string, unknown>;
  const keys = [
    "version",
    "mode",
    "binary",
    "wallet",
    "expectedAccount",
    "expectedAddress",
  ];
  if (
    Object.keys(v).some((key) => !keys.includes(key)) ||
    v.version !== 1 ||
    v.mode !== "READ_ONLY" ||
    typeof v.binary !== "string" ||
    typeof v.wallet !== "string" ||
    typeof v.expectedAccount !== "string" ||
    !/^[0-9a-f]{64}$/i.test(v.expectedAccount) ||
    typeof v.expectedAddress !== "string" ||
    !v.expectedAddress.startsWith("u1")
  )
    throw Error("Invalid mainnet browser-wallet configuration.");
  return v as MainnetConfig;
}

export class ZcashNetworkViews {
  private constructor(
    readonly config: MainnetConfig | null,
    readonly run: (
      binary: string,
      args: string[],
    ) => Promise<{ stdout: string }> = async (binary, args) =>
      exec(binary, args, {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      }),
  ) {}

  static load(path = process.env.ZECONE_WALLET_NETWORKS_CONFIG) {
    if (!path) return new ZcashNetworkViews(null);
    const file = resolve(path);
    const outer = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      !outer ||
      Object.keys(outer).some((key) => !["version", "mainnet"].includes(key)) ||
      outer.version !== 1
    )
      throw Error("Invalid wallet network configuration.");
    const config = exactConfig(outer.mainnet);
    config.binary = isAbsolute(config.binary)
      ? config.binary
      : resolve(config.binary);
    config.wallet = isAbsolute(config.wallet)
      ? config.wallet
      : resolve(config.wallet);
    if (!existsSync(config.binary) || !existsSync(config.wallet))
      throw Error("Configured mainnet read-only service is unavailable.");
    return new ZcashNetworkViews(config);
  }

  static fixture(config: MainnetConfig, run: ZcashNetworkViews["run"]) {
    return new ZcashNetworkViews(exactConfig(config), run);
  }

  list() {
    return [
      {
        id: "testnet" as const,
        label: "Testnet",
        available: true,
        mode: "TESTNET" as const,
      },
      {
        id: "mainnet" as const,
        label: "Mainnet",
        available: !!this.config,
        mode: "READ_ONLY" as const,
      },
    ];
  }

  testnet(dashboard: Dashboard): ZcashNetworkView {
    return {
      network: "zcash-testnet",
      label: "Zcash Testnet",
      mode: "TESTNET",
      receivingAddress: null,
      accountFingerprint: null,
      addressStandard: "ZIP-316",
      receivers: null,
      summary: dashboard.zcash,
      sync: dashboard.zcash
        ? {
            tip: dashboard.zcash.tip,
            scanned: dashboard.zcash.scanned,
            complete: dashboard.zcash.tip === dashboard.zcash.scanned,
            source: "isolated-testnet-wallet",
          }
        : null,
      capabilities: {
        receive: false,
        balance: true,
        history: true,
        sign: false,
        broadcast: false,
      },
      sendUnavailableReason:
        "General-purpose Zcash sending is unavailable. Existing testnet checkout approvals are unchanged.",
      secretMaterialLoaded: false,
      broadcast: false,
    };
  }

  async mainnet(): Promise<ZcashNetworkView> {
    const c = this.config;
    if (!c) throw Error("Mainnet read-only wallet is not configured.");
    const { stdout } = await this.run(c.binary, [
      "browser-view",
      "--wallet",
      c.wallet,
      "--expected-account",
      c.expectedAccount,
      "--expected-address",
      c.expectedAddress,
    ]);
    const view = JSON.parse(stdout) as ZcashNetworkView;
    if (
      view.network !== "zcash-mainnet" ||
      view.mode !== "READ_ONLY" ||
      view.receivingAddress !== c.expectedAddress ||
      view.accountFingerprint !== c.expectedAccount.toLowerCase() ||
      view.addressStandard !== "ZIP-316" ||
      view.secretMaterialLoaded !== false ||
      view.broadcast !== false ||
      view.capabilities?.sign !== false ||
      view.capabilities?.broadcast !== false
    )
      throw Error("Mainnet read-only identity response mismatch.");
    return view;
  }
}
