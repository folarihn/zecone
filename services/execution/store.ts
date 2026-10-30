import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";
import type { Intent } from "./intent.ts";
import type { SolanaDeliveryIntent } from "../solana/settlement-model.ts";
import type { EvmTransferIntent } from "../settlement/transfer-types.ts";

export type State =
  | "awaiting_payment"
  | "verified"
  | "prepared"
  | "submitted"
  | "settled"
  | "expired"
  | "failed"
  | "recovery";
export type Order = {
  id: Hex;
  nonce: Hex;
  account: string;
  address: string;
  intent: string;
  state: State;
  created: number;
  observed_at: number;
  raw: Hex | null;
  tx_hash: Hex | null;
};
export type Payment = {
  account: string;
  txid: string;
  pool: number;
  index: number;
  zatoshis: string;
  height: number;
  blockHash: string;
};
export type Snapshot = {
  network: string;
  tip: number;
  scanned: number;
  observedAt: number;
  payments: Payment[];
};
export class Store {
  db: DatabaseSync;
  constructor(
    path: string,
    readonly confirmations = 10,
  ) {
    if (!Number.isSafeInteger(confirmations) || confirmations < 1)
      throw Error("confirmations must be positive");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, account TEXT NOT NULL UNIQUE, address TEXT NOT NULL UNIQUE, intent TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, observed_at INTEGER NOT NULL DEFAULT 0, raw TEXT, tx_hash TEXT);
      CREATE TABLE IF NOT EXISTS payments(key TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), zatoshis TEXT NOT NULL, height INTEGER NOT NULL, block_hash TEXT NOT NULL, active INTEGER NOT NULL, confirmed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, order_id TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_construction_claims(order_id TEXT PRIMARY KEY REFERENCES orders(id),active INTEGER NOT NULL,attempt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recoveries(id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'review_required', detail TEXT NOT NULL, UNIQUE(order_id,reason));`);
  }
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  get(id: string) {
    return this.db.prepare("SELECT * FROM orders WHERE id=?").get(id) as
      Order | undefined;
  }
  all() {
    return this.db
      .prepare("SELECT * FROM orders ORDER BY created,id")
      .all() as Order[];
  }
  event(id: string, event: string, detail: unknown, now: number) {
    this.db
      .prepare("INSERT INTO audit(at,order_id,event,detail) VALUES(?,?,?,?)")
      .run(now, id, event, JSON.stringify(detail));
  }
  transition(id: string, state: State, now: number, detail: unknown = {}) {
    const before = this.get(id);
    if (!before) throw Error("unknown order");
    this.db.prepare("UPDATE orders SET state=? WHERE id=?").run(state, id);
    if (state !== before.state)
      this.event(id, `${before.state}->${state}`, detail, now);
  }
  recover(id: string, reason: string, detail: unknown, now: number) {
    const encoded = JSON.stringify(detail);
    const previous = this.db
      .prepare("SELECT detail FROM recoveries WHERE order_id=? AND reason=?")
      .get(id, reason) as { detail: string } | undefined;
    if (previous?.detail === encoded) return;
    this.db
      .prepare(
        "INSERT INTO recoveries(order_id,reason,detail) VALUES(?,?,?) ON CONFLICT(order_id,reason) DO UPDATE SET detail=excluded.detail",
      )
      .run(id, reason, encoded);
    this.event(
      id,
      previous ? "recovery_updated" : "recovery_required",
      { reason, detail },
      now,
    );
  }
  create(
    id: Hex,
    intent: Intent | SolanaDeliveryIntent | EvmTransferIntent,
    account: string,
    address: string,
    now: number,
  ) {
    return this.atomic(() => {
      const found = this.get(id);
      if (found) {
        if (found.intent !== JSON.stringify(intent))
          throw Error("idempotency conflict");
        return found;
      }
      this.db
        .prepare(
          "INSERT INTO orders(id,nonce,account,address,intent,state,created) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          intent.nonce,
          account,
          address,
          JSON.stringify(intent),
          "awaiting_payment",
          now,
        );
      this.event(id, "created", { account, address }, now);
      return this.get(id)!;
    });
  }
  totals(id: string) {
    const rows = this.db
      .prepare(
        "SELECT zatoshis,confirmed FROM payments WHERE order_id=? AND active=1",
      )
      .all(id) as { zatoshis: string; confirmed: number }[];
    return rows.reduce(
      (a, r) => ({
        received: a.received + BigInt(r.zatoshis),
        confirmed: a.confirmed + (r.confirmed ? BigInt(r.zatoshis) : 0n),
      }),
      { received: 0n, confirmed: 0n },
    );
  }
  observe(s: Snapshot, now: number) {
    if (
      s.network !== "zcash-testnet" ||
      !Number.isSafeInteger(s.tip) ||
      s.tip < 1 ||
      s.scanned !== s.tip ||
      !Number.isSafeInteger(s.observedAt) ||
      s.observedAt > now + 5 ||
      now - s.observedAt > 120
    )
      throw Error("stale, incomplete or wrong-network scan");
    const seen = new Map<string, string>();
    for (const p of s.payments) {
      if (
        !/^[a-f0-9]{64}$/.test(p.txid) ||
        !/^[a-f0-9]{64}$/.test(p.blockHash) ||
        ![2, 3, 4].includes(p.pool) ||
        !Number.isSafeInteger(p.index) ||
        p.index < 0 ||
        !Number.isSafeInteger(p.height) ||
        p.height < 1 ||
        p.height > s.tip ||
        !/^[0-9]+$/.test(p.zatoshis) ||
        BigInt(p.zatoshis) <= 0n ||
        BigInt(p.zatoshis) > 2_100_000_000_000_000n
      )
        throw Error("invalid shielded observation");
      const key = `${p.txid}:${p.pool}:${p.index}`,
        body = JSON.stringify(p);
      if (seen.has(key) && seen.get(key) !== body)
        throw Error("conflicting duplicate observation");
      seen.set(key, body);
    }
    this.atomic(() => {
      this.db.exec("UPDATE payments SET active=0,confirmed=0");
      for (const [key, body] of seen) {
        const p = JSON.parse(body) as Payment;
        const order = this.db
          .prepare("SELECT id FROM orders WHERE account=?")
          .get(p.account) as { id: string } | undefined;
        if (!order) continue; // Funding account is not an order.
        const previous = this.db
          .prepare("SELECT order_id,zatoshis FROM payments WHERE key=?")
          .get(key) as { order_id: string; zatoshis: string } | undefined;
        if (
          previous &&
          (previous.order_id !== order.id || previous.zatoshis !== p.zatoshis)
        )
          throw Error("payment attribution changed");
        const confirmed = s.tip - p.height + 1 >= this.confirmations ? 1 : 0;
        this.db
          .prepare(
            "INSERT INTO payments(key,order_id,zatoshis,height,block_hash,active,confirmed) VALUES(?,?,?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET height=excluded.height,block_hash=excluded.block_hash,active=1,confirmed=excluded.confirmed",
          )
          .run(key, order.id, p.zatoshis, p.height, p.blockHash, confirmed);
      }
      for (const o of this.all()) {
        if (s.observedAt < o.observed_at) throw Error("out-of-order snapshot");
        const i = JSON.parse(o.intent) as Intent,
          t = this.totals(o.id),
          needed = BigInt(i.zatoshis);
        this.event(
          o.id,
          "scan_verified",
          {
            tip: s.tip,
            scanned: s.scanned,
            observedAt: s.observedAt,
            requiredConfirmations: this.confirmations,
            confirmedZatoshis: t.confirmed.toString(),
            outputs: this.db
              .prepare(
                "SELECT key,height,block_hash FROM payments WHERE order_id=? AND active=1",
              )
              .all(o.id),
          },
          now,
        );
        this.db
          .prepare("UPDATE orders SET observed_at=? WHERE id=?")
          .run(s.observedAt, o.id);
        if (t.received > needed)
          this.recover(
            o.id,
            "excess_payment",
            { excess: (t.received - needed).toString() },
            now,
          );
        if (["prepared", "submitted", "settled"].includes(o.state)) {
          if (t.confirmed < needed) {
            this.recover(o.id, "payment_reorg_after_authorization", {}, now);
            if (o.state !== "settled") this.transition(o.id, "recovery", now);
          }
          continue;
        }
        if (["recovery", "failed"].includes(o.state)) continue;
        if (o.state === "expired" || now >= i.expiry) {
          this.transition(o.id, "expired", now);
          if (t.received > 0n)
            this.recover(
              o.id,
              "expired_payment",
              { received: t.received.toString() },
              now,
            );
        } else if (t.confirmed >= needed)
          this.transition(o.id, "verified", now);
        else
          this.transition(o.id, "awaiting_payment", now, {
            received: t.received.toString(),
            confirmed: t.confirmed.toString(),
          });
      }
    });
  }
  eligible(o: Order, now: number) {
    const intent = JSON.parse(o.intent) as Intent;
    // Phase 5 authorization is an irreversible execution veto, including after
    // restart or a caller attempting the legacy confirmed-revert retry path.
    if (
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='settlement_execution_veto'",
        )
        .get() &&
      this.db
        .prepare(
          "SELECT order_id FROM settlement_execution_veto WHERE order_id=?",
        )
        .get(o.id)
    )
      return false;
    return (
      o.state === "verified" &&
      now < intent.expiry &&
      o.observed_at <= now + 5 &&
      now - o.observed_at <= 120 &&
      this.totals(o.id).confirmed >= BigInt(intent.zatoshis)
    );
  }
  claimPreparation(id: string, now: number) {
    return this.atomic(() => {
      const o = this.get(id);
      if (!o || o.tx_hash || !this.eligible(o, now)) return false;
      // Persist BEFORE calling any async constructor/signer. A missing raw tx
      // after a crash is not evidence that no executable signature was produced.
      const claim = this.db
        .prepare(
          "INSERT INTO execution_construction_claims VALUES(?,1,1) ON CONFLICT(order_id) DO UPDATE SET active=1,attempt=attempt+1 WHERE active=0",
        )
        .run(id);
      if (claim.changes !== 1) return false;
      this.event(id, "execution_construction_claimed", {}, now);
      return true;
    });
  }
  prepared(id: string, raw: Hex, hash: Hex, now: number) {
    this.atomic(() => {
      const o = this.get(id)!;
      if (!this.eligible(o, now)) throw Error("payment no longer eligible");
      this.db
        .prepare("UPDATE orders SET raw=?,tx_hash=? WHERE id=?")
        .run(raw, hash, id);
      this.transition(id, "prepared", now, { hash });
    });
  }
  submitted(id: string, now: number) {
    this.atomic(() => this.transition(id, "submitted", now));
  }
  settled(id: string, receipt: unknown, now: number) {
    this.atomic(() => {
      this.transition(id, "settled", now, receipt);
    });
  }
  failed(id: string, now: number) {
    this.atomic(() => {
      this.transition(id, "failed", now);
      this.recover(
        id,
        "base_transaction_reverted",
        { hash: this.get(id)!.tx_hash },
        now,
      );
    });
  }
  retry(id: string, now: number) {
    this.atomic(() => {
      const o = this.get(id);
      if (
        !o ||
        !o.raw ||
        !o.tx_hash ||
        o.state !== "failed" ||
        !this.eligible({ ...o, state: "verified" }, now)
      )
        throw Error(
          "only a confirmed revert with fresh sufficient payment may retry",
        );
      this.event(
        id,
        "retry_after_confirmed_revert",
        { previousHash: o.tx_hash },
        now,
      );
      // Only the existing explicit confirmed-revert path permits another attempt.
      // Keep the claim row forever so refund policy cannot infer never-constructed.
      this.db
        .prepare(
          "UPDATE execution_construction_claims SET active=0 WHERE order_id=?",
        )
        .run(id);
      this.db
        .prepare("UPDATE orders SET raw=NULL,tx_hash=NULL WHERE id=?")
        .run(id);
      this.transition(id, "verified", now);
    });
  }
  report() {
    return {
      orders: this.all().map(({ raw, ...o }) => ({
        ...o,
        ...Object.fromEntries(
          Object.entries(this.totals(o.id)).map(([k, v]) => [k, v.toString()]),
        ),
      })),
      payments: this.db
        .prepare("SELECT * FROM payments ORDER BY order_id,key")
        .all(),
      recoveries: this.db.prepare("SELECT * FROM recoveries").all(),
      audit: this.db.prepare("SELECT * FROM audit ORDER BY seq").all(),
    };
  }
}
