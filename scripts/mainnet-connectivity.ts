import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRawBlockProviders,
  fetchCorroboratedRawBlock,
  type RawBlockProvider,
} from "../services/settlement/mainnet-block-source.ts";

type Provider = { endpoint: string; operator: string };
type ProbeConfig = {
  zcash: {
    lightwalletd: Provider[];
    headerRpc: Provider;
    rawBlocks: RawBlockProvider[];
  };
  base: Provider[];
  solana: Provider[];
};

const configPath =
  process.env.ZECONE_PUBLIC_PROBES_CONFIG ??
  "deploy/config/mainnet-public-probes.json";
const outputDir = resolve(process.argv[2] ?? "docs/stage3-evidence");
const timeout = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function assertProviders(label: string, providers: Provider[]) {
  if (!Array.isArray(providers) || providers.length !== 2) {
    throw new Error(`${label}_requires_two_providers`);
  }
  const hosts = new Set<string>();
  const operators = new Set<string>();
  for (const provider of providers) {
    const url = new URL(provider.endpoint);
    if (url.protocol !== "https:") throw new Error(`${label}_https_required`);
    if (url.username || url.password)
      throw new Error(`${label}_credentials_forbidden`);
    if (
      /example|localhost|127\.0\.0\.1|\.invalid|replace/i.test(url.hostname)
    ) {
      throw new Error(`${label}_placeholder_forbidden`);
    }
    hosts.add(url.host);
    operators.add(provider.operator);
  }
  if (hosts.size !== 2) throw new Error(`${label}_hosts_must_be_distinct`);
  if (operators.size !== 2)
    throw new Error(`${label}_operators_must_be_distinct`);
}

function loadConfig(): ProbeConfig {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as ProbeConfig;
  assertProviders("zcash_lightwalletd", config.zcash?.lightwalletd);
  assertProviders("base", config.base);
  assertProviders("solana", config.solana);
  assertRawBlockProviders(config.zcash.rawBlocks);
  for (const [label, provider] of [
    ["zcash_header_rpc", config.zcash.headerRpc],
  ] as const) {
    const url = new URL(provider.endpoint);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error(`${label}_invalid_endpoint`);
    }
  }
  return config;
}

async function postJson(label: string, url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}_http_${response.status}`);
  if (text.length > MAX_RESPONSE_BYTES)
    throw new Error(`${label}_response_too_large`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${label}_invalid_json`);
  }
}

async function rpc(
  label: string,
  url: string,
  method: string,
  params: unknown[],
) {
  const id = 1;
  const body = await postJson(label, url, {
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
  if (body.id !== id) throw new Error(`${label}_id_mismatch`);
  if (body.error) throw new Error(`${label}_rpc_error`);
  if (!("result" in body)) throw new Error(`${label}_missing_result`);
  return body.result;
}

function watchBinary() {
  const name =
    process.platform === "win32"
      ? "zecone-zcash-watch.exe"
      : "zecone-zcash-watch";
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    process.env.ZECONE_WATCH_BIN,
    join(projectRoot, "services", "zcash-watch", "target", "debug", name),
    join(projectRoot, "target", "debug", name),
    join(process.cwd(), "services", "zcash-watch", "target", "debug", name),
    join(process.cwd(), "target", "debug", name),
    join("/usr/local/bin", name),
  ].filter((value): value is string => Boolean(value));
  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary) throw new Error("watch_binary_missing");
  return binary;
}

