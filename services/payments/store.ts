// Durable payment store backed by node:sqlite. All mutations are validated and
// atomic; payments transition through an explicit state machine and every
// transition is recorded as an event for audit and webhook delivery.
//
// The store is the single source of truth for:
//   * merchants, API keys (hashed) and dashboard sessions (hashed)
//   * single-use wallet-ownership challenges (EIP-4361)
//   * payments, their quotes and the exclusive receiving-address allocation
//   * the append-only payment event journal and the webhook outbox
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ChainEvidence,
  EvidenceKind,
  PaymentMode,
  Merchant,
  Payment,
  PaymentEvent,
  PaymentEventType,
  PaymentState,
  Principal,
  Quote,
  WebhookDelivery,
} from "./types.ts";
import { PAYMENT_STATES } from "./types.ts";

const TERMINAL: ReadonlySet<PaymentState> = new Set(["COMPLETED", "EXPIRED", "FAILED"]);

// States in which a payment holds the exclusive receiving-address allocation.
// While held, an incoming note to that address is attributable to this payment.
export const ALLOCATING_STATES: ReadonlySet<PaymentState> = new Set([
  "AWAITING_PAYMENT",
  "PAYMENT_DETECTED",
  "VERIFYING",
]);

// Explicit state machine: `TRANSITIONS[from]` lists reachable next states.
const TRANSITIONS: Record<PaymentState, ReadonlySet<PaymentState>> = {
  CREATED: new Set(["QUOTED", "EXPIRED", "FAILED"]),
  QUOTED: new Set(["AWAITING_PAYMENT", "EXPIRED", "FAILED"]),
  AWAITING_PAYMENT: new Set(["PAYMENT_DETECTED", "EXPIRED", "FAILED"]),
  PAYMENT_DETECTED: new Set(["VERIFYING", "EXPIRED", "FAILED", "MANUAL_REVIEW"]),
  VERIFYING: new Set(["ZEC_CONFIRMED", "FAILED", "MANUAL_REVIEW"]),
  // A confirmed deposit can still be invalidated by a deep reorganization.
  ZEC_CONFIRMED: new Set(["PAYOUT_PENDING", "EXPIRED", "FAILED", "MANUAL_REVIEW"]),
  PAYOUT_PENDING: new Set(["PAYOUT_SUBMITTED", "FAILED", "MANUAL_REVIEW"]),
  PAYOUT_SUBMITTED: new Set(["PAYOUT_CONFIRMED", "FAILED", "MANUAL_REVIEW"]),
  PAYOUT_CONFIRMED: new Set(["COMPLETED", "MANUAL_REVIEW"]),
  COMPLETED: new Set(),
  EXPIRED: new Set(),
  FAILED: new Set(),
  MANUAL_REVIEW: new Set(["COMPLETED", "FAILED", "EXPIRED"]),
};

