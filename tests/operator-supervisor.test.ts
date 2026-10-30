// Operator supervision: abandoned-lock recovery, fail-closed cycles, stage
// reporting, stale heartbeat/scan alerts and tunnel restart. Synthetic only:
// no processes, network, keys or funds.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lockOwner,
  recoverStaleLock,
  type LockOwnerProbe,
} from "../services/operations/stale-lock.ts";
import {
  OperatorSupervisor,
  scrubSecrets,
  syncStepResult,
  workerStepResult,
  type StepResult,
  type SupervisorAlert,
  type SupervisorDeps,
  type TunnelHandle,
} from "../services/operations/operator-supervisor.ts";
import {
  MainnetWatchWorker,
  readCheckpoint,
  type WatchWorkerConfig,
} from "../services/operations/mainnet-watch-worker.ts";

const dead: LockOwnerProbe = { alive: () => false, holders: () => [] };

function leftLocks() {
  const dir = mkdtempSync(join(tmpdir(), "zecone-locks-"));
  mkdirSync(join(dir, "watch-worker"));
  mkdirSync(join(dir, "wallet"));
  // As left by a killed worker (JSON) and a killed watch binary (bare PID).
  const workerLock = join(dir, "watch-worker", "worker.lock");
  const walletLock = join(dir, "wallet", "process.lock");
  writeFileSync(workerLock, JSON.stringify({ pid: 424242 }) + "\n");
  writeFileSync(walletLock, "424243");
  return {
    dir,
    workerLock,
    walletLock,
    evidence: join(dir, "recovery-evidence"),
  };
}

test("lock: abnormal interruption leaves each lock; both formats name their owner", () => {
  const l = leftLocks();
  assert.equal(lockOwner(l.workerLock), 424242);
  assert.equal(lockOwner(l.walletLock), 424243);
});

test("lock: safe recovery with no live owner preserves the lock as evidence first", () => {
  const l = leftLocks();
  for (const [lock, pid] of [
    [l.workerLock, 424242],
    [l.walletLock, 424243],
  ] as const) {
    const before = readFileSync(lock);
    const r = recoverStaleLock(lock, l.evidence, dead, 1_800_000_000);
    assert.equal(r.action, "recovered");
    if (r.action !== "recovered") continue;
    assert.equal(r.pid, pid);
    assert.equal(existsSync(lock), false);
    assert.ok(
      readFileSync(r.evidence).equals(before),
      "evidence is the exact lock",
    );
    const note = JSON.parse(
      readFileSync(`${r.evidence}.recovery.json`, "utf8"),
    );
    assert.equal(note.pid, pid);
    assert.match(note.reason, /PID absent/);
  }
  assert.equal(recoverStaleLock(l.workerLock, l.evidence, dead).action, "none");
});

test("lock: refuses a live owner, a held profile or an unreadable lock, and leaves them untouched", () => {
  const l = leftLocks();
  const live = recoverStaleLock(l.workerLock, l.evidence, {
    alive: (pid) => pid === 424242,
    holders: () => [],
  });
  assert.deepEqual(
    [live.action, live.action === "refused" && live.reason],
    ["refused", "LOCK_OWNER_ALIVE"],
  );
  const held = recoverStaleLock(l.walletLock, l.evidence, {
    alive: () => false,
    holders: () => [777],
  });
  assert.deepEqual(
    [held.action, held.action === "refused" && held.reason],
    ["refused", "PROFILE_HELD"],
  );
  writeFileSync(l.workerLock, "not a pid");
  const bad = recoverStaleLock(l.workerLock, l.evidence, dead);
  assert.deepEqual(
    [bad.action, bad.action === "refused" && bad.reason],
    ["refused", "LOCK_UNREADABLE"],
  );
  assert.ok(
    existsSync(l.workerLock) && existsSync(l.walletLock),
    "refused locks are never removed",
  );
  assert.equal(existsSync(l.evidence), false, "nothing was moved");
});

// ---- supervisor core ----

