// Read-only bridge from the authenticated Zcash mainnet watcher to the merchant
// payment journal (monitor mode).
//
// REUSE, NOT RE-IMPLEMENTATION: chain verification is done entirely by the
// existing watcher — `MainnetWatchScanner` runs the Rust `observe-mainnet`
// command (UFVK-only wallet, two independent providers, authenticated raw-block
// corpus, header/PoW/Merkle and chain-segment checks) and validates + freezes the
// snapshot; `verifyOwnedNote` binds a confirmed note to an order and yields the
// same payment digest the settlement path uses. This module only does
// bookkeeping: checkpoint continuity, note de-duplication, attribution and the
// payment state machine. It has no access to spending keys, signers, the Base
// relayer or any broadcast function, and it never advances a payment past
// ZEC_CONFIRMED — settlement stays a separate, operator-approved, disabled path.
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  MainnetWatchScanner,
  verifyOwnedNote,
  type MainnetWatchPayment,
  type MainnetWatchPolicy,
  type MainnetWatchSnapshot,
} from "../settlement/mainnet-watch.ts";
import { ExclusiveFileLock } from "../operations/mainnet-watch-worker.ts";
import type { PaymentStore } from "./store.ts";
import { attributeDeposit } from "./attribution.ts";
import { checkoutOrderId } from "./checkout-settlement.ts";
import type { ChainEvidence } from "./types.ts";

export interface SnapshotSource {
  observe(checkpointHeight?: number): Promise<MainnetWatchSnapshot>;
}

export interface WatchBridgeOptions {
  receivingAddress: string;
  minimumConfirmations: number;
  /** Optional lock shared with the watch worker so only one scan touches the wallet DB. */
  lock?: { acquire(): void; release(): void };
  now?: () => number;
}

export interface WatchHealth {
  ready: boolean;
  tip: number | null;
  tipHash: string | null;
  observedAt: number | null;
  lastTickAt: number | null;
  lastError: string | null;
  reorgsDetected: number;
  notes: { attributed: number; unattributed: number; reorged: number };
}

type NoteRow = {
  note_key: string;
  txid: string;
  height: number;
  block_hash: string;
  payment_id: string | null;
  status: string;
  confirmations: number;
};

const noteKey = (p: Pick<MainnetWatchPayment, "txid" | "pool" | "index">) => `${p.txid}:${p.pool}:${p.index}`;
const errorCode = (e: unknown) =>
  e instanceof Error && /^[A-Za-z0-9_]{1,96}$/.test(e.message) ? e.message : "WATCH_BRIDGE_FAILED";

export class PaymentWatchBridge {
  private readonly now: () => number;
  private running = false;
  private lastError: string | null = null;
  private lastTickAt: number | null = null;
  private reorgs = 0;

  constructor(
    private readonly store: PaymentStore,
    private readonly source: SnapshotSource,
    private readonly opts: WatchBridgeOptions,
  ) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  checkpoint(): { tip: number; block_hash: string; observed_at: number; source: string; peer_source: string } | undefined {
    return this.store.db.prepare(`SELECT * FROM watch_checkpoint WHERE id=1`).get() as
      | { tip: number; block_hash: string; observed_at: number; source: string; peer_source: string }
      | undefined;
  }

  health(maxAgeSeconds = 900): WatchHealth {
    const cp = this.checkpoint();
    const counts = Object.fromEntries(
      (this.store.db.prepare(`SELECT status, COUNT(*) AS n FROM watch_notes GROUP BY status`).all() as {
        status: string;
        n: number;
      }[]).map((r) => [r.status, Number(r.n)]),
    );
    return {
      ready: !!cp && this.lastError === null && this.now() - cp.observed_at <= maxAgeSeconds,
      tip: cp?.tip ?? null,
      tipHash: cp?.block_hash ?? null,
      observedAt: cp?.observed_at ?? null,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      reorgsDetected: this.reorgs,
      notes: { attributed: counts.attributed ?? 0, unattributed: counts.unattributed ?? 0, reorged: counts.reorged ?? 0 },
    };
  }

  /** One observation cycle. Fails closed: any watcher error leaves the journal untouched. */
  async tick(): Promise<{ ok: boolean; error?: string; changed: number; reorg: boolean }> {
    if (this.running) return { ok: false, error: "WATCH_BRIDGE_BUSY", changed: 0, reorg: false };
    this.running = true;
    this.lastTickAt = this.now();
    let locked = false;
    try {
      if (this.opts.lock) {
        this.opts.lock.acquire();
        locked = true;
      }
      const prior = this.checkpoint();
      let snapshot: MainnetWatchSnapshot;
      try {
        snapshot = await this.source.observe(prior?.tip);
      } catch (e) {
        // Same recovery as observeMainnetWatch(): a checkpoint above the providers'
        // tip (shallow rollback) rescans without a checkpoint and lets reorg logic decide.
        if (!prior || errorCode(e) !== "MAINNET_CHECKPOINT_ABOVE_TIP") throw e;
        snapshot = await this.source.observe();
      }
      const result = this.apply(snapshot, prior);
      this.lastError = null;
      return { ok: true, ...result };
    } catch (e) {
      this.lastError = errorCode(e);
      return { ok: false, error: this.lastError, changed: 0, reorg: false };
    } finally {
      if (locked) this.opts.lock!.release();
      this.running = false;
    }
  }