export const EVENT_FOR_STATE: Record<PaymentState, PaymentEventType> = {
  CREATED: "payment.created",
  QUOTED: "payment.quoted",
  AWAITING_PAYMENT: "payment.awaiting_payment",
  PAYMENT_DETECTED: "payment.detected",
  VERIFYING: "payment.verifying",
  ZEC_CONFIRMED: "payment.zec_confirmed",
  PAYOUT_PENDING: "payment.payout_pending",
  PAYOUT_SUBMITTED: "payment.payout_submitted",
  PAYOUT_CONFIRMED: "payment.payout_confirmed",
  COMPLETED: "payment.completed",
  EXPIRED: "payment.expired",
  FAILED: "payment.failed",
  MANUAL_REVIEW: "payment.manual_review",
};

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "idempotency_conflict"
      | "checkout_busy"
      | "duplicate_attribution"
      | "not_found"
      | "invalid_state"
      | "challenge_invalid",
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export const hashSecret = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function isValidState(s: string): s is PaymentState {
  return (PAYMENT_STATES as readonly string[]).includes(s);
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const KEY_RE = /^(zk_[0-9a-f]{24})_(.+)$/;
const SESSION_RE = /^(zs_[0-9a-f]{24})_([0-9a-f]{64})$/;

type MerchantRow = {
  id: string;
  name: string;
  key_id: string;
  key_hash: string;
  scopes: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  base_recipient: string | null;
  payout_verification: string | null;
  owner_address: string | null;
  created_at: number;
};

export class PaymentStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS merchants(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_id TEXT NOT NULL UNIQUE,
        key_hash TEXT NOT NULL,
        scopes TEXT NOT NULL,
        webhook_url TEXT,
        webhook_secret TEXT,
        base_recipient TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payments(
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        state TEXT NOT NULL,
        request_json TEXT NOT NULL,
        quote_json TEXT,
        zcash_address TEXT,
        detected_txid TEXT,
        detected_zat TEXT,
        payout_tx_hash TEXT,
        payout_wei TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        mode TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS idempotency(
        key TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        payment_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (merchant_id, key)
      );
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id TEXT NOT NULL,
        type TEXT NOT NULL,
        state TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_payment ON events(payment_id, id);
      CREATE TABLE IF NOT EXISTS webhook_deliveries(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        url TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_status INTEGER,
        next_attempt_at INTEGER,
        delivered_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys(
        key_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS api_keys_merchant ON api_keys(merchant_id);
      CREATE TABLE IF NOT EXISTS siwe_challenges(
        nonce TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        purpose TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS allocations(
        address TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        allocated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS unattributed_deposits(
        txid TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        zat TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.migrate();
  }

  /** Additive, idempotent migrations for databases created by earlier builds. */
  private migrate(): void {
    const addColumn = (table: string, column: string, ddl: string) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    addColumn("merchants", "payout_verification", "payout_verification TEXT");
    addColumn("merchants", "owner_address", "owner_address TEXT");
    addColumn("payments", "confirmations", "confirmations INTEGER");
    addColumn("payments", "evidence_kind", "evidence_kind TEXT");
    addColumn("payments", "completed_at", "completed_at INTEGER");
    addColumn("payments", "allocation_tip", "allocation_tip INTEGER");
    addColumn("payments", "chain_evidence_json", "chain_evidence_json TEXT");
    addColumn("idempotency", "fingerprint", "fingerprint TEXT");
    addColumn("webhook_deliveries", "status", "status TEXT NOT NULL DEFAULT 'pending'");
    addColumn("webhook_deliveries", "event_id", "event_id INTEGER");
    addColumn("webhook_deliveries", "merchant_id", "merchant_id TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS payments_merchant ON payments(merchant_id, created_at);
      CREATE INDEX IF NOT EXISTS payments_expiry ON payments(state, expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS merchants_owner ON merchants(owner_address) WHERE owner_address IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS payments_live_txid ON payments(detected_txid)
        WHERE detected_txid IS NOT NULL AND mode = 'live';
      CREATE UNIQUE INDEX IF NOT EXISTS payments_real_txid ON payments(detected_txid)
        WHERE detected_txid IS NOT NULL AND mode IN ('live','monitor');
      -- Read-only watcher bookkeeping (monitor mode). Demo replays never write here.
      CREATE TABLE IF NOT EXISTS watch_checkpoint(
        id INTEGER PRIMARY KEY CHECK(id=1), tip INTEGER NOT NULL, block_hash TEXT NOT NULL,
        source TEXT NOT NULL, peer_source TEXT NOT NULL, observed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS watch_notes(
        note_key TEXT PRIMARY KEY, txid TEXT NOT NULL, pool INTEGER NOT NULL, output_index INTEGER NOT NULL,
        zatoshis TEXT NOT NULL, height INTEGER NOT NULL, block_hash TEXT NOT NULL, address TEXT NOT NULL,
        ownership_digest TEXT NOT NULL, payment_id TEXT, status TEXT NOT NULL, reason TEXT,
        confirmations INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS watch_notes_payment ON watch_notes(payment_id);
      CREATE INDEX IF NOT EXISTS wh_pending2 ON webhook_deliveries(status, next_attempt_at);
    `);
    // Older builds marked abandoned deliveries "delivered"; normalise the status column.
    this.db.exec(
      `UPDATE webhook_deliveries SET status='delivered' WHERE status='pending' AND delivered_at IS NOT NULL AND last_status BETWEEN 200 AND 299`,
    );
    // Mirror legacy single keys into api_keys so every key lives in one table.
    this.db.exec(`
      INSERT OR IGNORE INTO api_keys(key_id, merchant_id, kind, key_hash, scopes, created_at)
      SELECT key_id, id, 'secret', key_hash, scopes, created_at FROM merchants;
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` inside an IMMEDIATE transaction (serialises writers). */
  tx<T>(fn: () => T): T {
    // Re-entrant: nested calls join the outer transaction.
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }
  private txDepth = 0;

  // ---- settings ----

  /** A per-database random secret (created once) used to derive checkout tokens. */
  secretSetting(key: string): string {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as
      | { value: string }
      | undefined;
    if (row) return row.value;
    const value = randomBytes(32).toString("hex");
    this.db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`).run(key, value);
    return (this.db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as { value: string }).value;
  }

  // ---- merchants ----

  createMerchant(input: {
    name: string;
    secret: string;
    scopes: string[];
    keyId?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    baseRecipient?: string;
    payoutVerification?: "siwe" | "operator-configured";
    ownerAddress?: string;
    now?: number;
  }): Merchant {
    const now = input.now ?? nowSeconds();
    const id = `mer_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const keyId = input.keyId ?? `zk_${randomBytes(12).toString("hex")}`;
    const scopes = [...new Set(input.scopes)];
    const keyHash = hashSecret(input.secret);
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO merchants(id,name,key_id,key_hash,scopes,webhook_url,webhook_secret,base_recipient,payout_verification,owner_address,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.name,
          keyId,
          keyHash,
          JSON.stringify(scopes),
          input.webhookUrl ?? null,
          input.webhookSecret ?? null,
          input.baseRecipient ?? null,
          input.payoutVerification ?? (input.baseRecipient ? "operator-configured" : null),
          input.ownerAddress ?? null,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO api_keys(key_id,merchant_id,kind,key_hash,scopes,created_at) VALUES(?,?,?,?,?,?)`,
        )
        .run(keyId, id, "secret", keyHash, JSON.stringify(scopes), now);
    });
    return this.getMerchant(id)!;
  }

  getMerchant(id: string): Merchant | null {
    const row = this.db.prepare(`SELECT * FROM merchants WHERE id=?`).get(id) as MerchantRow | undefined;
    return row ? rowToMerchant(row) : null;
  }

  merchantByOwner(address: string): Merchant | null {
    const row = this.db
      .prepare(`SELECT * FROM merchants WHERE owner_address=?`)
      .get(address) as MerchantRow | undefined;
    return row ? rowToMerchant(row) : null;
  }

  /** Issue a new secret API key for a merchant. Returns the raw key once. */
  issueApiKey(merchantId: string, scopes: string[], now = nowSeconds()): { keyId: string; apiKey: string } {
    const keyId = `zk_${randomBytes(12).toString("hex")}`;
    const secret = `sk_${randomBytes(24).toString("hex")}`;
    this.db
      .prepare(`INSERT INTO api_keys(key_id,merchant_id,kind,key_hash,scopes,created_at) VALUES(?,?,?,?,?,?)`)
      .run(keyId, merchantId, "secret", hashSecret(secret), JSON.stringify([...new Set(scopes)]), now);
    return { keyId, apiKey: `${keyId}_${secret}` };
  }

  /** Revoke every active secret key of a merchant except `keepKeyId`. */
  revokeApiKeys(merchantId: string, keepKeyId: string | null, now = nowSeconds()): number {
    const r = this.db
      .prepare(
        `UPDATE api_keys SET revoked_at=? WHERE merchant_id=? AND kind='secret' AND revoked_at IS NULL AND key_id != ?`,
      )
      .run(now, merchantId, keepKeyId ?? "");
    return Number(r.changes);
  }

  listApiKeys(merchantId: string): { keyId: string; createdAt: number; revokedAt: number | null; scopes: string[] }[] {
    const rows = this.db
      .prepare(`SELECT key_id, created_at, revoked_at, scopes FROM api_keys WHERE merchant_id=? AND kind='secret' ORDER BY created_at`)
      .all(merchantId) as { key_id: string; created_at: number; revoked_at: number | null; scopes: string }[];
    return rows.map((r) => ({
      keyId: r.key_id,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
      scopes: JSON.parse(r.scopes),
    }));
  }

  /** Issue a short-lived dashboard session credential. Returns the raw token once. */
  issueSession(merchantId: string, ttlSeconds: number, now = nowSeconds()): { token: string; expiresAt: number } {
    const keyId = `zs_${randomBytes(12).toString("hex")}`;
    const secret = randomBytes(32).toString("hex");
    const expiresAt = now + ttlSeconds;
    this.db
      .prepare(
        `INSERT INTO api_keys(key_id,merchant_id,kind,key_hash,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        keyId,
        merchantId,
        "session",
        hashSecret(secret),
        JSON.stringify(["payments:create", "payments:read", "payments:cancel", "webhooks:manage", "merchant:manage"]),
        now,
        expiresAt,
      );
    return { token: `${keyId}_${secret}`, expiresAt };
  }

  revokeSession(token: string, now = nowSeconds()): void {
    const m = SESSION_RE.exec(token);
    if (!m) return;
    this.db.prepare(`UPDATE api_keys SET revoked_at=? WHERE key_id=? AND kind='session'`).run(now, m[1]);
  }

  /** Resolve an API key or session token to its principal (or null). Constant-time hash compare. */
  authenticatePrincipal(token: string, now = nowSeconds()): Principal | null {
    const m = KEY_RE.exec(token) ?? SESSION_RE.exec(token);
    if (!m) return null;
    const [, keyId, raw] = m;
    const row = this.db.prepare(`SELECT * FROM api_keys WHERE key_id=?`).get(keyId) as
      | {
          key_id: string;
          merchant_id: string;
          kind: string;
          key_hash: string;
          scopes: string;
          expires_at: number | null;
          revoked_at: number | null;
        }
      | undefined;
    // Hash even on miss so timing does not reveal whether a key id exists.
    const candidate = hashSecret(raw);
    if (!row) return null;
    if (!safeEqualHex(row.key_hash, candidate)) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at !== null && row.expires_at <= now) return null;
    const merchant = this.getMerchant(row.merchant_id);
    if (!merchant) return null;
    return {
      merchant,
      credential: row.kind === "session" ? "session" : "api_key",
      keyId: row.key_id,
      scopes: new Set(JSON.parse(row.scopes) as string[]),
    };
  }

  /** Backwards-compatible helper: verify a merchant API key and return the merchant (or null). */
  authenticate(secret: string): Merchant | null {
    return this.authenticatePrincipal(secret)?.merchant ?? null;
  }

  setPayoutAddress(merchantId: string, address: string, verification: "siwe" | "operator-configured"): void {
    this.db
      .prepare(`UPDATE merchants SET base_recipient=?, payout_verification=? WHERE id=?`)
      .run(address, verification, merchantId);
  }

  setWebhook(merchantId: string, url: string | null, secret: string | null): void {
    this.db.prepare(`UPDATE merchants SET webhook_url=?, webhook_secret=? WHERE id=?`).run(url, secret, merchantId);
  }

  // ---- wallet-ownership challenges ----

  saveChallenge(c: { nonce: string; address: string; purpose: string; message: string; expiresAt: number; now?: number }): void {
    this.db
      .prepare(`INSERT INTO siwe_challenges(nonce,address,purpose,message,created_at,expires_at) VALUES(?,?,?,?,?,?)`)
      .run(c.nonce, c.address, c.purpose, c.message, c.now ?? nowSeconds(), c.expiresAt);
  }

  /** Atomically consume a challenge exactly once. Throws if missing, expired or already used. */
  consumeChallenge(nonce: string, now = nowSeconds()): { address: string; purpose: string; message: string } {
    return this.tx(() => {
      const row = this.db.prepare(`SELECT * FROM siwe_challenges WHERE nonce=?`).get(nonce) as
        | { address: string; purpose: string; message: string; expires_at: number; consumed_at: number | null }
        | undefined;
      if (!row) throw new StoreError("unknown challenge", "challenge_invalid");
      if (row.consumed_at !== null) throw new StoreError("challenge already used", "challenge_invalid");
      if (row.expires_at <= now) throw new StoreError("challenge expired", "challenge_invalid");
      this.db.prepare(`UPDATE siwe_challenges SET consumed_at=? WHERE nonce=? AND consumed_at IS NULL`).run(now, nonce);
      return { address: row.address, purpose: row.purpose, message: row.message };
    });
  }

  // ---- payments ----

  /**
   * Create a payment. With an idempotency key, a retried identical request returns
   * the original payment; a different request body under the same key is a conflict.
   */
  createPayment(input: {
    merchantId: string;
    request: Payment["request"];
    mode: PaymentMode;
    idempotencyKey?: string;
    now?: number;
  }): { payment: Payment; created: boolean } {
    const now = input.now ?? nowSeconds();
    const fingerprint = hashSecret(
      JSON.stringify({
        amountUsd: input.request.amountUsd,
        payoutChain: input.request.payoutChain,
        recipient: input.request.recipient.toLowerCase(),
        metadata: sortObject(input.request.metadata ?? {}),
        description: input.request.description ?? null,
      }),
    );
    return this.tx(() => {
      if (input.idempotencyKey) {
        const existing = this.db
          .prepare(`SELECT payment_id, fingerprint FROM idempotency WHERE merchant_id=? AND key=?`)
          .get(input.merchantId, input.idempotencyKey) as { payment_id: string; fingerprint: string | null } | undefined;
        if (existing) {
          if (existing.fingerprint && existing.fingerprint !== fingerprint)
            throw new StoreError("idempotency key reused with a different request", "idempotency_conflict", {
              paymentId: existing.payment_id,
            });
          const p = this.getPayment(existing.payment_id);
          if (p) return { payment: p, created: false };
        }
      }
      const id = `pay_${randomUUID().replace(/-/g, "").slice(0, 26)}`;
      this.db
        .prepare(
          `INSERT INTO payments(id,merchant_id,state,request_json,created_at,updated_at,expires_at,mode,error)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, input.merchantId, "CREATED", JSON.stringify(input.request), now, now, null, input.mode, null);
      if (input.idempotencyKey) {
        this.db
          .prepare(`INSERT INTO idempotency(key,merchant_id,payment_id,created_at,fingerprint) VALUES(?,?,?,?,?)`)
          .run(input.idempotencyKey, input.merchantId, id, now, fingerprint);
      }
      this.recordEvent(id, "payment.created", "CREATED", {}, now);
      return { payment: this.getPayment(id)!, created: true };
    });
  }

  getPayment(id: string): Payment | null {
    const row = this.db.prepare(`SELECT * FROM payments WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToPayment(row);
  }

  listPayments(merchantId: string, limit = 50, offset = 0, state?: PaymentState): Payment[] {
    const rows = (
      state
        ? this.db
            .prepare(`SELECT * FROM payments WHERE merchant_id=? AND state=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
            .all(merchantId, state, limit, offset)
        : this.db
            .prepare(`SELECT * FROM payments WHERE merchant_id=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
            .all(merchantId, limit, offset)
    ) as Record<string, unknown>[];
    return rows.map(rowToPayment);
  }

  countPayments(merchantId: string): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM payments WHERE merchant_id=? GROUP BY state`)
      .all(merchantId) as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
  }

  /** Who currently holds the exclusive allocation for `address` (after releasing stale holders). */
  allocationHolder(address: string): Payment | null {
    const row = this.db.prepare(`SELECT payment_id FROM allocations WHERE address=?`).get(address) as
      | { payment_id: string }
      | undefined;
    if (!row) return null;
    const p = this.getPayment(row.payment_id);
    if (!p || !ALLOCATING_STATES.has(p.state)) {
      this.db.prepare(`DELETE FROM allocations WHERE address=? AND payment_id=?`).run(address, row.payment_id);
      return null;
    }
    return p;
  }

  /**
   * Attach a quote and allocate the receiving address exclusively, then move the
   * payment to AWAITING_PAYMENT. With `exclusive`, a second concurrent payment for
   * the same address is rejected (single-active-checkout attribution model).
   */
  setQuote(
    id: string,
    quote: Quote,
    zcashAddress: string | null,
    expiresAt: number,
    now = nowSeconds(),
    opts: { exclusive?: boolean; allocationTip?: number | null } = {},
  ): void {
    this.tx(() => {
      // Demo payments have no payable address and therefore hold no allocation.
      if (opts.exclusive && zcashAddress !== null) {
        this.expireDue(now);
        const holder = this.allocationHolder(zcashAddress);
        if (holder && holder.id !== id)
          throw new StoreError("another checkout currently holds the receiving address", "checkout_busy", {
            retryAfter: Math.max(1, (holder.expiresAt ?? now) - now),
          });
        this.db
          .prepare(`INSERT OR REPLACE INTO allocations(address,payment_id,allocated_at) VALUES(?,?,?)`)
          .run(zcashAddress, id, now);
      }
      const changed = this.db
        .prepare(
          `UPDATE payments SET quote_json=?, zcash_address=?, expires_at=?, allocation_tip=?, updated_at=? WHERE id=? AND state='CREATED'`,
        )
        .run(JSON.stringify(quote), zcashAddress, expiresAt, opts.allocationTip ?? null, now, id);
      if (changed.changes !== 1) throw new StoreError("payment is not in CREATED state", "invalid_state");
      this.transition(id, "QUOTED", { quoteId: quote.id }, now);
      this.transition(id, "AWAITING_PAYMENT", { expiresAt }, now);
    });
  }

  /** Attach the detected shielded payment (exact attribution by txid). */
  markDetected(
    id: string,
    txid: string,
    zat: string,
    now = nowSeconds(),
    evidenceKind: EvidenceKind = "live",
  ): void {
    if (evidenceKind === "recorded-mainnet-replay" && this.getPayment(id)?.mode !== "demo")
      throw new StoreError("replayed evidence may only attach to demo payments", "invalid_state");
    if (evidenceKind !== "recorded-mainnet-replay" && this.getPayment(id)?.mode === "demo")
      throw new StoreError("real chain evidence may not attach to demo payments", "invalid_state");
    this.tx(() => {
      const p = this.getPayment(id);
      if (!p) throw new StoreError("payment not found", "not_found");
      if (p.state !== "AWAITING_PAYMENT") throw new StoreError(`payment is ${p.state}`, "invalid_state");
      if (evidenceKind !== "recorded-mainnet-replay") {
        const dup = this.db
          .prepare(`SELECT id FROM payments WHERE detected_txid=? AND mode IN ('live','monitor') AND id != ?`)
          .get(txid, id) as { id: string } | undefined;
        if (dup) throw new StoreError("source transaction already attributed", "duplicate_attribution", { paymentId: dup.id });
      }
      this.db
        .prepare(`UPDATE payments SET detected_txid=?, detected_zat=?, evidence_kind=?, updated_at=? WHERE id=?`)
        .run(txid, zat, evidenceKind, now, id);
      this.transition(id, "PAYMENT_DETECTED", { txid, zat, evidence: evidenceKind }, now);
      this.transition(id, "VERIFYING", { txid, evidence: evidenceKind }, now);
    });
  }

  setChainEvidence(id: string, evidence: ChainEvidence, now = nowSeconds()): void {
    this.db
      .prepare(`UPDATE payments SET chain_evidence_json=?, confirmations=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(evidence), evidence.confirmations, now, id);
  }

  setConfirmations(id: string, confirmations: number, now = nowSeconds()): void {
    this.db.prepare(`UPDATE payments SET confirmations=?, updated_at=? WHERE id=?`).run(confirmations, now, id);
  }

  setPayout(id: string, txHash: string, wei: string, now = nowSeconds()): void {
    this.db
      .prepare(`UPDATE payments SET payout_tx_hash=?, payout_wei=?, updated_at=? WHERE id=?`)
      .run(txHash, wei, now, id);
  }

  /**
   * Advance a payment to `next`. Validated against the state machine and atomic
   * (single UPDATE guarded by the current state). Returns false on invalid or
   * concurrent transitions.
   */
  transition(id: string, next: PaymentState, data: Record<string, unknown> = {}, now = nowSeconds()): boolean {
    if (!isValidState(next)) return false;
    const current = this.db.prepare(`SELECT state FROM payments WHERE id=?`).get(id) as { state: string } | undefined;
    if (!current || !isValidState(current.state)) return false;
    if (!TRANSITIONS[current.state].has(next)) return false;
    const changed = this.db
      .prepare(
        `UPDATE payments SET state=?, updated_at=?, error=NULL, completed_at=CASE WHEN ?='COMPLETED' THEN ? ELSE completed_at END
         WHERE id=? AND state=?`,
      )
      .run(next, now, next, now, id, current.state);
    if (changed.changes !== 1) return false;
    // Release the receiving address once the payment can no longer receive an attributable note.
    if (!ALLOCATING_STATES.has(next) && next !== "QUOTED") this.db.prepare(`DELETE FROM allocations WHERE payment_id=?`).run(id);
    this.recordEvent(id, EVENT_FOR_STATE[next], next, data, now);
    return true;
  }

  fail(id: string, message: string, now = nowSeconds()): void {
    const current = this.db.prepare(`SELECT state FROM payments WHERE id=?`).get(id) as { state: string } | undefined;
    if (!current || TERMINAL.has(current.state as PaymentState)) return;
    this.db.prepare(`UPDATE payments SET state='FAILED', error=?, updated_at=? WHERE id=?`).run(message, now, id);
    this.db.prepare(`DELETE FROM allocations WHERE payment_id=?`).run(id);
    this.recordEvent(id, "payment.failed", "FAILED", { message }, now);
  }

  /** Expire every unpaid payment whose quote window elapsed. Returns expired ids. */
  expireDue(now = nowSeconds()): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM payments WHERE state IN ('CREATED','QUOTED','AWAITING_PAYMENT') AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(now) as { id: string }[];
    const expired: string[] = [];
    for (const r of rows) if (this.transition(r.id, "EXPIRED", { reason: "quote_expired" }, now)) expired.push(r.id);
    return expired;
  }

  /** Merchant-initiated cancellation of an unpaid payment. */
  cancel(id: string, now = nowSeconds()): boolean {
    const p = this.getPayment(id);
    if (!p || !["CREATED", "QUOTED", "AWAITING_PAYMENT"].includes(p.state)) return false;
    return this.transition(id, "EXPIRED", { reason: "canceled_by_merchant" }, now);
  }

  recordUnattributed(txid: string, address: string, zat: string, reason: string, now = nowSeconds()): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO unattributed_deposits(txid,address,zat,reason,created_at) VALUES(?,?,?,?,?)`)
      .run(txid, address, zat, reason, now);
  }

  listUnattributed(): { txid: string; address: string; zat: string; reason: string }[] {
    return this.db.prepare(`SELECT txid,address,zat,reason FROM unattributed_deposits ORDER BY created_at`).all() as {
      txid: string;
      address: string;
      zat: string;
      reason: string;
    }[];
  }

  recordEvent(
    paymentId: string,
    type: PaymentEventType,
    state: PaymentState,
    data: Record<string, unknown>,
    now = nowSeconds(),
  ): number {
    const r = this.db
      .prepare(`INSERT INTO events(payment_id,type,state,data_json,created_at) VALUES(?,?,?,?,?)`)
      .run(paymentId, type, state, JSON.stringify(data), now);
    const eventId = Number(r.lastInsertRowid);
    // Enqueue a signed webhook if this merchant has one configured (transactional outbox).
    const payment = this.db.prepare(`SELECT merchant_id FROM payments WHERE id=?`).get(paymentId) as
      | { merchant_id: string }
      | undefined;
    const wh = payment ? this.merchantWebhook(payment.merchant_id) : null;
    if (wh && payment) this.enqueueWebhook(paymentId, payment.merchant_id, type, wh.url, now, eventId);
    return eventId;
  }

  merchantWebhook(merchantId: string): { url: string; secret: string } | null {
    const row = this.db
      .prepare(`SELECT webhook_url, webhook_secret FROM merchants WHERE id=?`)
      .get(merchantId) as { webhook_url: string | null; webhook_secret: string | null } | undefined;
    if (!row?.webhook_url || !row?.webhook_secret) return null;
    return { url: row.webhook_url, secret: row.webhook_secret };
  }

  webhookSecret(paymentId: string): { url: string; secret: string } | null {
    const p = this.db.prepare(`SELECT merchant_id FROM payments WHERE id=?`).get(paymentId) as
      | { merchant_id: string }
      | undefined;
    return p ? this.merchantWebhook(p.merchant_id) : null;
  }

  listEvents(paymentId: string): PaymentEvent[] {
    const rows = this.db.prepare(`SELECT * FROM events WHERE payment_id=? ORDER BY id`).all(paymentId) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: r.id as number,
      paymentId: r.payment_id as string,
      type: r.type as PaymentEventType,
      state: r.state as PaymentState,
      data: JSON.parse(r.data_json as string) as Record<string, unknown>,
      createdAt: r.created_at as number,
    }));
  }

  // ---- webhooks ----

  enqueueWebhook(
    paymentId: string,
    merchantId: string,
    eventType: PaymentEventType,
    url: string,
    now = nowSeconds(),
    eventId: number | null = null,
  ): number {
    const r = this.db
      .prepare(
        `INSERT INTO webhook_deliveries(payment_id,merchant_id,event_id,event_type,url,attempts,status,next_attempt_at,created_at)
         VALUES(?,?,?,?,?,0,'pending',?,?)`,
      )
      .run(paymentId, merchantId, eventId, eventType, url, now, now);
    return Number(r.lastInsertRowid);
  }

  pendingWebhooks(now = nowSeconds()): WebhookDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM webhook_deliveries WHERE status='pending' AND next_attempt_at <= ? ORDER BY id LIMIT 100`,
      )
      .all(now) as Record<string, unknown>[];
    return rows.map(rowToDelivery);
  }

  listDeliveries(merchantId: string, limit = 50): WebhookDelivery[] {
    const rows = this.db
      .prepare(`SELECT * FROM webhook_deliveries WHERE merchant_id=? ORDER BY id DESC LIMIT ?`)
      .all(merchantId, limit) as Record<string, unknown>[];
    return rows.map(rowToDelivery);
  }

  getDelivery(id: number): WebhookDelivery | null {
    const row = this.db.prepare(`SELECT * FROM webhook_deliveries WHERE id=?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToDelivery(row) : null;
  }

  /**
   * Record one delivery attempt. `outcome` is "delivered" (2xx), "retry" (schedule
   * `nextAttemptAt`) or "failed" (give up; kept for audit and manual redelivery).
   */
  recordWebhookAttempt(
    id: number,
    status: number | null,
    outcome: "delivered" | "retry" | "failed",
    nextAttemptAt: number | null,
    now = nowSeconds(),
  ): void {
    this.db
      .prepare(
        `UPDATE webhook_deliveries SET attempts=attempts+1, last_status=?, status=?, next_attempt_at=?,
           delivered_at=CASE WHEN ?='delivered' THEN ? ELSE delivered_at END WHERE id=?`,
      )
      .run(status, outcome === "retry" ? "pending" : outcome, outcome === "retry" ? nextAttemptAt : null, outcome, now, id);
  }
}

function sortObject(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function rowToMerchant(row: MerchantRow): Merchant {
  return {
    id: row.id,
    name: row.name,
    keyId: row.key_id,
    keyHash: row.key_hash,
    scopes: new Set(JSON.parse(row.scopes) as string[]),
    webhookUrl: row.webhook_url,
    webhookSecret: row.webhook_secret,
    baseRecipient: row.base_recipient,
    payoutVerification: (row.payout_verification as Merchant["payoutVerification"]) ?? null,
    ownerAddress: row.owner_address ?? null,
    createdAt: row.created_at,
  };
}

function rowToDelivery(r: Record<string, unknown>): WebhookDelivery {
  return {
    id: r.id as number,
    eventId: (r.event_id as number | null) ?? null,
    paymentId: r.payment_id as string,
    merchantId: (r.merchant_id as string | null) ?? "",
    eventType: r.event_type as PaymentEventType,
    url: r.url as string,
    attempts: r.attempts as number,
    status: ((r.status as string) ?? "pending") as WebhookDelivery["status"],
    lastStatus: (r.last_status as number | null) ?? null,
    nextAttemptAt: (r.next_attempt_at as number | null) ?? null,
    deliveredAt: (r.delivered_at as number | null) ?? null,
    createdAt: r.created_at as number,
  };
}

function rowToPayment(r: Record<string, unknown>): Payment {
  return {
    id: r.id as string,
    merchantId: r.merchant_id as string,
    state: r.state as PaymentState,
    request: JSON.parse(r.request_json as string),
    quote: r.quote_json ? (JSON.parse(r.quote_json as string) as Quote) : null,
    zcashAddress: (r.zcash_address as string | null) ?? null,
    detectedTxid: (r.detected_txid as string | null) ?? null,
    detectedZat: (r.detected_zat as string | null) ?? null,
    confirmations: (r.confirmations as number | null) ?? null,
    evidenceKind: (r.evidence_kind as EvidenceKind | null) ?? null,
    payoutTxHash: (r.payout_tx_hash as string | null) ?? null,
    payoutWei: (r.payout_wei as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    expiresAt: (r.expires_at as number | null) ?? null,
    completedAt: (r.completed_at as number | null) ?? null,
    chainEvidence: r.chain_evidence_json ? (JSON.parse(r.chain_evidence_json as string) as ChainEvidence) : null,
    allocationTip: (r.allocation_tip as number | null) ?? null,
    mode: r.mode as PaymentMode,
    error: (r.error as string | null) ?? null,
  };
}
