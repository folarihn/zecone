// Mainnet shielded payment observation. The Rust watcher holds only a UFVK;
// this module never imports a seed, spending key, signer or broadcast function.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const exec = promisify(execFile);
export const MAINNET_WATCH_NETWORK = "zcash-mainnet" as const;
const HEX64 = /^[a-f0-9]{64}$/;
const ORDER_ID = /^(?:0x)?[a-f0-9]{64}$/;
const UNIFIED = /^u1[0-9a-z]{20,220}$/;
const nativeSnapshots = new WeakSet<object>();
const nativePayments = new WeakSet<object>();
const authorizedObservations = new WeakMap<object, () => boolean>();

export type MainnetWatchPayment = {
  account: string;
  txid: string;
  pool: 2 | 3 | 4;
  index: number;
  zatoshis: string;
  height: number;
  blockHash: string;
  address: string;
  memo: string | null;
  nullifier: string | null;
  locked: boolean;
  spent: boolean;
  isChange: boolean;
  confirmations: number;
  ownershipEvidence: {
    scheme: "zcash-full-transaction-ufvk-v3";
    digest: string;
    providers: 2;
    blockEvidence: {
      scheme: "zcash-header-pow-merkle-v1";
      height: number;
      headerHash: string;
      merkleRoot: string;
      transactionIndex: number;
      transactionCount: number;
      proofOfWork: "PASS";
      readOnly: true;
    };
    chainEvidence: {
      scheme: "zcash-pow-chain-segment-v1";
      startHeight: number;
      endHeight: number;
      startHash: string;
      endHash: string;
      blockCount: number;
      accumulatedWork: string;
      proofOfWork: "PASS";
      continuity: "PASS";
      readOnly: true;
    };
  };
};

export type MainnetWatchCheckpoint = {
  height: number;
  hash: string;
  orchardRoot: string;
};

export type MainnetWatchSnapshot = {
  network: typeof MAINNET_WATCH_NETWORK;
  watchOnly: true;
  liveChain: true;
  liveRefundsEnabled: false;
  source: string;
  peerSource: string;
  account: string;
  address: string;
  birthday: number;
  tip: number;
  scanned: number;
  blockHash: string;
  observedAt: number;
  minimumConfirmations: number;
  anchor: string;
  anchorHeight: number;
  checkpoint: MainnetWatchCheckpoint | null;
  payments: MainnetWatchPayment[];
  /**
   * Only with `--defer-missing-segments`: owned notes found by the compact scan
   * whose raw confirmation segment is not authenticated yet. Never proof of payment.
   */
  pendingCandidates?: MainnetPendingCandidate[];
};

export type MainnetPendingCandidate = {
  account: string;
  txid: string;
  pool: 2 | 3 | 4;
  index: number;
  zatoshis: string;
  height: number;
  blockHash: string;
  address: string;
  isChange: false;
  confirmations: number;
  verified: false;
  evidence: "compact-scan-candidate";
  /** First block of the segment with no raw file, and its provider-agreed hash. */
  missingHeight: number;
  missingHash: string;
  segmentEnd: number;
};

export type MainnetWatchPolicy = {
  network: "zcash";
  enabled: boolean;
  providers: { endpoint: string; operator: string }[];
  independenceAcknowledged: boolean;
  confirmations: number;
};

export type MainnetOrderBinding = {
  orderId: string;
  account: string;
  address: string;
  zatoshis: string;
  expires: number;
  memoHex?: string;
  // Native proof identity is distinct from the canonical execution commitment.
  sourceEvidenceDigest?: string;
};

export type MainnetWatchStatus =
  "awaiting" | "observed" | "confirmed" | "ambiguous" | "invalid";

export type MainnetWatchObservation = {
  orderId: string;
  status: MainnetWatchStatus;
  reason: string;
  tip: number;
  blockHash: string;
  observedAt: number;
  minimumConfirmations: number;
  confirmations: number;
  receivedZatoshis: string;
  paymentDigest: string | null;
  reorgDetected: boolean;
};

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const amountOk = (value: unknown) =>
  typeof value === "string" &&
  /^[0-9]{1,20}$/.test(value) &&
  BigInt(value) > 0n &&
  BigInt(value) <= 2_100_000_000_000_000n;