function harness(
  opts: {
    locks?: () => ReturnType<SupervisorDeps["recoverLocks"]>;
    worker?: () => StepResult;
    sync?: () => StepResult;
    heartbeatAge?: number | null;
    scanAge?: number | null;
  } = {},
) {
  let now = 1_800_000_000;
  const alerts: SupervisorAlert[] = [];
  const calls = { worker: 0, sync: 0, tunnels: 0 };
  const tunnels: { exit(code: number): void; stopped: boolean }[] = [];
  const deps: SupervisorDeps = {
    now: () => now,
    log: () => undefined,
    alert: (a) => alerts.push(a),
    startTunnel(): TunnelHandle {
      calls.tunnels++;
      let exit!: (c: number) => void;
      const t = { exit: (c: number) => exit(c), stopped: false };
      tunnels.push(t);
      return {
        exited: new Promise((r) => (exit = r)),
        stop: () => (t.stopped = true),
      };
    },
    recoverLocks: opts.locks ?? (() => []),
    runWorkerOnce: async () => {
      calls.worker++;
      return (opts.worker ?? (() => ({ ok: true, stage: null, code: null })))();
    },
    runSyncOnce: async () => {
      calls.sync++;
      return (opts.sync ?? (() => ({ ok: true, stage: null, code: null })))();
    },
    health: async () => ({
      heartbeatObservedAt:
        opts.heartbeatAge === null ? null : now - (opts.heartbeatAge ?? 60),
      scanObservedAt: opts.scanAge === null ? null : now - (opts.scanAge ?? 60),
    }),
  };
  const s = new OperatorSupervisor(deps, {
    heartbeatStaleSeconds: 900,
    scanStaleSeconds: 1800,
    failureAlertAfter: 3,
    tunnelBackoffMs: { initial: 1_000, max: 8_000 },
  });
  return { s, alerts, calls, tunnels, advance: (sec: number) => (now += sec) };
}

test("supervisor: an unrecoverable lock stops the cycle (no worker, no sync) and alerts", async () => {
  const h = harness({
    locks: () => [
      {
        action: "refused",
        lock: "worker.lock",
        reason: "LOCK_OWNER_ALIVE",
        pid: 9,
      },
    ],
  });
  const r = await h.s.cycle();
  assert.equal(r.worker, null);
  assert.equal(r.sync, null);
  assert.deepEqual([h.calls.worker, h.calls.sync], [0, 0]);
  assert.ok(
    h.alerts.some(
      (a) =>
        a.alert === "LOCK_RECOVERY_REFUSED" && a.reason === "LOCK_OWNER_ALIVE",
    ),
  );
});

test("supervisor: a recovered lock is reported with its evidence, then the cycle runs", async () => {
  const h = harness({
    locks: () => [
      {
        action: "recovered",
        lock: "process.lock",
        pid: 5,
        evidence: "/e/process.lock",
      },
    ],
  });
  await h.s.cycle();
  assert.deepEqual([h.calls.worker, h.calls.sync], [1, 1]);
  assert.ok(
    h.alerts.some(
      (a) => a.alert === "LOCK_RECOVERED" && a.evidence === "/e/process.lock",
    ),
  );
});

test("supervisor: repeated scan failure names the stage after the threshold and resets on success", async () => {
  let failing = true;
  const h = harness({
    worker: () =>
      failing
        ? { ok: false, stage: "scan", code: "WATCH_RETRY_EXHAUSTED" }
        : { ok: true, stage: null, code: null },
  });
  for (let i = 1; i <= 2; i++) {
    await h.s.cycle();
    assert.equal(
      h.alerts.filter((a) => a.alert === "STAGE_FAILING").length,
      0,
      `cycle ${i}`,
    );
  }
  await h.s.cycle();
  const a = h.alerts.find((x) => x.alert === "STAGE_FAILING");
  assert.deepEqual(a, {
    alert: "STAGE_FAILING",
    stage: "scan",
    code: "WATCH_RETRY_EXHAUSTED",
    consecutive: 3,
  });
  failing = false;
  await h.s.cycle();
  failing = true;
  const before = h.alerts.length;
  await h.s.cycle();
  await h.s.cycle();
  assert.equal(
    h.alerts.slice(before).filter((x) => x.alert === "STAGE_FAILING").length,
    0,
    "streak reset",
  );
});

test("supervisor: each failing stage is reported separately (probe, export, sync)", async () => {
  for (const stage of ["probe", "export"] as const) {
    const h = harness({
      worker: () => ({ ok: false, stage, code: "WATCH_RETRY_EXHAUSTED" }),
    });
    for (let i = 0; i < 3; i++) await h.s.cycle();
    assert.ok(
      h.alerts.some((a) => a.alert === "STAGE_FAILING" && a.stage === stage),
      stage,
    );
  }
  const h = harness({
    sync: () => ({
      ok: false,
      stage: "sync",
      code: "REMOTE_HEARTBEAT_INVALID",
    }),
  });
  for (let i = 0; i < 3; i++) await h.s.cycle();
  assert.ok(
    h.alerts.some(
      (a) =>
        a.alert === "STAGE_FAILING" &&
        a.stage === "sync" &&
        a.code === "REMOTE_HEARTBEAT_INVALID",
    ),
  );
});

test("supervisor: stale or missing heartbeat and scan raise alerts; fresh ones do not", async () => {
  const fresh = harness();
  await fresh.s.cycle();
  assert.deepEqual(fresh.alerts, []);
  const stale = harness({ heartbeatAge: 901, scanAge: 1801 });
  await stale.s.cycle();
  assert.deepEqual(
    stale.alerts.map((a) => a.alert),
    ["HEARTBEAT_STALE", "SCAN_STALE"],
  );
  const missing = harness({ heartbeatAge: null, scanAge: null });
  await missing.s.cycle();
  assert.ok(
    missing.alerts.some(
      (a) => a.alert === "HEARTBEAT_STALE" && a.ageSeconds === null,
    ),
  );
});

