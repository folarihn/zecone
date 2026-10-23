import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export type WatchProbe = {
  tip: number;
  height: number;
  blockHash: string;
  providerAgreement: "PASS";
  observedAt: number;
};

export type WatchCheckpoint = {
  schemaVersion: 1;
  network: "zcash-mainnet";
  startHeight: number;
  nextHeight: number;
  lastHeight: number | null;
  lastHash: string | null;
  providerAgreement: "PASS" | "FAILED" | "UNVERIFIED";
  providerObservedAt: number | null;
  scanObservedAt: number | null;
  remoteTip: number | null;
  finalizedTip: number | null;
  updatedAt: number;
  lastError: string | null;
};

export type WatchWorkerConfig = {
  enabled: boolean;
  network: "zcash-mainnet";
  startHeight: number;
  minimumConfirmations: number;
  exportMinimumConfirmations: number;
  batchSize: number;
  maxRetries: number;
  retryBaseMs: number;
  maximumLagBlocks: number;
  maximumScanAgeSeconds: number;
};

export type WatchWorkerDependencies = {
  probe(height?: number): Promise<WatchProbe>;
  exportRange(
    startHeight: number,
    count: number,
    output: string,
  ): Promise<void>;
  scan(
    corpus: string,
    checkpointHeight?: number,
  ): Promise<{ observedAt: number }>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

const HASH = /^[0-9a-f]{64}$/i;
const ERROR = /^[A-Z0-9_]{1,96}$/;

export function errorCode(error: unknown) {
  const value = error instanceof Error ? error.message : "WATCH_WORKER_FAILED";
  return ERROR.test(value) ? value : "WATCH_WORKER_FAILED";
}

export function validateWatchWorkerConfig(value: WatchWorkerConfig) {
  if (
    value.network !== "zcash-mainnet" ||
    typeof value.enabled !== "boolean" ||
    !Number.isSafeInteger(value.startHeight) ||
    value.startHeight < 1 ||
    !Number.isSafeInteger(value.minimumConfirmations) ||
    value.minimumConfirmations < 20 ||
    value.minimumConfirmations > 99 ||
    !Number.isSafeInteger(value.exportMinimumConfirmations) ||
    value.exportMinimumConfirmations < 10 ||
    value.exportMinimumConfirmations > value.minimumConfirmations ||
    !Number.isSafeInteger(value.batchSize) ||
    value.batchSize < 1 ||
    value.batchSize > 100 ||
    !Number.isSafeInteger(value.maxRetries) ||
    value.maxRetries < 1 ||
    value.maxRetries > 5 ||
    !Number.isSafeInteger(value.retryBaseMs) ||
    value.retryBaseMs < 100 ||
    value.retryBaseMs > 30_000 ||
    !Number.isSafeInteger(value.maximumLagBlocks) ||
    value.maximumLagBlocks < 1 ||
    !Number.isSafeInteger(value.maximumScanAgeSeconds) ||
    value.maximumScanAgeSeconds < 60
  )
    throw Error("WATCH_WORKER_CONFIG_INVALID");
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

export function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.partial`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    // Linux (the production target) provides atomic replacement. Windows can
    // reject replacement of an existing file, so development/tests use a
    // remove-then-rename fallback while retaining the prior fsync guarantee.
    if (process.platform !== "win32") throw error;
    rmSync(path, { force: true });
    try {
      renameSync(temporary, path);
    } catch {
      // Some Windows sandbox filesystems also deny first-time rename. This
      // path is never used on the Linux production host.
      copyFileSync(temporary, path);
      rmSync(temporary, { force: true });
    }
  }
  fsyncDirectory(dirname(path));
}

export function readCheckpoint(
  path: string,
  startHeight: number,
): WatchCheckpoint {
  if (!existsSync(path))
    return {
      schemaVersion: 1,
      network: "zcash-mainnet",
      startHeight,
      nextHeight: startHeight,
      lastHeight: null,
      lastHash: null,
      providerAgreement: "UNVERIFIED",
      providerObservedAt: null,
      scanObservedAt: null,
      remoteTip: null,
      finalizedTip: null,
      updatedAt: 0,
      lastError: null,
    };
  let value: WatchCheckpoint;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as WatchCheckpoint;
  } catch {
    throw Error("WATCH_CHECKPOINT_CORRUPT");
  }
  if (
    value.schemaVersion !== 1 ||
    value.network !== "zcash-mainnet" ||
    value.startHeight !== startHeight ||
    !Number.isSafeInteger(value.nextHeight) ||
    value.nextHeight < startHeight ||
    (value.lastHeight === null) !== (value.lastHash === null) ||
    (value.lastHeight !== null &&
      (!Number.isSafeInteger(value.lastHeight) ||
        value.nextHeight !== value.lastHeight + 1 ||
        !HASH.test(value.lastHash!)))
  )
    throw Error("WATCH_CHECKPOINT_CORRUPT");
  return value;
}

export class ExclusiveFileLock {
  private held = false;
  constructor(readonly path: string) {}
  acquire() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = openSync(this.path, "wx", 0o600);
    } catch {
      throw Error("WATCH_WORKER_LOCKED");
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.held = true;
  }
  release() {
    if (!this.held) return;
    rmSync(this.path, { force: true });
    this.held = false;
  }
}

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function promoteAuthenticatedBatch(
  batch: string,
  corpus: string,
  expectedMinimumConfirmations: number,
) {
  const manifestFile = join(batch, "authenticated-block-manifest.json");
  let manifest: {
    network?: unknown;
    startHeight?: unknown;
    endHeight?: unknown;
    minimumConfirmations?: unknown;
    chainContinuity?: unknown;
    blocks?: { height?: unknown; hash?: unknown; sha256?: unknown }[];
  };
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    throw Error("WATCH_EXPORT_MANIFEST_INVALID");
  }
  if (
    manifest.network !== "zcash-mainnet" ||
    manifest.chainContinuity !== "PASS" ||
    !Array.isArray(manifest.blocks) ||
    !Number.isSafeInteger(manifest.startHeight) ||
    !Number.isSafeInteger(manifest.endHeight) ||
    Number(manifest.startHeight) < 1 ||
    Number(manifest.endHeight) < Number(manifest.startHeight) ||
    manifest.minimumConfirmations !== expectedMinimumConfirmations ||
    manifest.blocks.length !==
      Number(manifest.endHeight) - Number(manifest.startHeight) + 1
  )
    throw Error("WATCH_EXPORT_MANIFEST_INVALID");
  const hashes = new Set<string>();
  for (const [offset, block] of manifest.blocks.entries()) {
    if (
      !Number.isSafeInteger(block.height) ||
      block.height !== Number(manifest.startHeight) + offset ||
      !HASH.test(String(block.hash ?? "")) ||
      !HASH.test(String(block.sha256 ?? ""))
    )
      throw Error("WATCH_EXPORT_MANIFEST_INVALID");
    const hash = String(block.hash).toLowerCase();
    if (hashes.has(hash)) throw Error("WATCH_EXPORT_MANIFEST_INVALID");
    hashes.add(hash);
  }
  mkdirSync(corpus, { recursive: true, mode: 0o700 });
  for (const block of manifest.blocks) {
    const name = `${block.height}-${block.hash}.bin`;
    const source = join(batch, name),
      target = join(corpus, name);
    if (!existsSync(source) || sha256(source) !== block.sha256)
      throw Error("WATCH_EXPORT_BLOCK_INVALID");
    if (existsSync(target)) {
      if (sha256(target) !== block.sha256)
        throw Error("WATCH_REORG_OR_CORPUS_CONFLICT");
    } else {
      copyFileSync(source, target, 0);
      if (process.platform !== "win32") {
        const fd = openSync(target, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    }
  }
  const evidence = join(corpus, "manifests");
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const evidenceFile = join(
    evidence,
    `${manifest.startHeight}-${manifest.endHeight}.json`,
  );
  if (!existsSync(evidenceFile)) copyFileSync(manifestFile, evidenceFile, 0);
  fsyncDirectory(corpus);
  return {
    startHeight: Number(manifest.startHeight),
    endHeight: Number(manifest.endHeight),
    lastHash: String(manifest.blocks.at(-1)!.hash),
  };
}

export class MainnetWatchWorker {
  readonly checkpointFile: string;
  readonly lock: ExclusiveFileLock;
  readonly corpus: string;
  readonly staging: string;
  constructor(
    readonly state: string,
    readonly config: WatchWorkerConfig,
    readonly dependencies: WatchWorkerDependencies,
  ) {
    validateWatchWorkerConfig(config);
    this.checkpointFile = join(
      resolve(state),
      "watch-worker",
      "checkpoint.json",
    );
    this.lock = new ExclusiveFileLock(
      join(resolve(state), "watch-worker", "worker.lock"),
    );
    this.corpus = join(resolve(state), "watch-worker", "authenticated-blocks");
    this.staging = join(resolve(state), "watch-worker", "staging");
  }

  private async retry<T>(fn: () => Promise<T>) {
    let last: unknown;
    for (let attempt = 0; attempt < this.config.maxRetries; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        last = error;
        if (attempt + 1 < this.config.maxRetries)
          await this.dependencies.sleep(this.config.retryBaseMs * 2 ** attempt);
      }
    }
    throw Error(
      errorCode(last) === "WATCH_WORKER_FAILED"
        ? "WATCH_RETRY_EXHAUSTED"
        : errorCode(last),
    );
  }

  async runOnce() {
    if (!this.config.enabled) throw Error("WATCH_WORKER_DISABLED");
    this.lock.acquire();
    let failed: WatchCheckpoint | undefined;
    try {
      let checkpoint = readCheckpoint(
        this.checkpointFile,
        this.config.startHeight,
      );
      failed = checkpoint;
      const latest = await this.retry(() => this.dependencies.probe());
      if (latest.providerAgreement !== "PASS")
        throw Error("WATCH_PROVIDER_DISAGREEMENT");
      if (checkpoint.lastHeight !== null) {
        const prior = await this.retry(() =>
          this.dependencies.probe(checkpoint.lastHeight!),
        );
        if (
          prior.blockHash.toLowerCase() !== checkpoint.lastHash!.toLowerCase()
        )
          throw Error("WATCH_REORG_DETECTED");
      }
      // probe-mainnet reports depth as tip-height. Match the exporter's
      // threshold exactly; payment confirmations remain tip-height+1.
      const finalizedTip = latest.tip - this.config.exportMinimumConfirmations;
      if (finalizedTip < 1) throw Error("WATCH_REMOTE_TIP_INVALID");
      checkpoint = {
        ...checkpoint,
        providerAgreement: "PASS",
        providerObservedAt: latest.observedAt,
        remoteTip: latest.tip,
        finalizedTip,
        updatedAt: this.dependencies.now(),
        lastError: null,
      };
      failed = checkpoint;
      if (checkpoint.nextHeight <= finalizedTip) {
        const count = Math.min(
          this.config.batchSize,
          finalizedTip - checkpoint.nextHeight + 1,
        );
        mkdirSync(this.staging, { recursive: true, mode: 0o700 });
        const batch = join(
          this.staging,
          `${checkpoint.nextHeight}-${checkpoint.nextHeight + count - 1}-${process.pid}`,
        );
        await this.retry(() =>
          this.dependencies.exportRange(checkpoint.nextHeight, count, batch),
        );
        const promoted = promoteAuthenticatedBatch(
          batch,
          this.corpus,
          this.config.exportMinimumConfirmations,
        );
        if (
          promoted.startHeight !== checkpoint.nextHeight ||
          promoted.endHeight !== checkpoint.nextHeight + count - 1
        )
          throw Error("WATCH_EXPORT_RANGE_MISMATCH");
        checkpoint = {
          ...checkpoint,
          nextHeight: promoted.endHeight + 1,
          lastHeight: promoted.endHeight,
          lastHash: promoted.lastHash,
          updatedAt: this.dependencies.now(),
        };
        failed = checkpoint;
        writeJsonAtomic(this.checkpointFile, checkpoint);
        rmSync(batch, { recursive: true, force: true });
      }
      if (checkpoint.nextHeight > finalizedTip) {
        const scan = await this.retry(() =>
          this.dependencies.scan(
            this.corpus,
            checkpoint.lastHeight ?? undefined,
          ),
        );
        checkpoint = {
          ...checkpoint,
          scanObservedAt: scan.observedAt,
          updatedAt: this.dependencies.now(),
        };
        failed = checkpoint;
      }
      writeJsonAtomic(this.checkpointFile, checkpoint);
      return this.status(checkpoint);
    } catch (error) {
      if (failed) {
        const failure = {
          ...failed,
          providerAgreement: errorCode(error).includes("DISAGREEMENT")
            ? ("FAILED" as const)
            : failed.providerAgreement,
          updatedAt: this.dependencies.now(),
          lastError: errorCode(error),
        };
        writeJsonAtomic(this.checkpointFile, failure);
      }
      throw error;
    } finally {
      this.lock.release();
    }
  }

  status(existing?: WatchCheckpoint) {
    const checkpoint =
      existing ?? readCheckpoint(this.checkpointFile, this.config.startHeight);
    const lag =
      checkpoint.finalizedTip === null || checkpoint.lastHeight === null
        ? null
        : Math.max(0, checkpoint.finalizedTip - checkpoint.lastHeight);
    const scanAge =
      checkpoint.scanObservedAt === null
        ? null
        : Math.max(0, this.dependencies.now() - checkpoint.scanObservedAt);
    const ready =
      checkpoint.providerAgreement === "PASS" &&
      checkpoint.lastError === null &&
      lag !== null &&
      lag <= this.config.maximumLagBlocks &&
      scanAge !== null &&
      scanAge <= this.config.maximumScanAgeSeconds;
    return {
      ready,
      network: "zcash-mainnet" as const,
      providerAgreement: checkpoint.providerAgreement,
      lastAuthenticatedHeight: checkpoint.lastHeight,
      authenticatedTargetHeight: checkpoint.finalizedTip,
      remoteTip: checkpoint.remoteTip,
      chainLagBlocks:
        checkpoint.remoteTip === null || checkpoint.lastHeight === null
          ? null
          : Math.max(0, checkpoint.remoteTip - checkpoint.lastHeight),
      lagBlocks: lag,
      scanAgeSeconds: scanAge,
      lastError: checkpoint.lastError,
      executionAvailable: false,
      signingAvailable: false,
      broadcastAvailable: false,
    };
  }
}

export function readOperationalStatus(
  state: string,
  now = Math.floor(Date.now() / 1000),
) {
  const read = (name: string) => {
    try {
      return JSON.parse(readFileSync(join(state, name), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  };
  const watch = read("watch-worker/checkpoint.json");
  const backup = read("backup/status.json");
  const scanAgeSeconds =
    typeof watch?.scanObservedAt === "number"
      ? Math.max(0, now - watch.scanObservedAt)
      : null;
  const backupAgeSeconds =
    typeof backup?.completedAt === "number"
      ? Math.max(0, now - backup.completedAt)
      : null;
  return {
    watch: watch
      ? {
          providerAgreement: watch.providerAgreement,
          lastAuthenticatedHeight: watch.lastHeight,
          authenticatedTargetHeight: watch.finalizedTip,
          remoteTip: watch.remoteTip,
          chainLagBlocks:
            typeof watch.remoteTip === "number" &&
            typeof watch.lastHeight === "number"
              ? Math.max(0, watch.remoteTip - watch.lastHeight)
              : null,
          lagBlocks:
            typeof watch.finalizedTip === "number" &&
            typeof watch.lastHeight === "number"
              ? Math.max(0, watch.finalizedTip - watch.lastHeight)
              : null,
          scanAgeSeconds,
          lastError:
            typeof watch.lastError === "string" ? watch.lastError : null,
        }
      : {
          providerAgreement: "UNVERIFIED",
          lastAuthenticatedHeight: null,
          authenticatedTargetHeight: null,
          remoteTip: null,
          chainLagBlocks: null,
          lagBlocks: null,
          scanAgeSeconds: null,
          lastError: "WATCH_NOT_STARTED",
        },
    backup: backup
      ? {
          state: backup.state,
          backupAgeSeconds,
          offHostVerified: backup.offHostVerified === true,
          restoreDrillVerified: backup.restoreDrillVerified === true,
        }
      : {
          state: "NOT_CONFIGURED",
          backupAgeSeconds: null,
          offHostVerified: false,
          restoreDrillVerified: false,
        },
  };
}
