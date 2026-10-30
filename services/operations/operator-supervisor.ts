// Supervised operator loop for the restricted pilot: SSH loopback tunnel,
// authenticated watch worker and operator sync heartbeat, kept together.
//
// One cycle: keep the tunnel up (restart with backoff after it exits), check
// both watch locks (evidence-preserving recovery only for abandoned locks;
// anything else stops the cycle), run one read-only worker cycle, then one
// sync cycle, then compare heartbeat and scan age with their limits. Worker and
// sync run one after the other as separate processes, so they never contend
// for the watch wallet, and each run is a fresh process: a crash only fails
// that step. Every failure names its stage. Nothing here signs, broadcasts or
// relaxes a check; when anything is wrong the pilot stays paused.
import type { LockRecovery } from "./stale-lock.ts";

export type SupervisorStage =
  "tunnel" | "lock" | "probe" | "export" | "scan" | "sync";

export interface StepResult {
  ok: boolean;
  /** Stage the failure came from (worker: probe/export/scan; sync: sync). */
  stage: SupervisorStage | null;
  code: string | null;
}

export interface TunnelHandle {
  /** Resolves with the exit code when the tunnel process ends. */
  exited: Promise<number | null>;
  stop(): void;
}

export type SupervisorAlert =
  | { alert: "TUNNEL_DOWN"; restartInMs: number }
  | {
      alert: "LOCK_RECOVERY_REFUSED";
      lock: string;
      reason: string;
      pid: number | null;
    }
  | { alert: "LOCK_RECOVERED"; lock: string; pid: number; evidence: string }
  | {
      alert: "STAGE_FAILING";
      stage: SupervisorStage;
      code: string | null;
      consecutive: number;
    }
  | {
      alert: "HEARTBEAT_STALE";
      ageSeconds: number | null;
      limitSeconds: number;
    }
  | { alert: "SCAN_STALE"; ageSeconds: number | null; limitSeconds: number };

export interface SupervisorDeps {
  now(): number;
  startTunnel(): TunnelHandle;
  recoverLocks(): LockRecovery[];
  runWorkerOnce(): Promise<StepResult>;
  runSyncOnce(): Promise<StepResult>;
  /** Unix seconds of the latest verified heartbeat the API accepted, and of the last wallet scan. */
  health(): Promise<{
    heartbeatObservedAt: number | null;
    scanObservedAt: number | null;
  }>;
  alert(a: SupervisorAlert): void;
  log(event: Record<string, unknown>): void;
}

export interface SupervisorPolicy {
  heartbeatStaleSeconds: number;
  scanStaleSeconds: number;
  /** Alert once a stage has failed this many cycles in a row. */
  failureAlertAfter: number;
  tunnelBackoffMs: { initial: number; max: number };
}

export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = {
  heartbeatStaleSeconds: 900,
  scanStaleSeconds: 1800,
  failureAlertAfter: 3,
  tunnelBackoffMs: { initial: 1_000, max: 60_000 },
};

export interface CycleReport {
  tunnelUp: boolean;
  locks: LockRecovery[];
  worker: StepResult | null;
  sync: StepResult | null;
  alerts: SupervisorAlert[];
}

export class OperatorSupervisor {
  private tunnel: TunnelHandle | null = null;
  private tunnelAlive = false;
  private tunnelBackoff: number;
  private tunnelRestartAt = 0;
  private streaks = new Map<SupervisorStage, number>();

  constructor(
    private readonly deps: SupervisorDeps,
    private readonly policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY,
  ) {
    this.tunnelBackoff = policy.tunnelBackoffMs.initial;
  }

  /** Keep exactly one tunnel process; restart after exit with exponential backoff. */
  private ensureTunnel(alerts: SupervisorAlert[]): boolean {
    if (this.tunnelAlive) return true;
    const nowMs = this.deps.now() * 1000;
    if (nowMs < this.tunnelRestartAt) {
      const a = {
        alert: "TUNNEL_DOWN" as const,
        restartInMs: Math.max(0, this.tunnelRestartAt - nowMs),
      };
      alerts.push(a);
      this.deps.alert(a);
      return false;
    }
    const handle = this.deps.startTunnel();
    this.tunnel = handle;
    this.tunnelAlive = true;
    this.deps.log({ event: "TUNNEL_STARTED" });
    void handle.exited.then((code) => {
      if (this.tunnel !== handle) return;
      this.tunnelAlive = false;
      this.tunnel = null;
      this.tunnelRestartAt = this.deps.now() * 1000 + this.tunnelBackoff;
      this.deps.log({
        event: "TUNNEL_EXITED",
        code,
        restartInMs: this.tunnelBackoff,
      });
      this.tunnelBackoff = Math.min(
        this.policy.tunnelBackoffMs.max,
        this.tunnelBackoff * 2,
      );
    });
    return true;
  }

