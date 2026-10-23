import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertExternalPath } from "../services/provisioning/mainnet-watch-backup.ts";
import {
  assertRawBlockProviders,
  fetchCorroboratedRawBlock,
  type RawBlockProvider,
} from "../services/settlement/mainnet-block-source.ts";

type Provider = { endpoint: string; operator: string };
type Config = {
  zcash: {
    lightwalletd: Provider[];
    rawBlocks: RawBlockProvider[];
  };
};

function argument(name: string, required = true) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || value.startsWith("--")))
    throw Error(`missing_${name.replaceAll("-", "_")}`);
  return value;
}

function positiveInteger(name: string, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(argument(name));
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw Error(`invalid_${name.replaceAll("-", "_")}`);
  return value;
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
  if (!binary) throw Error("watch_binary_missing");
  return binary;
}

function rust(args: string[]) {
  const output = execFileSync(watchBinary(), ["--wallet", ".unused", ...args], {
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(output.trim()) as Record<string, unknown>;
}

function writeNew(path: string, data: Uint8Array | string) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string) {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function main() {
  const configPath = resolve(
    argument("config", false) ?? "deploy/config/mainnet-public-probes.json",
  );
  const output = resolve(argument("output")!);
  const startHeight = positiveInteger("start-height", 0xffff_ffff);
  const count = positiveInteger("count", 100);
  const minimumConfirmations = Number(
    argument("minimum-confirmations", false) ?? "10",
  );
  if (
    !Number.isSafeInteger(minimumConfirmations) ||
    minimumConfirmations < 10 ||
    minimumConfirmations > 99
  )
    throw Error("invalid_minimum_confirmations");
  if (startHeight + count - 1 > 0xffff_ffff)
    throw Error("zcash_export_range_invalid");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  const lightwalletd = config.zcash?.lightwalletd;
  if (!Array.isArray(lightwalletd) || lightwalletd.length !== 2)
    throw Error("zcash_lightwalletd_requires_two_providers");
  if (
    new Set(lightwalletd.map((provider) => new URL(provider.endpoint).host))
      .size !== 2 ||
    new Set(lightwalletd.map((provider) => provider.operator)).size !== 2
  )
    throw Error("zcash_lightwalletd_independence_required");
  assertRawBlockProviders(config.zcash.rawBlocks);
  assertExternalPath(output);
  if (existsSync(output))
    throw Error("authenticated_block_directory_must_be_new");
  const blocks: Record<string, unknown>[] = [];
  let priorHash: string | undefined;
  let accumulatedWork = 0n;
  let created = false;
  try {
    mkdirSync(output, { mode: 0o700 });
    created = true;
    for (let offset = 0; offset < count; offset += 1) {
      const height = startHeight + offset;
      const probe = rust([
        "probe-mainnet",
        "--server",
        lightwalletd[0].endpoint,
        "--peer",
        lightwalletd[1].endpoint,
        "--height",
        String(height),
      ]);
      if (probe.providerAgreement !== "PASS" || probe.height !== height)
        throw Error("zcash_lightwalletd_disagreement");
      if (
        !Number.isSafeInteger(probe.confirmations) ||
        (probe.confirmations as number) < minimumConfirmations
      )
        throw Error("zcash_export_block_insufficient_confirmations");
      const hash = String(probe.blockHash ?? "");
      const raw = await fetchCorroboratedRawBlock(config.zcash.rawBlocks, hash);
      const temporary = join(output, `.${height}-${hash}.partial`);
      writeNew(temporary, raw.bytes);
      const verified = rust([
        "verify-block",
        "--block-file",
        temporary,
        "--expected-hash",
        hash,
        "--height",
        String(height),
      ]);
      const header = verified.header as
        | {
            proofOfWork?: unknown;
            previousBlockHash?: unknown;
            target?: unknown;
          }
        | undefined;
      if (
        header?.proofOfWork !== "PASS" ||
        verified.transactionMerkleRootMatchesHeader !== true
      )
        throw Error(
          `zcash_local_block_verification_failed:${String(header?.proofOfWork)}:${String(verified.transactionMerkleRootMatchesHeader)}`,
        );
      if (
        priorHash &&
        String(header.previousBlockHash).toLowerCase() !==
          priorHash.toLowerCase()
      )
        throw Error("zcash_exported_chain_discontinuity");
      const targetText = String(header.target ?? "");
      if (
        !/^[0-9a-f]{64}$/i.test(targetText) ||
        BigInt(`0x${targetText}`) === 0n
      )
        throw Error("zcash_exported_target_invalid");
      accumulatedWork += (1n << 256n) / (BigInt(`0x${targetText}`) + 1n);
      const final = join(output, `${height}-${hash}.bin`);
      renameSync(temporary, final);
      fsyncDirectory(output);
      blocks.push({
        height,
        hash,
        sha256: raw.sha256,
        bytes: raw.bytes.length,
        lightwalletdOperators: lightwalletd.map(
          (provider) => provider.operator,
        ),
        rawBlockOperators: raw.operators,
        exactRawBlockAgreement: true,
        proofOfWork: "PASS",
        transactionMerkleRoot: "PASS",
        authorizingDataCommitment: "NOT_LOCALLY_RECOMPUTED",
      });
      priorHash = hash;
      if (offset + 1 < count)
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      network: "zcash-mainnet",
      mode: "READ_ONLY",
      executionAllowed: false,
      startHeight,
      endHeight: startHeight + count - 1,
      minimumConfirmations,
      chainContinuity: "PASS",
      accumulatedWork: accumulatedWork.toString(16),
      blocks,
      limitation:
        "ZIP-244 authorizing-data and chain-history commitments are not locally recomputed; exact full-block bytes require two independent exporters.",
    };
    writeNew(
      join(output, "authenticated-block-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    fsyncDirectory(output);
    console.log(
      JSON.stringify({
        status: "PASS",
        network: manifest.network,
        startHeight: manifest.startHeight,
        endHeight: manifest.endHeight,
        blockCount: blocks.length,
        output,
        executionAllowed: false,
      }),
    );
  } catch (error) {
    if (created) rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "unknown_error");
  process.exitCode = 1;
});
