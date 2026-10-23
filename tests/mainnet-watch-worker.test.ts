import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExclusiveFileLock,
  MainnetWatchWorker,
  errorCode,
  promoteAuthenticatedBatch,
  readCheckpoint,
  readOperationalStatus,
  type WatchWorkerConfig,
} from "../services/operations/mainnet-watch-worker.ts";

const hash = (n: number) => n.toString(16).padStart(64, "0");
const config: WatchWorkerConfig = {
  enabled: true,
  network: "zcash-mainnet",
  startHeight: 100,
  minimumConfirmations: 20,
  exportMinimumConfirmations: 10,
  batchSize: 3,
  maxRetries: 2,
  retryBaseMs: 100,
  maximumLagBlocks: 2,
  maximumScanAgeSeconds: 600,
};

function fixture() {
  const state = mkdtempSync(join(tmpdir(), "zecone-watch-worker-"));
  let now = 1_800_000_000,
    tip = 114,
    scanCalls = 0,
    exportCalls = 0;
  const worker = () =>
    new MainnetWatchWorker(state, config, {
      now: () => now,
      sleep: async () => undefined,
      probe: async (height) => ({
        tip,
        height: height ?? tip - 10,
        blockHash: hash(height ?? tip - 10),
        providerAgreement: "PASS",
        observedAt: now,
      }),
      exportRange: async (start, count, output) => {
        exportCalls += 1;
        mkdirSync(output, { recursive: true });
        const blocks = [];
        for (let height = start; height < start + count; height += 1) {
          const bytes = Buffer.from(`public-block-${height}`),
            digest = createHash("sha256").update(bytes).digest("hex");
          writeFileSync(join(output, `${height}-${hash(height)}.bin`), bytes);
          blocks.push({ height, hash: hash(height), sha256: digest });
        }
        writeFileSync(
          join(output, "authenticated-block-manifest.json"),
          JSON.stringify({
            network: "zcash-mainnet",
            startHeight: start,
            endHeight: start + count - 1,
            minimumConfirmations: config.exportMinimumConfirmations,
            chainContinuity: "PASS",
            blocks,
          }),
        );
      },
      scan: async () => {
        scanCalls += 1;
        return { observedAt: now };
      },
    });
  return {
    state,
    worker,
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
    set tip(v: number) {
      tip = v;
    },
    get scans() {
      return scanCalls;
    },
    get exports() {
      return exportCalls;
    },
  };
}

test("checkpoint advances atomically, catches the authenticated target, and resumes without skipping", async () => {
  const f = fixture();
  const first = await f.worker().runOnce();
  assert.equal(first.lastAuthenticatedHeight, 102);
  assert.equal(first.authenticatedTargetHeight, 104);
  assert.equal(first.ready, false);
  assert.equal(f.exports, 1);
  assert.equal(f.scans, 0);
  const caughtUp = await f.worker().runOnce();
  assert.equal(caughtUp.lastAuthenticatedHeight, 104);
  assert.equal(caughtUp.ready, true);
  assert.equal(f.scans, 1);
  assert.equal(
    readCheckpoint(join(f.state, "watch-worker/checkpoint.json"), 100)
      .nextHeight,
    105,
  );
  assert.ok(
    existsSync(
      join(
        f.state,
        "watch-worker/authenticated-blocks/100-" + hash(100) + ".bin",
      ),
    ),
  );
  assert.ok(
    existsSync(
      join(
        f.state,
        "watch-worker/authenticated-blocks/104-" + hash(104) + ".bin",
      ),
    ),
    "the recent authenticated target range must be present before readiness",
  );
});

test("lock contention and corrupt checkpoints fail closed", async () => {
  const f = fixture(),
    lockPath = join(f.state, "watch-worker/worker.lock"),
    lock = new ExclusiveFileLock(lockPath);
  lock.acquire();
  await assert.rejects(f.worker().runOnce(), /WATCH_WORKER_LOCKED/);
  lock.release();
  mkdirSync(join(f.state, "watch-worker"), { recursive: true });
  writeFileSync(join(f.state, "watch-worker/checkpoint.json"), "not-json");
  await assert.rejects(f.worker().runOnce(), /WATCH_CHECKPOINT_CORRUPT/);
});