  private record(
    kind: "worker" | "sync" | "lock",
    result: StepResult,
    alerts: SupervisorAlert[],
  ) {
    if (result.ok) {
      const cleared: SupervisorStage[] =
        kind === "worker" ? ["probe", "export", "scan"] : [kind];
      for (const s of cleared) this.streaks.delete(s);
      // A successful sync proves the tunnel works again.
      if (kind === "sync")
        this.tunnelBackoff = this.policy.tunnelBackoffMs.initial;
      return;
    }
    const failed: SupervisorStage =
      result.stage ?? (kind === "worker" ? "scan" : kind);
    const n = (this.streaks.get(failed) ?? 0) + 1;
    this.streaks.set(failed, n);
    if (n >= this.policy.failureAlertAfter) {
      const a = {
        alert: "STAGE_FAILING" as const,
        stage: failed,
        code: result.code,
        consecutive: n,
      };
      alerts.push(a);
      this.deps.alert(a);
    }
  }

  async cycle(): Promise<CycleReport> {
    const alerts: SupervisorAlert[] = [];
    const tunnelUp = this.ensureTunnel(alerts);
    const locks = this.deps.recoverLocks();
    let blocked = false;
    for (const l of locks) {
      if (l.action === "refused") {
        blocked = true;
        const a = {
          alert: "LOCK_RECOVERY_REFUSED" as const,
          lock: l.lock,
          reason: l.reason,
          pid: l.pid,
        };
        alerts.push(a);
        this.deps.alert(a);
      } else if (l.action === "recovered") {
        const a = {
          alert: "LOCK_RECOVERED" as const,
          lock: l.lock,
          pid: l.pid,
          evidence: l.evidence,
        };
        alerts.push(a);
        this.deps.alert(a);
      }
    }
    let worker: StepResult | null = null;
    let sync: StepResult | null = null;
    if (blocked) {
      // Fail closed: an unrecoverable lock means a live or unknown owner.
      this.record(
        "lock",
        { ok: false, stage: "lock", code: "LOCK_RECOVERY_REFUSED" },
        alerts,
      );
    } else {
      this.streaks.delete("lock");
      worker = await this.deps.runWorkerOnce();
      this.record("worker", worker, alerts);
      if (tunnelUp) {
        sync = await this.deps.runSyncOnce();
        this.record("sync", sync, alerts);
      }
    }
    const h = await this.deps.health();
    const now = this.deps.now();
    const age = (t: number | null) =>
      t === null ? null : Math.max(0, now - t);
    const hb = age(h.heartbeatObservedAt);
    if (hb === null || hb > this.policy.heartbeatStaleSeconds) {
      const a = {
        alert: "HEARTBEAT_STALE" as const,
        ageSeconds: hb,
        limitSeconds: this.policy.heartbeatStaleSeconds,
      };
      alerts.push(a);
      this.deps.alert(a);
    }
    const scan = age(h.scanObservedAt);
    if (scan === null || scan > this.policy.scanStaleSeconds) {
      const a = {
        alert: "SCAN_STALE" as const,
        ageSeconds: scan,
        limitSeconds: this.policy.scanStaleSeconds,
      };
      alerts.push(a);
      this.deps.alert(a);
    }
    const report = { tunnelUp, locks, worker, sync, alerts };
    this.deps.log({
      event: "CYCLE",
      tunnelUp,
      worker: worker && {
        ok: worker.ok,
        stage: worker.stage,
        code: worker.code,
      },
      sync: sync && { ok: sync.ok, code: sync.code },
      heartbeatAgeSeconds: hb,
      scanAgeSeconds: scan,
      alerts: alerts.map((a) => a.alert),
    });
    return report;
  }

  stop() {
    const t = this.tunnel;
    this.tunnel = null;
    this.tunnelAlive = false;
    t?.stop();
  }
}

/** Remove every occurrence of each secret from text before it is logged. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets)
    if (s.length >= 8) out = out.split(s).join("<redacted>");
  return out;
}

/** Parse the last JSON line of a worker `once` run into a step result. */
export function workerStepResult(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): StepResult {
  const last = (text: string) => {
    const lines = text.trim().split(/\r?\n/).reverse();
    for (const l of lines)
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        /* not JSON */
      }
    return null;
  };
  const out = last(stdout);
  if (exitCode === 0 && out?.event === "WATCH_CYCLE")
    return { ok: true, stage: null, code: null };
  const err = last(stderr) ?? {};
  const stage =
    err.stage === "probe" || err.stage === "export" || err.stage === "scan"
      ? err.stage
      : null;
  const code =
    typeof err.error === "string"
      ? err.error
      : typeof err.code === "string"
        ? err.code
        : "WATCH_WORKER_EXITED";
  return {
    ok: false,
    stage,
    code: /^[A-Z0-9_]{1,96}$/.test(code) ? code : "WATCH_WORKER_FAILED",
  };
}

/** Parse an operator-sync `--once` run into a step result. */
export function syncStepResult(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): StepResult {
  const lines = `${stdout}\n${stderr}`.trim().split(/\r?\n/).reverse();
  for (const l of lines) {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    if (j.ok === true && exitCode === 0)
      return { ok: true, stage: null, code: null };
    const code =
      typeof j.error === "string" && /^[A-Z0-9_]{1,96}$/.test(j.error)
        ? j.error
        : "SYNC_FAILED";
    return { ok: false, stage: "sync", code };
  }
  return { ok: false, stage: "sync", code: "SYNC_EXITED" };
}