function rust(args: string[]) {
  try {
    const output = execFileSync(
      watchBinary(),
      ["--wallet", ".unused", ...args],
      {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return JSON.parse(output.trim()) as Record<string, unknown>;
  } catch (error) {
    const stderr =
      typeof error === "object" && error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").slice(0, 300)
        : "";
    const message = error instanceof Error ? error.message : "unknown_error";
    throw new Error(
      `rust_verification_failed:${message}${stderr ? `:${stderr}` : ""}`,
    );
  }
}

function probeMainnet(server: string, peer: string, height?: number) {
  const args = ["probe-mainnet", "--server", server, "--peer", peer];
  if (height !== undefined) args.push("--height", String(height));
  const result = rust(args);
  if (result.providerAgreement !== "PASS") {
    throw new Error("zcash_lightwalletd_disagreement");
  }
  return result as {
    height: number;
    blockHash: string;
    primaryTip: number;
    peerTip: number;
    confirmations: number;
    orchardRoot: string;
    observedAt: number;
  };
}

function same(label: string, left: unknown, right: unknown) {
  const scalar = (value: unknown) =>
    typeof value === "string" || typeof value === "number";
  if (!scalar(left) || !scalar(right) || left !== right) {
    throw new Error(`${label}_disagreement`);
  }
}

async function probeBase(providers: Provider[]) {
  assertProviders("base", providers);
  const observed = await Promise.all(
    providers.map(async (provider) => {
      const chainId = await rpc("base", provider.endpoint, "eth_chainId", []);
      if (chainId !== "0x2105") throw new Error("base_wrong_chain");
      const block = (await rpc(
        "base",
        provider.endpoint,
        "eth_getBlockByNumber",
        ["finalized", false],
      )) as { number?: string; hash?: string; timestamp?: string } | null;
      if (!block?.number || !block.hash)
        throw new Error("base_missing_finalized_block");
      return {
        operator: provider.operator,
        endpoint: provider.endpoint,
        chainId,
        number: Number(BigInt(block.number)),
        hash: block.hash,
        timestamp: Number(BigInt(block.timestamp ?? "0x0")),
      };
    }),
  );
  const common = Math.min(...observed.map((item) => item.number));
  const agreed = await Promise.all(
    providers.map(async (provider) => {
      const block = (await rpc(
        "base",
        provider.endpoint,
        "eth_getBlockByNumber",
        [`0x${common.toString(16)}`, false],
      )) as { hash?: string; timestamp?: string } | null;
      if (!block?.hash) throw new Error("base_missing_common_block");
      return {
        operator: provider.operator,
        hash: block.hash,
        timestamp: Number(BigInt(block.timestamp ?? "0x0")),
      };
    }),
  );
  same("base_finalized_hash", agreed[0].hash, agreed[1].hash);
  same("base_timestamp", agreed[0].timestamp, agreed[1].timestamp);
  if (Math.floor(Date.now() / 1000) - agreed[0].timestamp > 1800) {
    throw new Error("base_finalized_block_stale");
  }
  return {
    status: "PASS",
    chainId: "0x2105",
    finalizedHeight: common,
    finalizedHash: agreed[0].hash,
    timestamp: agreed[0].timestamp,
    providers: observed,
    readOnly: true,
  };
}

async function solanaBlock(endpoint: string, slot: number) {
  for (let candidate = slot; candidate > slot - 5; candidate -= 1) {
    const block = (await rpc("solana", endpoint, "getBlock", [
      candidate,
      {
        commitment: "finalized",
        transactionDetails: "none",
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ])) as { blockhash?: string; blockTime?: number } | null;
    if (block?.blockhash) return { slot: candidate, block };
  }
  throw new Error("solana_missing_finalized_block");
}

async function probeSolana(providers: Provider[]) {
  assertProviders("solana", providers);
  const observed = await Promise.all(
    providers.map(async (provider) => {
      const genesis = await rpc(
        "solana",
        provider.endpoint,
        "getGenesisHash",
        [],
      );
      if (genesis !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") {
        throw new Error("solana_wrong_genesis");
      }
      const slot = await rpc("solana", provider.endpoint, "getSlot", [
        { commitment: "finalized" },
      ]);
      if (typeof slot !== "number") throw new Error("solana_invalid_slot");
      const block = await solanaBlock(provider.endpoint, slot);
      return {
        operator: provider.operator,
        endpoint: provider.endpoint,
        genesis,
        slot: block.slot,
        hash: block.block.blockhash as string,
        blockTime: block.block.blockTime ?? 0,
      };
    }),
  );
  const common = Math.min(...observed.map((item) => item.slot));
  const agreed = await Promise.all(
    providers.map(async (provider) => {
      const block = await solanaBlock(provider.endpoint, common);
      return {
        operator: provider.operator,
        slot: block.slot,
        hash: block.block.blockhash as string,
        blockTime: block.block.blockTime ?? 0,
      };
    }),
  );
  same("solana_finalized_slot", agreed[0].slot, agreed[1].slot);
  same("solana_finalized_hash", agreed[0].hash, agreed[1].hash);
  same("solana_block_time", agreed[0].blockTime, agreed[1].blockTime);
  if (Math.floor(Date.now() / 1000) - agreed[0].blockTime > 300) {
    throw new Error("solana_finalized_block_stale");
  }
  return {
    status: "PASS",
    genesisHash: observed[0].genesis,
    finalizedSlot: agreed[0].slot,
    finalizedHash: agreed[0].hash,
    blockTime: agreed[0].blockTime,
    providers: observed,
    readOnly: true,
  };
}

async function probeZcash(config: ProbeConfig["zcash"]) {
  assertProviders("zcash_lightwalletd", config.lightwalletd);
  const [primary, peer] = config.lightwalletd;
  const mainnet = probeMainnet(primary.endpoint, peer.endpoint);
  const height = mainnet.height;
  const blockHash = String(
    await rpc("zcash_header", config.headerRpc.endpoint, "getblockhash", [
      height,
    ]),
  );
  same("zcash_lightwalletd_tatum_hash", mainnet.blockHash, blockHash);
  const headerHex = String(
    await rpc("zcash_header", config.headerRpc.endpoint, "getblockheader", [
      blockHash,
      false,
    ]),
  );
  if (!/^[0-9a-f]+$/i.test(headerHex) || headerHex.length % 2 !== 0) {
    throw new Error("zcash_header_invalid");
  }
  const rawBlock = await fetchCorroboratedRawBlock(config.rawBlocks, blockHash);
  const temp = mkdtempSync(join(tmpdir(), "zecone-mainnet-"));
  try {
    const headerFile = join(temp, "header.bin");
    const blockFile = join(temp, "block.bin");
    writeFileSync(headerFile, Buffer.from(headerHex, "hex"));
    writeFileSync(blockFile, rawBlock.bytes);
    const header = rust([
      "verify-header",
      "--header-file",
      headerFile,
      "--expected-hash",
      blockHash,
    ]);
    const block = rust([
      "verify-block",
      "--block-file",
      blockFile,
      "--expected-hash",
      blockHash,
      "--height",
      String(height),
    ]);
    same("zcash_header_hash", header.hash, blockHash);
    same(
      "zcash_block_header_hash",
      (block.header as { hash?: string })?.hash,
      blockHash,
    );
    same(
      "zcash_header_merkle_root",
      header.merkleRoot,
      (block.header as { merkleRoot?: string })?.merkleRoot,
    );
    if (block.transactionMerkleRootMatchesHeader !== true) {
      throw new Error("zcash_transaction_merkle_root_disagreement");
    }
    if (header.proofOfWork !== "PASS")
      throw new Error("zcash_proof_of_work_failed");
    return {
      status: "PASS",
      height,
      blockHash,
      primaryTip: mainnet.primaryTip,
      peerTip: mainnet.peerTip,
      orchardRoot: mainnet.orchardRoot,
      confirmations: mainnet.confirmations,
      lightwalletdAgreement: true,
      transactionCount: block.transactionCount,
      transactionMerkleRoot: block.transactionMerkleRoot,
      transactionMerkleRootMatchesHeader: true,
      proofOfWork: "PASS",
      headerSource: config.headerRpc.operator,
      rawBlockSources: rawBlock.operators,
      rawBlockSha256: rawBlock.sha256,
      rawBlockExactByteAgreement: rawBlock.exactByteAgreement,
      authorizingDataCommitment: "NOT_LOCALLY_RECOMPUTED",
      readOnly: true,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  const config = loadConfig();
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "READ_ONLY",
    executionAllowed: false,
    productionReady: false,
    note: "Public free endpoints are evidence probes, not approved production providers.",
  };
  const checks = [
    ["base", () => probeBase(config.base)],
    ["solana", () => probeSolana(config.solana)],
    ["zcash", () => probeZcash(config.zcash)],
  ] as const;
  let failed = false;
  for (const [name, check] of checks) {
    try {
      report[name] = await check();
    } catch (error) {
      failed = true;
      report[name] = {
        status: "FAIL",
        error: error instanceof Error ? error.message : "unknown_error",
      };
    }
  }
  report.status = failed ? "FAIL" : "PASS";
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidencePath = join(outputDir, `mainnet-connectivity-${stamp}.json`);
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      evidence: evidencePath,
      base: (report.base as { status?: string })?.status,
      solana: (report.solana as { status?: string })?.status,
      zcash: (report.zcash as { status?: string })?.status,
    }),
  );
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "unknown_error");
  process.exitCode = 1;
});
