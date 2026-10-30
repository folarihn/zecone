// Single-writer lease and independent emergency-pause control for mainnet
// operators. Every financial mutation must be fenced by this token. A crashed
// process is recovered only by an explicit operator action, with a new fence;
// the previous process then fails its next guard instead of continuing.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type MainnetLeaseState = {
  state: "absent" | "held" | "expired";
  owner: string | null;
  fence: number;
  acquired: number | null;
  expires: number | null;
  remainingSeconds: number;
  recoveries: number;
  paused: boolean;
  pauseReason: string | null;
};

export type MainnetLeaseToken = {
  token: string;
  owner: string;
  fence: number;
  expires: number;
};

export class MainnetExecutionLease {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly now = () => Math.floor(Date.now() / 1000),
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mainnet_execution_lease(
        id INTEGER PRIMARY KEY CHECK(id=1),
        token TEXT NOT NULL,
        owner TEXT NOT NULL,
        fence INTEGER NOT NULL,
        acquired INTEGER NOT NULL,
        heartbeat INTEGER NOT NULL,
        expires INTEGER NOT NULL,
        recoveries INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mainnet_operator_control(
        id INTEGER PRIMARY KEY CHECK(id=1),
        paused INTEGER NOT NULL,
        reason TEXT,
        changed INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO mainnet_operator_control(id,paused,reason,changed)
        VALUES(1,1,'DEFAULT_PAUSED',0);
      CREATE TABLE IF NOT EXISTS mainnet_execution_fence(
        id INTEGER PRIMARY KEY CHECK(id=1),
        fence INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO mainnet_execution_fence(id,fence) VALUES(1,0);`);
  }

  close() {
    this.db.close();
  }

  private atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private control() {
    return this.db
      .prepare(
        "SELECT paused,reason,changed FROM mainnet_operator_control WHERE id=1",
      )
      .get() as { paused: number; reason: string | null; changed: number };
  }

  status(): MainnetLeaseState {
    const row = this.db
        .prepare("SELECT * FROM mainnet_execution_lease WHERE id=1")
        .get() as
        | {
            owner: string;
            fence: number;
            acquired: number;
            expires: number;
            recoveries: number;
          }
        | undefined,
      control = this.control(),
      counter = this.db
        .prepare("SELECT fence FROM mainnet_execution_fence WHERE id=1")
        .get() as { fence: number },
      now = this.now();
    return {
      state: !row ? "absent" : row.expires > now ? "held" : "expired",
      owner: row?.owner ?? null,
      fence: row?.fence ?? counter.fence,
      acquired: row?.acquired ?? null,
      expires: row?.expires ?? null,
      remainingSeconds: row ? Math.max(0, row.expires - now) : 0,
      recoveries: row?.recoveries ?? 0,
      paused: control.paused === 1,
      pauseReason: control.reason,
    };
  }

  acquire(
    owner: string,
    options: {
      recoverExpired?: boolean;
      ttlSeconds?: number;
    } = {},
  ): MainnetLeaseToken {
    if (!owner.trim() || owner.length > 128)
      throw Error("LEASE_OWNER_REQUIRED");
    const ttl = options.ttlSeconds ?? 300,
      now = this.now();
    if (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > 900)
      throw Error("INVALID_LEASE_TTL");
    return this.atomic(() => {
      const old = this.db
          .prepare(
            "SELECT fence,expires,recoveries FROM mainnet_execution_lease WHERE id=1",
          )
          .get() as
          { fence: number; expires: number; recoveries: number } | undefined,
        prior = this.db
          .prepare("SELECT fence FROM mainnet_execution_fence WHERE id=1")
          .get() as { fence: number };
      if (old && old.expires > now) throw Error("MAINNET_EXECUTION_LEASE_HELD");
      if (old && !options.recoverExpired)
        throw Error("MAINNET_EXECUTION_LEASE_RECOVERY_APPROVAL_REQUIRED");
      const token = randomBytes(32).toString("hex"),
        fence = Math.max(old?.fence ?? 0, prior.fence) + 1,
        recoveries = (old?.recoveries ?? 0) + (old ? 1 : 0);
      this.db
        .prepare("UPDATE mainnet_execution_fence SET fence=? WHERE id=1")
        .run(fence);
      this.db
        .prepare(
          `INSERT INTO mainnet_execution_lease(id,token,owner,fence,acquired,heartbeat,expires,recoveries)
           VALUES(1,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET token=excluded.token,owner=excluded.owner,
             fence=excluded.fence,acquired=excluded.acquired,heartbeat=excluded.heartbeat,
             expires=excluded.expires,recoveries=excluded.recoveries`,
        )
        .run(token, owner.trim(), fence, now, now, now + ttl, recoveries);
      return { token, owner: owner.trim(), fence, expires: now + ttl };
    });
  }

  heartbeat(token: string, ttlSeconds = 300): MainnetLeaseToken {
    const ttl = ttlSeconds,
      now = this.now();
    if (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > 900)
      throw Error("INVALID_LEASE_TTL");
    return this.atomic(() => {
      const row = this.db
        .prepare(
          "SELECT owner,fence,expires FROM mainnet_execution_lease WHERE id=1 AND token=?",
        )
        .get(token) as
        { owner: string; fence: number; expires: number } | undefined;
      if (!row || row.expires <= now)
        throw Error("MAINNET_EXECUTION_LEASE_LOST");
      this.db
        .prepare(
          "UPDATE mainnet_execution_lease SET heartbeat=?,expires=? WHERE id=1 AND token=?",
        )
        .run(now, now + ttl, token);
      return {
        token,
        owner: row.owner,
        fence: row.fence,
        expires: now + ttl,
      };
    });
  }

  release(token: string) {
    if (!token) throw Error("MAINNET_EXECUTION_LEASE_LOST");
    const changed = this.db
      .prepare("DELETE FROM mainnet_execution_lease WHERE id=1 AND token=?")
      .run(token).changes;
    if (changed !== 1) throw Error("MAINNET_EXECUTION_LEASE_LOST");
  }

  guard(token: string) {
    return () => this.assertOwned(token);
  }

  assertOwned(token: string) {
    const row = this.db
        .prepare("SELECT token,expires FROM mainnet_execution_lease WHERE id=1")
        .get() as { token: string; expires: number } | undefined,
      control = this.control();
    if (!row || row.token !== token || row.expires <= this.now())
      throw Error("MAINNET_EXECUTION_LEASE_LOST");
    if (control.paused !== 0) throw Error("MAINNET_OPERATOR_PAUSED");
    return true;
  }

  pause(reason: string) {
    if (!reason.trim() || reason.length > 256)
      throw Error("PAUSE_REASON_REQUIRED");
    this.db
      .prepare(
        "UPDATE mainnet_operator_control SET paused=1,reason=?,changed=? WHERE id=1",
      )
      .run(reason.trim(), this.now());
  }

  arm(operatorApproval: string) {
    if (operatorApproval !== "ARM_MAINNET_EXECUTION")
      throw Error("EXPLICIT_OPERATOR_ARM_REQUIRED");
    this.db
      .prepare(
        "UPDATE mainnet_operator_control SET paused=0,reason=NULL,changed=? WHERE id=1",
      )
      .run(this.now());
  }
}