test("supervisor: the tunnel restarts after it exits, with backoff, never two at once; sync waits for it", async () => {
  const h = harness();
  await h.s.cycle();
  assert.equal(h.calls.tunnels, 1);
  await h.s.cycle();
  assert.equal(h.calls.tunnels, 1, "a live tunnel is reused");
  h.tunnels[0].exit(255);
  await new Promise((r) => setImmediate(r));
  const syncs = h.calls.sync;
  const r = await h.s.cycle(); // inside the 1 s backoff
  assert.equal(r.tunnelUp, false);
  assert.equal(h.calls.sync, syncs, "no sync without the tunnel");
  assert.ok(h.alerts.some((a) => a.alert === "TUNNEL_DOWN"));
  h.advance(2);
  await h.s.cycle();
  assert.equal(h.calls.tunnels, 2, "restarted after backoff");
  h.s.stop();
  assert.equal(h.tunnels[1].stopped, true);
});

test("supervisor: child output parsing keeps codes and stages, drops anything unexpected", () => {
  assert.deepEqual(
    workerStepResult(`{"event":"WATCH_CYCLE","ready":true}\n`, "", 0),
    { ok: true, stage: null, code: null },
  );
  assert.deepEqual(
    workerStepResult(
      "",
      `{"error":"WATCH_RETRY_EXHAUSTED","stage":"scan"}\n`,
      1,
    ),
    {
      ok: false,
      stage: "scan",
      code: "WATCH_RETRY_EXHAUSTED",
    },
  );
  assert.deepEqual(
    workerStepResult(
      "",
      "panic: something with https://secret.example/abc\n",
      101,
    ),
    {
      ok: false,
      stage: null,
      code: "WATCH_WORKER_EXITED",
    },
  );
  assert.deepEqual(
    syncStepResult(`{"at":"x","ok":true,"pushed":[]}\n`, "", 0),
    { ok: true, stage: null, code: null },
  );
  assert.deepEqual(
    syncStepResult(
      `{"at":"x","ok":false,"error":"mainnet_watch_scan_failed","pushed":[]}\n`,
      "",
      0,
    ),
    {
      ok: false,
      stage: "sync",
      code: "SYNC_FAILED",
    },
  );
  assert.equal(syncStepResult("", "", 1).code, "SYNC_EXITED");
});

test("supervisor: secrets are scrubbed from anything logged", () => {
  const secret = "https://shared.example.getblock.io/0123456789abcdef";
  assert.equal(
    scrubSecrets(`failed ${secret} and ${secret}`, [secret]),
    "failed <redacted> and <redacted>",
  );
  assert.equal(
    scrubSecrets("short", ["abc"]),
    "short",
    "trivially short values are not treated as secrets",
  );
});

// ---- worker stage reporting ----

const workerConfig: WatchWorkerConfig = {
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

test("worker: a failed cycle records which stage failed (probe, export, scan)", async () => {
  const cases: {
    stage: string;
    tip: number;
    fail: "probe" | "export" | "scan";
  }[] = [
    { stage: "probe", tip: 200, fail: "probe" },
    { stage: "export", tip: 200, fail: "export" },
    { stage: "scan", tip: 105, fail: "scan" }, // nothing to export yet: straight to the wallet scan
  ];
  for (const c of cases) {
    const state = mkdtempSync(join(tmpdir(), "zecone-stage-"));
    const boom = () => {
      throw Error("provider detail with https://secret.example/key");
    };
    const w = new MainnetWatchWorker(state, workerConfig, {
      now: () => 1_800_000_000,
      sleep: async () => undefined,
      probe: async (height) => {
        if (c.fail === "probe") boom();
        return {
          tip: c.tip,
          height: height ?? c.tip - 10,
          blockHash: "0".repeat(64),
          providerAgreement: "PASS",
          observedAt: 1_800_000_000,
        };
      },
      exportRange: async () => boom(),
      scan: async () => boom(),
    });
    await assert.rejects(
      w.runOnce(),
      (e: Error & { stage?: string }) =>
        e.message === "WATCH_RETRY_EXHAUSTED" && e.stage === c.stage,
    );
    const cp = readCheckpoint(
      join(state, "watch-worker", "checkpoint.json"),
      workerConfig.startHeight,
    );
    assert.equal(cp.lastErrorStage, c.stage, c.stage);
    assert.equal(w.status().lastErrorStage, c.stage);
    assert.doesNotMatch(
      readFileSync(join(state, "watch-worker", "checkpoint.json"), "utf8"),
      /secret\.example/,
    );
    assert.equal(
      readdirSync(join(state, "watch-worker")).includes("worker.lock"),
      false,
      "lock released after failure",
    );
  }
});