const https = (value: unknown) => {
  if (typeof value !== "string" || value.length > 220) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !url.hostname.toLowerCase().includes("test")
    );
  } catch {
    return false;
  }
};

const canonicalEndpoint = (value: string) => {
  const url = new URL(value);
  url.hash = "";
  if (url.pathname === "/") url.pathname = "";
  return url.href.replace(/\/$/, "");
};

export function validateMainnetWatchPolicy(policy: MainnetWatchPolicy) {
  if (
    policy?.network !== "zcash" ||
    typeof policy.enabled !== "boolean" ||
    policy.independenceAcknowledged !== true ||
    !Number.isSafeInteger(policy.confirmations) ||
    policy.confirmations < 20 ||
    policy.confirmations > 100 ||
    !Array.isArray(policy.providers) ||
    policy.providers.length !== 2
  )
    throw Error("INVALID_MAINNET_WATCH_POLICY");
  const endpoints = new Set<string>(),
    hosts = new Set<string>(),
    operators = new Set<string>();
  for (const provider of policy.providers) {
    if (!https(provider?.endpoint) || !provider?.operator?.trim())
      throw Error("INVALID_MAINNET_WATCH_POLICY_PROVIDER");
    const endpoint = canonicalEndpoint(provider.endpoint),
      host = new URL(endpoint).hostname.toLowerCase(),
      operator = provider.operator.trim().toLowerCase();
    if (endpoints.has(endpoint) || hosts.has(host) || operators.has(operator))
      throw Error("MAINNET_WATCH_PROVIDER_INDEPENDENCE_REQUIRED");
    endpoints.add(endpoint);
    hosts.add(host);
    operators.add(operator);
  }
  return Object.freeze({
    source: canonicalEndpoint(policy.providers[0].endpoint),
    peer: canonicalEndpoint(policy.providers[1].endpoint),
    minimumConfirmations: policy.confirmations,
  });
}