  /** Apply a validated, native watcher snapshot. Exposed for tests through tick(). */
  private apply(
    s: MainnetWatchSnapshot,
    prior: ReturnType<PaymentWatchBridge["checkpoint"]>,
  ): { changed: number; reorg: boolean } {
    // Every note in a native snapshot was trial-decrypted with the UFVK and its
    // receiver matched; we only consider notes whose receiver is our checkout address.
    if (s.minimumConfirmations !== this.opts.minimumConfirmations) throw Error("WATCH_CONFIRMATION_POLICY_MISMATCH");
    const now = this.now();
    // Checkpoint continuity, mirroring MainnetWatchJournal.observe().
    let reorg = false;
    if (prior) {
      if (s.tip < prior.tip) reorg = true;
      else if (s.checkpoint === null) {
        if (s.tip !== prior.tip || s.blockHash !== prior.block_hash) throw Error("MAINNET_WATCH_CHECKPOINT_MISSING");
      } else if (s.checkpoint.height !== prior.tip) throw Error("MAINNET_WATCH_CHECKPOINT_MISSING");
      else if (s.checkpoint.hash !== prior.block_hash) reorg = true;
      else if (s.tip === prior.tip && s.blockHash !== prior.block_hash) reorg = true;
    } else if (s.checkpoint !== null) throw Error("MAINNET_WATCH_UNEXPECTED_CHECKPOINT");

    let changed = 0;
    this.store.tx(() => {
      const present = new Map<string, MainnetWatchPayment>();
      for (const p of s.payments) {
        if (p.isChange || p.address !== this.opts.receivingAddress) continue;
        present.set(noteKey(p), p);
      }
      // 1. Notes we knew about that vanished or moved blocks: chain reorganization.
      const known = this.store.db
        .prepare(`SELECT note_key, txid, height, block_hash, payment_id, status, confirmations FROM watch_notes WHERE status != 'reorged'`)
        .all() as NoteRow[];
      for (const row of known) {
        const now_ = present.get(row.note_key);
        if (now_ && now_.blockHash === row.block_hash && !reorg) continue;
        if (now_ && now_.blockHash === row.block_hash && reorg) continue; // survived the reorg unchanged
        reorg = true;
        this.store.db
          .prepare(`UPDATE watch_notes SET status='reorged', reason=?, last_seen=? WHERE note_key=?`)
          .run(now_ ? "block_changed" : "note_missing_after_reorg", now, row.note_key);
        if (row.payment_id) {
          const p = this.store.getPayment(row.payment_id);
          if (p && ["PAYMENT_DETECTED", "VERIFYING", "ZEC_CONFIRMED"].includes(p.state)) {
            this.store.transition(p.id, "MANUAL_REVIEW", { reason: "chain_reorganization", txid: row.txid, evidence: "mainnet-observed" }, now);
            changed++;
          }
        }
      }
      if (reorg) this.reorgs++;

      // 2. Every note present in the snapshot.
      for (const [key, p] of present) {
        const row = this.store.db.prepare(`SELECT * FROM watch_notes WHERE note_key=?`).get(key) as NoteRow | undefined;
        if (row && row.status === "reorged") continue; // never resurrect a reorged attribution automatically
        if (!row) {
          const r = attributeDeposit(
            this.store,
            { address: p.address, txid: p.txid, height: p.height, zat: p.zatoshis, confirmations: p.confirmations },
            { minConfirmations: s.minimumConfirmations, now },
          );
          const paymentId = r.status === "unattributed" ? null : r.paymentId;
          const status = r.status === "unattributed" ? "unattributed" : r.status === "duplicate" ? "duplicate" : "attributed";
          this.store.db
            .prepare(
              `INSERT INTO watch_notes(note_key,txid,pool,output_index,zatoshis,height,block_hash,address,ownership_digest,payment_id,status,reason,confirmations,first_seen,last_seen)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              key,
              p.txid,
              p.pool,
              p.index,
              p.zatoshis,
              p.height,
              p.blockHash,
              p.address,
              p.ownershipEvidence.digest,
              paymentId,
              status,
              r.status === "unattributed" ? r.reason : r.status === "manual_review" ? r.reason : null,
              p.confirmations,
              now,
              now,
            );
          if (r.status === "attributed" || r.status === "manual_review") changed++;
        } else {
          this.store.db
            .prepare(`UPDATE watch_notes SET confirmations=?, last_seen=? WHERE note_key=?`)
            .run(p.confirmations, now, key);
        }
        // 3. Advance attributed payments; record evidence; confirm at the threshold.
        const owner = (this.store.db.prepare(`SELECT payment_id, status FROM watch_notes WHERE note_key=?`).get(key) as {
          payment_id: string | null;
          status: string;
        }).payment_id;
        if (!owner) continue;
        const payment = this.store.getPayment(owner);
        if (!payment || payment.mode === "demo") continue;
        let paymentDigest: string | null = null;
        if (p.confirmations >= s.minimumConfirmations && payment.state === "VERIFYING") {
          try {
            // The settlement path's own verifier: native snapshot, receiver, amount,
            // unspent/unlocked, anchored height.
            paymentDigest = verifyOwnedNote(
              s,
              {
                orderId: checkoutOrderId(payment.id),
                account: s.account,
                address: this.opts.receivingAddress,
                zatoshis: payment.quote!.zecAmountZat,
                expires: payment.expiresAt ?? now,
              },
              p,
            ).paymentDigest;
          } catch {
            this.store.transition(payment.id, "MANUAL_REVIEW", { reason: "owned_note_requirements_not_met", txid: p.txid, evidence: "mainnet-observed" }, now);
            changed++;
            continue;
          }
        }
        const evidence: ChainEvidence = {
          noteKey: key,
          txid: p.txid,
          pool: p.pool,
          height: p.height,
          blockHash: p.blockHash,
          zatoshis: p.zatoshis,
          confirmations: p.confirmations,
          minimumConfirmations: s.minimumConfirmations,
          tip: s.tip,
          tipHash: s.blockHash,
          ownershipDigest: p.ownershipEvidence.digest,
          paymentDigest: paymentDigest ?? payment.chainEvidence?.paymentDigest ?? null,
          sources: [s.source, s.peerSource],
          observedAt: s.observedAt,
        };
        if (payment.confirmations !== p.confirmations || payment.chainEvidence?.tip !== s.tip)
          this.store.setChainEvidence(payment.id, evidence, now);
        if (paymentDigest && payment.state === "VERIFYING") {
          // Monitor mode stops here: ZEC is confirmed; the Base payout is NOT triggered.
          this.store.transition(
            payment.id,
            "ZEC_CONFIRMED",
            {
              evidence: "mainnet-observed",
              txid: p.txid,
              height: p.height,
              confirmations: p.confirmations,
              tip: s.tip,
              paymentDigest,
              settlement: "disabled",
            },
            now,
          );
          changed++;
        }
      }
      this.store.db
        .prepare(
          `INSERT INTO watch_checkpoint(id,tip,block_hash,source,peer_source,observed_at,updated_at) VALUES(1,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET tip=excluded.tip, block_hash=excluded.block_hash, source=excluded.source,
             peer_source=excluded.peer_source, observed_at=excluded.observed_at, updated_at=excluded.updated_at`,
        )
        .run(s.tip, s.blockHash, s.source, s.peerSource, s.observedAt, now);
    });
    return { changed, reorg };
  }
}

/**
 * Build the production snapshot source from the existing watch-worker config
 * (the same file `scripts/mainnet-watch-worker.ts` uses), reusing its wallet,
 * provider pair, authenticated block corpus and process lock.
 */
export function watcherFromWorkerConfig(
  configPath: string,
  receivingAddress: string,
): { source: SnapshotSource; lock: ExclusiveFileLock; minimumConfirmations: number } {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
    enabled: boolean;
    minimumConfirmations: number;
    stateDirectory: string;
    walletDirectory: string;
    publicProbeConfig: string;
  };
  if (cfg.enabled !== true) throw Error("WATCH_WORKER_DISABLED");
  const probes = JSON.parse(readFileSync(resolve(cfg.publicProbeConfig), "utf8")) as {
    zcash: { lightwalletd: { endpoint: string; operator: string }[] };
  };
  const providers = probes.zcash?.lightwalletd;
  if (!Array.isArray(providers) || providers.length !== 2) throw Error("WATCH_PROVIDER_CONFIG_INVALID");
  const policy: MainnetWatchPolicy = {
    network: "zcash",
    enabled: true,
    providers,
    independenceAcknowledged: true,
    confirmations: cfg.minimumConfirmations,
  };
  const state = resolve(cfg.stateDirectory);
  const binary =
    process.env.ZECONE_WATCH_BIN ??
    resolve(`services/zcash-watch/target/debug/zecone-zcash-watch${process.platform === "win32" ? ".exe" : ""}`);
  const scanner = new MainnetWatchScanner(
    resolve(cfg.walletDirectory),
    providers[0].endpoint,
    providers[1].endpoint,
    policy,
    binary,
    [],
    join(state, "watch-worker", "authenticated-blocks"),
    // Not passed as --receiving-address: the Rust watcher only accepts that flag once a
    // verified note exists for the address. The bridge filters notes by receiver instead.
  );
  void receivingAddress;
  return {
    source: scanner,
    lock: new ExclusiveFileLock(join(state, "watch-worker", "worker.lock")),
    minimumConfirmations: cfg.minimumConfirmations,
  };
}
