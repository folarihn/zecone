// Evidence-preserving recovery of locks abandoned by interrupted watch runs.
//
// Two locks guard the watch wallet: the worker's `watch-worker/worker.lock`
// (JSON `{"pid":n}`, also taken by the operator sync's bridge) and the Rust
// watch binary's `<wallet>/process.lock` (a bare PID). A killed process leaves
// either behind and every later cycle fails. A lock is never deleted silently:
// recovery happens only when the recorded PID is absent AND no relevant
// process holds the profile, and only after the lock is copied into the
// evidence directory and the copy verified. Anything else is refused and left
// exactly as found for the operator.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

export interface LockOwnerProbe {
  /** True if a process with this PID currently exists (any program). */
  alive(pid: number): boolean;
  /** PIDs of running processes that can hold the watch profile (watch binary, worker, sync). */
  holders(): number[];
}

export type LockRecovery =
  | { action: "none"; lock: string }
  | { action: "recovered"; lock: string; pid: number; evidence: string }
  | {
      action: "refused";
      lock: string;
      reason: "LOCK_UNREADABLE" | "LOCK_OWNER_ALIVE" | "PROFILE_HELD";
      pid: number | null;
      holders?: number[];
    };

/** The PID recorded in a worker lock (`{"pid":n}`) or a watch-binary lock (`n`). */
export function lockOwner(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  let pid: unknown = text;
  if (text.startsWith("{")) {
    try {
      pid = (JSON.parse(text) as { pid?: unknown }).pid;
    } catch {
      return null;
    }
  }
  const n =
    typeof pid === "number"
      ? pid
      : /^[1-9][0-9]{0,9}$/.test(String(pid))
        ? Number(pid)
        : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function recoverStaleLock(
  lock: string,
  evidenceDir: string,
  probe: LockOwnerProbe,
  now = Math.floor(Date.now() / 1000),
): LockRecovery {
  if (!existsSync(lock)) return { action: "none", lock };
  const pid = lockOwner(lock);
  if (pid === null)
    return { action: "refused", lock, reason: "LOCK_UNREADABLE", pid: null };
  const holders = probe.holders();
  if (holders.length)
    return { action: "refused", lock, reason: "PROFILE_HELD", pid, holders };
  // A live PID is refused even if it may be a reused number: only the operator
  // can tell, so the lock stays.
  if (probe.alive(pid))
    return { action: "refused", lock, reason: "LOCK_OWNER_ALIVE", pid };
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const stamp = new Date(now * 1000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const evidence = join(evidenceDir, `${stamp}-${basename(lock)}`);
  const original = readFileSync(lock);
  copyFileSync(lock, evidence);
  if (!readFileSync(evidence).equals(original))
    throw Error("LOCK_EVIDENCE_COPY_MISMATCH");
  writeFileSync(
    `${evidence}.recovery.json`,
    JSON.stringify({
      lock,
      pid,
      lockWrittenAt: Math.floor(statSync(lock).mtimeMs / 1000),
      recoveredAt: now,
      reason: "recorded PID absent and no process holds the watch profile",
    }) + "\n",
    { mode: 0o600 },
  );
  unlinkSync(lock);
  return { action: "recovered", lock, pid, evidence };
}