export function validateMainnetWatchSnapshot(
  s: MainnetWatchSnapshot,
  now = Math.floor(Date.now() / 1000),
) {
  if (
    s?.network !== MAINNET_WATCH_NETWORK ||
    s.watchOnly !== true ||
    s.liveChain !== true ||
    s.liveRefundsEnabled !== false ||
    !https(s.source) ||
    !https(s.peerSource) ||
    s.source === s.peerSource ||
    !HEX64.test(s.account) ||
    !UNIFIED.test(s.address) ||
    !positive(s.birthday) ||
    !positive(s.tip) ||
    s.scanned !== s.tip ||
    s.birthday >= s.tip ||
    !HEX64.test(s.blockHash) ||
    !Number.isSafeInteger(s.observedAt) ||
    s.observedAt > now + 5 ||
    now - s.observedAt > 120 ||
    !Number.isSafeInteger(s.minimumConfirmations) ||
    s.minimumConfirmations < 1 ||
    s.minimumConfirmations > 100 ||
    !HEX64.test(s.anchor) ||
    !positive(s.anchorHeight) ||
    s.anchorHeight < s.birthday ||
    s.anchorHeight > s.tip - 9 ||
    !Array.isArray(s.payments)
  )
    throw Error("INVALID_MAINNET_WATCH_SNAPSHOT");
  if (s.checkpoint !== null) {
    if (
      !s.checkpoint ||
      !positive(s.checkpoint.height) ||
      s.checkpoint.height > s.tip ||
      !HEX64.test(s.checkpoint.hash) ||
      !HEX64.test(s.checkpoint.orchardRoot)
    )
      throw Error("INVALID_MAINNET_CHECKPOINT");
  }
  const seen = new Set<string>();
  for (const p of s.payments) {
    if (
      p.account !== s.account ||
      !HEX64.test(p.txid) ||
      ![2, 3, 4].includes(p.pool) ||
      !Number.isSafeInteger(p.index) ||
      p.index < 0 ||
      !amountOk(p.zatoshis) ||
      !positive(p.height) ||
      p.height < s.birthday ||
      p.height > s.tip ||
      !HEX64.test(p.blockHash) ||
      p.confirmations !== s.tip - p.height + 1 ||
      typeof p.address !== "string" ||
      !UNIFIED.test(p.address) ||
      (p.memo !== null && !/^(?:[a-f0-9]{2})+$/.test(p.memo)) ||
      (p.nullifier !== null && !HEX64.test(p.nullifier)) ||
      typeof p.locked !== "boolean" ||
      typeof p.spent !== "boolean" ||
      typeof p.isChange !== "boolean" ||
      p.ownershipEvidence?.scheme !== "zcash-full-transaction-ufvk-v3" ||
      !HEX64.test(p.ownershipEvidence?.digest ?? "") ||
      p.ownershipEvidence?.providers !== 2 ||
      p.ownershipEvidence?.blockEvidence?.scheme !==
        "zcash-header-pow-merkle-v1" ||
      p.ownershipEvidence.blockEvidence.height !== p.height ||
      p.ownershipEvidence.blockEvidence.headerHash !== p.blockHash ||
      !HEX64.test(p.ownershipEvidence.blockEvidence.merkleRoot) ||
      !Number.isSafeInteger(
        p.ownershipEvidence.blockEvidence.transactionIndex,
      ) ||
      p.ownershipEvidence.blockEvidence.transactionIndex < 0 ||
      !Number.isSafeInteger(
        p.ownershipEvidence.blockEvidence.transactionCount,
      ) ||
      p.ownershipEvidence.blockEvidence.transactionCount < 1 ||
      p.ownershipEvidence.blockEvidence.transactionIndex >=
        p.ownershipEvidence.blockEvidence.transactionCount ||
      p.ownershipEvidence.blockEvidence.proofOfWork !== "PASS" ||
      p.ownershipEvidence.blockEvidence.readOnly !== true ||
      p.ownershipEvidence.chainEvidence?.scheme !==
        "zcash-pow-chain-segment-v1" ||
      p.ownershipEvidence.chainEvidence.startHeight !== p.height ||
      p.ownershipEvidence.chainEvidence.startHash !== p.blockHash ||
      !positive(p.ownershipEvidence.chainEvidence.endHeight) ||
      p.ownershipEvidence.chainEvidence.endHeight < p.height ||
      p.ownershipEvidence.chainEvidence.endHeight > s.tip ||
      !HEX64.test(p.ownershipEvidence.chainEvidence.endHash) ||
      !positive(p.ownershipEvidence.chainEvidence.blockCount) ||
      p.ownershipEvidence.chainEvidence.blockCount !==
        p.ownershipEvidence.chainEvidence.endHeight - p.height + 1 ||
      p.ownershipEvidence.chainEvidence.blockCount !==
        Math.min(p.confirmations, s.minimumConfirmations) ||
      typeof p.ownershipEvidence.chainEvidence.accumulatedWork !== "string" ||
      !/^[1-9a-f][0-9a-f]*$/.test(
        p.ownershipEvidence.chainEvidence.accumulatedWork,
      ) ||
      p.ownershipEvidence.chainEvidence.proofOfWork !== "PASS" ||
      p.ownershipEvidence.chainEvidence.continuity !== "PASS" ||
      p.ownershipEvidence.chainEvidence.readOnly !== true
    )
      throw Error("INVALID_MAINNET_PAYMENT");
    const key = `${p.txid}:${p.pool}:${p.index}`;
    if (seen.has(key)) throw Error("DUPLICATE_MAINNET_PAYMENT");
    seen.add(key);
  }
  if (s.pendingCandidates === undefined) return;
  if (!Array.isArray(s.pendingCandidates))
    throw Error("INVALID_MAINNET_PENDING_CANDIDATE");
  for (const c of s.pendingCandidates) {
    const end = positive(c?.height)
      ? c.height + Math.min(s.tip - c.height + 1, s.minimumConfirmations) - 1
      : -1;
    if (
      !c ||
      !positive(c.height) ||
      c.account !== s.account ||
      !HEX64.test(c.txid) ||
      ![2, 3, 4].includes(c.pool) ||
      !Number.isSafeInteger(c.index) ||
      c.index < 0 ||
      !amountOk(c.zatoshis) ||
      c.height < s.birthday ||
      c.height > s.tip ||
      !HEX64.test(c.blockHash) ||
      typeof c.address !== "string" ||
      !UNIFIED.test(c.address) ||
      c.isChange !== false ||
      c.confirmations !== s.tip - c.height + 1 ||
      c.verified !== false ||
      c.evidence !== "compact-scan-candidate" ||
      c.segmentEnd !== end ||
      !Number.isSafeInteger(c.missingHeight) ||
      c.missingHeight < c.height ||
      c.missingHeight > c.segmentEnd ||
      !HEX64.test(c.missingHash) ||
      (c.missingHeight === c.height && c.missingHash !== c.blockHash)
    )
      throw Error("INVALID_MAINNET_PENDING_CANDIDATE");
    // A note is either verified or pending, never both, and never twice.
    const key = `${c.txid}:${c.pool}:${c.index}`;
    if (seen.has(key)) throw Error("DUPLICATE_MAINNET_PAYMENT");
    seen.add(key);
  }
}