test("corrupt checkpoints release the worker lock", async () => {
  const f = fixture(),
    lockPath = join(f.state, "watch-worker/worker.lock");
  mkdirSync(join(f.state, "watch-worker"), { recursive: true });
  writeFileSync(join(f.state, "watch-worker/checkpoint.json"), "not-json");
  await assert.rejects(f.worker().runOnce(), /WATCH_CHECKPOINT_CORRUPT/);
  assert.equal(existsSync(lockPath), false);
});

test("authenticated batches require contiguous manifest heights", () => {
  const batch = mkdtempSync(join(tmpdir(), "zecone-watch-batch-")),
    corpus = mkdtempSync(join(tmpdir(), "zecone-watch-corpus-")),
    blocks = [100, 102, 103].map((height) => {
      const bytes = Buffer.from(`public-block-${height}`),
        sha256 = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(join(batch, `${height}-${hash(height)}.bin`), bytes);
      return { height, hash: hash(height), sha256 };
    });
  writeFileSync(
    join(batch, "authenticated-block-manifest.json"),
    JSON.stringify({
      network: "zcash-mainnet",
      startHeight: 100,
      endHeight: 102,
      minimumConfirmations: 10,
      chainContinuity: "PASS",
      blocks,
    }),
  );
  assert.throws(
    () => promoteAuthenticatedBatch(batch, corpus, 10),
    /WATCH_EXPORT_MANIFEST_INVALID/,
  );
});

test("provider disagreement, reorg, and retry exhaustion never advance", async () => {
  const f = fixture();
  const disagreement = new MainnetWatchWorker(f.state, config, {
    now: () => f.now,
    sleep: async () => undefined,
    probe: async () => {
      throw Error("WATCH_PROVIDER_DISAGREEMENT");
    },
    exportRange: async () => assert.fail(),
    scan: async () => assert.fail(),
  });
  await assert.rejects(disagreement.runOnce(), /WATCH_PROVIDER_DISAGREEMENT/);
  assert.equal(
    readCheckpoint(join(f.state, "watch-worker/checkpoint.json"), 100)
      .nextHeight,
    100,
  );
  await f.worker().runOnce();
  const reorg = new MainnetWatchWorker(f.state, config, {
    now: () => f.now,
    sleep: async () => undefined,
    probe: async (height) => ({
      tip: 114,
      height: height ?? 112,
      blockHash: hash((height ?? 112) + (height ? 1 : 0)),
      providerAgreement: "PASS",
      observedAt: f.now,
    }),
    exportRange: async () => assert.fail(),
    scan: async () => assert.fail(),
  });
  await assert.rejects(reorg.runOnce(), /WATCH_REORG_DETECTED/);
  const exhausted = new MainnetWatchWorker(
    mkdtempSync(join(tmpdir(), "zecone-retry-")),
    config,
    {
      now: () => f.now,
      sleep: async () => undefined,
      probe: async () => {
        throw Error("temporary network detail containing secret URL");
      },
      exportRange: async () => assert.fail(),
      scan: async () => assert.fail(),
    },
  );
  await assert.rejects(exhausted.runOnce(), /WATCH_RETRY_EXHAUSTED/);
});

test("stale scan, backup gaps, and diagnostics are privacy-safe", async () => {
  const f = fixture();
  await f.worker().runOnce();
  f.now += 601;
  assert.equal(f.worker().status().ready, false);
  const status = readOperationalStatus(f.state, f.now);
  assert.equal(status.backup.offHostVerified, false);
  assert.equal(status.backup.restoreDrillVerified, false);
  const diagnostic = JSON.stringify(status);
  assert.doesNotMatch(diagnostic, /txid|recipient|address|payment/i);
  assert.equal(
    errorCode(Error("https://provider.invalid/?api_key=secret")),
    "WATCH_WORKER_FAILED",
  );
});

test("operational worker sources contain no signer, submitter, broadcaster, or refund access", () => {
  const sources = [
    readFileSync("services/operations/mainnet-watch-worker.ts", "utf8"),
    readFileSync("scripts/mainnet-watch-worker.ts", "utf8"),
  ].join("\n");
  assert.doesNotMatch(
    sources,
    /from ["'][^"']*(?:mainnet-signer|mainnet-submitter)|broadcastTransaction|sendRawTransaction|executeRefund/,
  );
});
