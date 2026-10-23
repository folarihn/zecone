// Watch-only Zcash mainnet worker. It has no signing, submission, refund, or spending-key imports.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  MainnetWatchWorker,
  readOperationalStatus,
  type WatchProbe,
  type WatchWorkerConfig,
} from "../services/operations/mainnet-watch-worker.ts";

const exec = promisify(execFile);
type FileConfig = WatchWorkerConfig & {
  stateDirectory: string;
  publicProbeConfig: string;
  walletDirectory: string;
  intervalSeconds: number;
};
type ProbeConfig = {
  zcash: { lightwalletd: { endpoint: string; operator: string }[] };
};

function watchBinary() {
  const name =
    process.platform === "win32"
      ? "zecone-zcash-watch.exe"
      : "zecone-zcash-watch";
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    process.env.ZECONE_WATCH_BIN,
    join(root, "services", "zcash-watch", "target", "debug", name),
    join(root, "target", "debug", name),
    join("/usr/local/bin", name),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find(existsSync);
  if (!found) throw Error("WATCH_BINARY_MISSING");
  return found;
}

function load(path: string) {
  let value: FileConfig;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch {
    throw Error("WATCH_WORKER_CONFIG_INVALID");
  }
  if (
    typeof value.stateDirectory !== "string" ||
    typeof value.publicProbeConfig !== "string" ||
    typeof value.walletDirectory !== "string" ||
    !Number.isSafeInteger(value.intervalSeconds) ||
    value.intervalSeconds < 30
  )
    throw Error("WATCH_WORKER_CONFIG_INVALID");
  return value;
}

async function main() {
  const command = process.argv[2] ?? "status";
  const configFlag = process.argv.indexOf("--config");
  const configPath = resolve(
    configFlag >= 0
      ? (process.argv[configFlag + 1] ?? "")
      : (process.env.ZECONE_WATCH_WORKER_CONFIG ??
          "/etc/zecone/mainnet-watch-worker.json"),
  );
  const config = load(configPath);
  const state = resolve(config.stateDirectory),
    wallet = resolve(config.walletDirectory);
  if (command === "status") {
    process.stdout.write(
      JSON.stringify(readOperationalStatus(state), null, 2) + "\n",
    );
    return;
  }
  if (process.env.ZECONE_READ_ONLY !== "1")
    throw Error("READ_ONLY_MODE_REQUIRED");
  const probes = JSON.parse(
    readFileSync(resolve(config.publicProbeConfig), "utf8"),
  ) as ProbeConfig;
  if (
    !Array.isArray(probes.zcash?.lightwalletd) ||
    probes.zcash.lightwalletd.length !== 2
  )
    throw Error("WATCH_PROVIDER_CONFIG_INVALID");
  const [primary, peer] = probes.zcash.lightwalletd;
  if (
    primary.operator === peer.operator ||
    new URL(primary.endpoint).host === new URL(peer.endpoint).host
  )
    throw Error("WATCH_PROVIDER_INDEPENDENCE_REQUIRED");
  const binary = watchBinary();
  const runJson = async (args: string[], timeout: number) => {
    const { stdout } = await exec(binary, ["--wallet", wallet, ...args], {
      windowsHide: true,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  };
  const worker = new MainnetWatchWorker(state, config, {
    now: () => Math.floor(Date.now() / 1000),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    probe: async (height) => {
      const result = await runJson(
        [
          "probe-mainnet",
          "--server",
          primary.endpoint,
          "--peer",
          peer.endpoint,
          ...(height === undefined ? [] : ["--height", String(height)]),
        ],
        120_000,
      );
      const tip = Math.min(Number(result.primaryTip), Number(result.peerTip));
      if (!Number.isSafeInteger(tip) || result.providerAgreement !== "PASS")
        throw Error("WATCH_PROVIDER_DISAGREEMENT");
      return {
        tip,
        height: Number(result.height),
        blockHash: String(result.blockHash),
        providerAgreement: "PASS",
        observedAt: Number(result.observedAt),
      } satisfies WatchProbe;
    },
    exportRange: async (start, count, output) => {
      await exec(
        process.execPath,
        [
          "--experimental-transform-types",
          resolve("scripts/mainnet-block-export.ts"),
          "--config",
          resolve(config.publicProbeConfig),
          "--output",
          output,
          "--start-height",
          String(start),
          "--count",
          String(count),
          "--minimum-confirmations",
          String(config.exportMinimumConfirmations),
        ],
        { windowsHide: true, timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      );
    },
    scan: async (corpus, checkpointHeight) => {
      const result = await runJson(
        [
          "observe-mainnet",
          "--server",
          primary.endpoint,
          "--peer",
          peer.endpoint,
          "--minimum-confirmations",
          String(config.minimumConfirmations),
          "--authenticated-block-dir",
          corpus,
          ...(checkpointHeight === undefined
            ? []
            : ["--checkpoint-height", String(checkpointHeight)]),
        ],
        20 * 60_000,
      );
      if (
        result.network !== "zcash-mainnet" ||
        result.liveChain !== true ||
        result.minimumConfirmations !== config.minimumConfirmations
      )
        throw Error("WATCH_SCAN_POLICY_MISMATCH");
      return { observedAt: Number(result.observedAt) };
    },
  });
  const run = async () => {
    const result = await worker.runOnce();
    process.stdout.write(
      JSON.stringify({ event: "WATCH_CYCLE", ...result }) + "\n",
    );
  };
  if (command === "once") return run();
  if (command !== "run") throw Error("WATCH_WORKER_COMMAND_INVALID");
  for (;;) {
    try {
      await run();
    } catch (error) {
      process.stderr.write(
        JSON.stringify({
          event: "WATCH_CYCLE_FAILED",
          code:
            error instanceof Error && /^[A-Z0-9_]{1,96}$/.test(error.message)
              ? error.message
              : "WATCH_WORKER_FAILED",
        }) + "\n",
      );
    }
    await new Promise((done) =>
      setTimeout(done, config.intervalSeconds * 1000),
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof Error && /^[A-Z0-9_]{1,96}$/.test(error.message)
          ? error.message
          : "WATCH_WORKER_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
});