export function verifyOwnedNote(
  s: MainnetWatchSnapshot,
  binding: MainnetOrderBinding,
  payment: MainnetWatchPayment,
): {
  paymentKey: string;
  amount: string;
  pool: number;
  confirmations: number;
  anchorHeight: number;
  paymentDigest: string;
} {
  const memo = binding.memoHex;
  if (
    !nativeSnapshots.has(s) ||
    !nativePayments.has(payment) ||
    !s.payments.includes(payment)
  )
    throw Error("MAINNET_OWNED_NOTE_CRYPTOGRAPHIC_VERIFIER_REQUIRED");
  if (
    payment.account !== s.account ||
    binding.account !== s.account ||
    payment.address !== binding.address ||
    payment.isChange ||
    payment.spent ||
    payment.locked ||
    payment.height > s.anchorHeight ||
    payment.zatoshis !== binding.zatoshis ||
    (binding.sourceEvidenceDigest !== undefined &&
      payment.ownershipEvidence.digest !== binding.sourceEvidenceDigest) ||
    (memo !== undefined && payment.memo !== memo)
  )
    throw Error("OWNED_NOTE_REQUIREMENTS_NOT_MET");
  return {
    paymentKey: `${payment.txid}:${payment.pool}:${payment.index}`,
    amount: payment.zatoshis,
    pool: payment.pool,
    confirmations: payment.confirmations,
    anchorHeight: s.anchorHeight,
    paymentDigest: digest({
      network: s.network,
      account: s.account,
      address: payment.address,
      txid: payment.txid,
      pool: payment.pool,
      index: payment.index,
      zatoshis: payment.zatoshis,
      height: payment.height,
      blockHash: payment.blockHash,
      source: s.source,
      peerSource: s.peerSource,
      minimumConfirmations: s.minimumConfirmations,
      ownershipEvidence: payment.ownershipEvidence,
    }),
  };
}

export class MainnetWatchScanner {
  readonly policy: ReturnType<typeof validateMainnetWatchPolicy>;
  constructor(
    readonly wallet: string,
    readonly source: string,
    readonly peer: string,
    policy: MainnetWatchPolicy,
    readonly executable = resolve(
      `target/debug/zecone-zcash-watch${process.platform === "win32" ? ".exe" : ""}`,
    ),
    readonly executableArgsPrefix: string[] = [],
    readonly authenticatedBlockDirectory = "",
    readonly receivingAddress?: string,
    /**
     * Targeted observation: also read raw blocks from this candidate-segment
     * directory and report notes whose segment is missing as pending candidates.
     */
    readonly candidateBlockDirectory?: string,
  ) {
    this.policy = validateMainnetWatchPolicy(policy);
    if (
      canonicalEndpoint(source) !== this.policy.source ||
      canonicalEndpoint(peer) !== this.policy.peer
    )
      throw Error("MAINNET_WATCH_POLICY_PROVIDER_MISMATCH");
  }

  async observe(checkpointHeight?: number): Promise<MainnetWatchSnapshot> {
    if (!https(this.source) || !https(this.peer) || this.source === this.peer)
      throw Error("INVALID_MAINNET_WATCH_PROVIDERS");
    if (!this.authenticatedBlockDirectory)
      throw Error("AUTHENTICATED_MAINNET_BLOCK_DIRECTORY_REQUIRED");
    const args = [
      "--wallet",
      resolve(this.wallet),
      "observe-mainnet",
      "--server",
      this.source,
      "--peer",
      this.peer,
      "--minimum-confirmations",
      String(this.policy.minimumConfirmations),
      "--authenticated-block-dir",
      resolve(this.authenticatedBlockDirectory),
    ];
    if (checkpointHeight !== undefined) {
      if (!positive(checkpointHeight)) throw Error("INVALID_CHECKPOINT_HEIGHT");
      args.push("--checkpoint-height", String(checkpointHeight));
    }
    if (this.receivingAddress !== undefined) {
      if (!UNIFIED.test(this.receivingAddress))
        throw Error("INVALID_RECEIVING_ADDRESS");
      args.push("--receiving-address", this.receivingAddress);
    }
    if (this.candidateBlockDirectory !== undefined)
      args.push(
        "--candidate-block-dir",
        resolve(this.candidateBlockDirectory),
        "--defer-missing-segments",
      );
    let stdout: string;
    try {
      ({ stdout } = await exec(
        this.executable,
        [...this.executableArgsPrefix, ...args],
        {
          windowsHide: true,
          timeout: 900_000,
          maxBuffer: 32 * 1024 * 1024,
        },
      ));
    } catch (e) {
      const detail = String((e as { stderr?: string }).stderr ?? "");
      throw Error(
        detail.includes("checkpoint_above_tip")
          ? "MAINNET_CHECKPOINT_ABOVE_TIP"
          : "mainnet_watch_scan_failed",
      );
    }
    const snapshot = JSON.parse(stdout) as MainnetWatchSnapshot;
    validateMainnetWatchSnapshot(snapshot);
    if (
      canonicalEndpoint(snapshot.source) !== this.policy.source ||
      canonicalEndpoint(snapshot.peerSource) !== this.policy.peer ||
      snapshot.minimumConfirmations !== this.policy.minimumConfirmations ||
      (this.receivingAddress !== undefined &&
        snapshot.address !== this.receivingAddress)
    )
      throw Error("MAINNET_WATCH_SNAPSHOT_POLICY_MISMATCH");
    // Pending candidates are reported only when this scanner asked for them.
    if (
      (this.candidateBlockDirectory === undefined) !==
      (snapshot.pendingCandidates === undefined)
    )
      throw Error("MAINNET_WATCH_SNAPSHOT_POLICY_MISMATCH");
    if (snapshot.checkpoint) Object.freeze(snapshot.checkpoint);
    for (const candidate of snapshot.pendingCandidates ?? [])
      Object.freeze(candidate);
    if (snapshot.pendingCandidates) Object.freeze(snapshot.pendingCandidates);
    for (const payment of snapshot.payments) {
      Object.freeze(payment.ownershipEvidence.blockEvidence);
      Object.freeze(payment.ownershipEvidence.chainEvidence);
      Object.freeze(payment.ownershipEvidence);
      Object.freeze(payment);
      nativePayments.add(payment);
    }
    Object.freeze(snapshot.payments);
    Object.freeze(snapshot);
    nativeSnapshots.add(snapshot);
    return snapshot;
  }
}

type CheckpointRow = {
  tip: number;
  block_hash: string;
  anchor: string;
  anchor_height: number;
  source: string;
  peer_source: string;
  observed_at: number;
};

type PaymentRow = {
  payment_key: string;
  order_id: string;
  status: string;
  active: number;
  nullifier: string | null;
};

export class MainnetWatchJournal {
  readonly db: DatabaseSync;
  private readonly verifiedOrders = new Set<string>();
  private readonly activeObservations = new Map<
    string,
    MainnetWatchObservation
  >();
  constructor(
    path: string,
    readonly now = () => Math.floor(Date.now() / 1000),
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mainnet_watch_checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), tip INTEGER NOT NULL, block_hash TEXT NOT NULL, anchor TEXT NOT NULL, anchor_height INTEGER NOT NULL, source TEXT NOT NULL, peer_source TEXT NOT NULL, observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mainnet_watch_orders(order_id TEXT PRIMARY KEY, account TEXT NOT NULL, address TEXT NOT NULL, zatoshis TEXT NOT NULL, expires INTEGER NOT NULL, memo_hex TEXT, binding_digest TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mainnet_watch_payments(payment_key TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES mainnet_watch_orders(order_id), txid TEXT NOT NULL, pool INTEGER NOT NULL, output_index INTEGER NOT NULL, zatoshis TEXT NOT NULL, height INTEGER NOT NULL, block_hash TEXT NOT NULL, address TEXT NOT NULL, nullifier TEXT, memo_hex TEXT, status TEXT NOT NULL, active INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mainnet_watch_payments_order ON mainnet_watch_payments(order_id, active);`);
  }
  close() {
    this.verifiedOrders.clear();
    this.activeObservations.clear();
    this.db.close();
  }
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  bind(binding: MainnetOrderBinding) {
    const body = {
        orderId: binding.orderId,
        account: binding.account,
        address: binding.address,
        zatoshis: binding.zatoshis,
        expires: binding.expires,
        ...(binding.memoHex === undefined ? {} : { memoHex: binding.memoHex }),
        ...(binding.sourceEvidenceDigest === undefined
          ? {}
          : { sourceEvidenceDigest: binding.sourceEvidenceDigest }),
      },
      digestValue = digest(body);
    if (
      !ORDER_ID.test(binding.orderId) ||
      !HEX64.test(binding.account) ||
      !UNIFIED.test(binding.address) ||
      !amountOk(binding.zatoshis) ||
      !Number.isSafeInteger(binding.expires) ||
      binding.expires <= this.now() ||
      (binding.sourceEvidenceDigest !== undefined &&
        !HEX64.test(binding.sourceEvidenceDigest)) ||
      (binding.memoHex !== undefined &&
        !/^(?:[a-f0-9]{2})+$/.test(binding.memoHex))
    )
      throw Error("INVALID_MAINNET_ORDER_BINDING");
    const old = this.db
      .prepare(
        "SELECT binding_digest FROM mainnet_watch_orders WHERE order_id=?",
      )
      .get(binding.orderId) as { binding_digest: string } | undefined;
    if (old) {
      if (old.binding_digest !== digestValue)
        throw Error("IMMUTABLE_MAINNET_ORDER_BINDING");
      return;
    }
    this.db
      .prepare(
        "INSERT INTO mainnet_watch_orders(order_id,account,address,zatoshis,expires,memo_hex,binding_digest,created) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        binding.orderId,
        binding.account,
        binding.address,
        binding.zatoshis,
        binding.expires,
        binding.memoHex ?? null,
        digestValue,
        this.now(),
      );
  }
  private checkpoint() {
    return this.db
      .prepare("SELECT * FROM mainnet_watch_checkpoint WHERE id=1")
      .get() as CheckpointRow | undefined;
  }
  checkpointHeight() {
    return this.checkpoint()?.tip;
  }
  observe(
    binding: MainnetOrderBinding,
    s: MainnetWatchSnapshot,
  ): MainnetWatchObservation {
    this.verifiedOrders.delete(binding.orderId);
    this.activeObservations.delete(binding.orderId);
    validateMainnetWatchSnapshot(s, this.now());
    const now = this.now();
    if (binding.account !== s.account || binding.address !== s.address)
      throw Error("MAINNET_ORDER_WATCH_ACCOUNT_MISMATCH");
    this.bind(binding);
    const old = this.checkpoint();
    let reorgDetected = false;
    if (old) {
      if (s.tip < old.tip) {
        reorgDetected = true;
      } else if (s.checkpoint === null) {
        if (s.tip !== old.tip || s.blockHash !== old.block_hash)
          throw Error("MAINNET_WATCH_CHECKPOINT_MISSING");
      } else if (s.checkpoint.height !== old.tip) {
        throw Error("MAINNET_WATCH_CHECKPOINT_MISSING");
      } else if (s.checkpoint.hash !== old.block_hash) {
        reorgDetected = true;
      } else if (s.tip === old.tip && s.blockHash !== old.block_hash) {
        reorgDetected = true;
      }
    } else if (s.checkpoint !== null) {
      throw Error("MAINNET_WATCH_UNEXPECTED_CHECKPOINT");
    }
    const candidates = s.payments.filter(
      (p) =>
        p.account === binding.account &&
        p.address === binding.address &&
        !p.isChange,
    );
    const memoOk = (p: MainnetWatchPayment) =>
      binding.memoHex === undefined || p.memo === binding.memoHex;
    const exact = candidates.filter(
      (p) => p.zatoshis === binding.zatoshis && memoOk(p),
    );
    let status: MainnetWatchStatus = "awaiting",
      reason = "NO_MATCHING_PAYMENT";
    if (candidates.some((p) => p.spent || p.locked)) {
      status = "invalid";
      reason = "NOTE_SPENT_OR_LOCKED";
    }
    if (exact.length > 1) {
      status = "ambiguous";
      reason = "MULTIPLE_MATCHING_PAYMENTS";
    } else if (exact.length === 1) {
      try {
        const owned = verifyOwnedNote(s, binding, exact[0]);
        status =
          exact[0].confirmations >= s.minimumConfirmations
            ? "confirmed"
            : "observed";
        reason =
          status === "confirmed"
            ? "OWNED_NOTE_CONFIRMED"
            : "OWNED_NOTE_AWAITING_CONFIRMATIONS";
        void owned;
      } catch {
        status = "invalid";
        reason = "OWNED_NOTE_REQUIREMENTS_NOT_MET";
      }
    } else if (candidates.length) {
      status = "observed";
      reason = "PAYMENT_AMOUNT_OR_ATTRIBUTION_MISMATCH";
    }
    if (reorgDetected) {
      status = "invalid";
      reason = "MAINNET_CHAIN_REORGANIZATION";
    }
    const observation = this.atomic(() => {
      if (reorgDetected) {
        this.db
          .prepare(
            "UPDATE mainnet_watch_payments SET active=0,status='reorged',last_seen=? WHERE order_id=? AND active=1",
          )
          .run(now, binding.orderId);
      }
      const activeKeys = new Set<string>();
      for (const p of candidates) {
        const key = `${p.txid}:${p.pool}:${p.index}`;
        const prior = this.db
          .prepare(
            "SELECT payment_key,order_id,status,active,nullifier FROM mainnet_watch_payments WHERE payment_key=?",
          )
          .get(key) as PaymentRow | undefined;
        if (prior && prior.order_id !== binding.orderId)
          throw Error("MAINNET_PAYMENT_REUSE_ACROSS_ORDERS");
        if (
          prior &&
          prior.nullifier !== null &&
          prior.nullifier !== p.nullifier
        )
          throw Error("MAINNET_PAYMENT_NULLIFIER_CHANGED");
        const isExact = exact.includes(p);
        const rowStatus =
          isExact && exact.length === 1
            ? status === "invalid" || p.spent || p.locked
              ? "invalid"
              : p.confirmations >= s.minimumConfirmations
                ? "confirmed"
                : "observed"
            : "ambiguous";
        this.db
          .prepare(
            "INSERT INTO mainnet_watch_payments(payment_key,order_id,txid,pool,output_index,zatoshis,height,block_hash,address,nullifier,memo_hex,status,active,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(payment_key) DO UPDATE SET zatoshis=excluded.zatoshis,height=excluded.height,block_hash=excluded.block_hash,address=excluded.address,nullifier=excluded.nullifier,memo_hex=excluded.memo_hex,status=excluded.status,active=1,last_seen=excluded.last_seen",
          )
          .run(
            key,
            binding.orderId,
            p.txid,
            p.pool,
            p.index,
            p.zatoshis,
            p.height,
            p.blockHash,
            p.address,
            p.nullifier,
            p.memo,
            rowStatus,
            now,
            now,
          );
        activeKeys.add(key);
      }
      for (const row of this.db
        .prepare(
          "SELECT payment_key FROM mainnet_watch_payments WHERE order_id=? AND active=1",
        )
        .all(binding.orderId) as { payment_key: string }[])
        if (!activeKeys.has(row.payment_key))
          this.db
            .prepare(
              "UPDATE mainnet_watch_payments SET active=0,status=? ,last_seen=? WHERE payment_key=?",
            )
            .run(reorgDetected ? "reorged" : "invalid", now, row.payment_key);
      const paymentDigest =
        exact.length === 1 && status !== "invalid"
          ? verifyOwnedNote(s, binding, exact[0]).paymentDigest
          : null;
      this.db
        .prepare(
          "INSERT INTO mainnet_watch_checkpoint(id,tip,block_hash,anchor,anchor_height,source,peer_source,observed_at) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tip=excluded.tip,block_hash=excluded.block_hash,anchor=excluded.anchor,anchor_height=excluded.anchor_height,source=excluded.source,peer_source=excluded.peer_source,observed_at=excluded.observed_at",
        )
        .run(
          s.tip,
          s.blockHash,
          s.anchor,
          s.anchorHeight,
          s.source,
          s.peerSource,
          s.observedAt,
        );
      return Object.freeze({
        orderId: binding.orderId,
        status,
        reason,
        tip: s.tip,
        blockHash: s.blockHash,
        observedAt: s.observedAt,
        minimumConfirmations: s.minimumConfirmations,
        confirmations: exact.length === 1 ? exact[0].confirmations : 0,
        receivedZatoshis: candidates
          .reduce((a, p) => a + BigInt(p.zatoshis), 0n)
          .toString(),
        paymentDigest,
        reorgDetected,
      }) as MainnetWatchObservation;
    });
    if (
      observation.status === "confirmed" &&
      observation.paymentDigest &&
      !observation.reorgDetected
    ) {
      this.verifiedOrders.add(binding.orderId);
      this.activeObservations.set(binding.orderId, observation);
      authorizedObservations.set(
        observation,
        () =>
          this.verifiedOrders.has(binding.orderId) &&
          this.activeObservations.get(binding.orderId) === observation,
      );
    } else {
      this.verifiedOrders.delete(binding.orderId);
      this.activeObservations.delete(binding.orderId);
    }
    return observation;
  }
  status(orderId: string) {
    const order = this.db
      .prepare("SELECT * FROM mainnet_watch_orders WHERE order_id=?")
      .get(orderId) as Record<string, unknown> | undefined;
    if (!order) throw Error("UNKNOWN_MAINNET_ORDER");
    return {
      ...order,
      ownershipVerified: this.verifiedOrders.has(orderId),
      payments: (
        this.db
          .prepare(
            "SELECT status,active,zatoshis,height,payment_key FROM mainnet_watch_payments WHERE order_id=? ORDER BY first_seen",
          )
          .all(orderId) as {
          status: string;
          active: number;
          zatoshis: string;
          height: number;
          payment_key: string;
        }[]
      ).map(({ payment_key, ...p }) => ({
        ...p,
        status:
          p.status === "confirmed" && !this.verifiedOrders.has(orderId)
            ? "verification-required"
            : p.status,
        paymentRef: createHash("sha256").update(payment_key).digest("hex"),
      })),
    };
  }
}

export async function observeMainnetWatch(
  journal: MainnetWatchJournal,
  scanner: MainnetWatchScanner,
  binding: MainnetOrderBinding,
) {
  const prior = journal.checkpointHeight();
  let snapshot: MainnetWatchSnapshot;
  try {
    snapshot = await scanner.observe(prior);
  } catch (e) {
    if (
      !prior ||
      !(e instanceof Error) ||
      e.message !== "MAINNET_CHECKPOINT_ABOVE_TIP"
    )
      throw e;
    snapshot = await scanner.observe();
  }
  return journal.observe(binding, snapshot);
}

export function assertMainnetPaymentAuthorization(
  observation: MainnetWatchObservation,
  expected: {
    orderId: string;
    paymentDigest: string;
    zatoshis: string;
  },
  now = Math.floor(Date.now() / 1000),
) {
  const active = authorizedObservations.get(observation);
  if (
    !active?.() ||
    observation.status !== "confirmed" ||
    observation.orderId !== expected.orderId ||
    observation.paymentDigest !== expected.paymentDigest ||
    observation.receivedZatoshis !== expected.zatoshis ||
    observation.confirmations < observation.minimumConfirmations ||
    observation.reorgDetected ||
    !Number.isSafeInteger(observation.observedAt) ||
    observation.observedAt > now + 5 ||
    now - observation.observedAt > 120
  )
    throw Error("VERIFIED_MAINNET_PAYMENT_AUTHORIZATION_REQUIRED");
  return true;
}
