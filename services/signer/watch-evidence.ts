// Signer-owned watch wallet only; no backend evidence files or backend wallet paths.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Snapshot, Payment } from "../execution/store.ts";
import { amount, canonical, digest } from "../settlement/protocol.ts";
import type {
  IndependentEvidence,
  IndependentReader,
} from "./refund-review.ts";
import type { NativeEvidence, NativeEvidenceReader } from "./native-refund.ts";
import { NativeDestinationDecoder } from "../settlement/native-address.ts";
const exec = promisify(execFile);
export type WatchSnapshot = Snapshot & {
  watchOnly: true;
  liveChain: true;
  liveRefundsEnabled: false;
  source: "https://testnet.zec.rocks:443";
  account: string;
  address: string;
  birthday: number;
  blockHash: string;
  native: {
    fullViewingKey: string;
    anchor: string;
    anchorHeight: number;
    inputs: (NativeEvidence["inputs"][number] & { paymentKey: string })[];
  };
};
/** Dedicated UFVK wallet, keyed by SHA256(UFVK); never silently falls back to legacy. */
export class WatchOnlyZcash {
  constructor(readonly wallet: string) {}
  async observe(): Promise<WatchSnapshot> {
    try {
      const { stdout } = await exec(
        resolve(
          `target/debug/zecone-zcash-watch${process.platform === "win32" ? ".exe" : ""}`,
        ),
        ["--wallet", resolve(this.wallet), "observe"],
        { windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const snapshot = JSON.parse(stdout) as WatchSnapshot;
      validateWatchSnapshot(snapshot, Math.floor(Date.now() / 1000));
      return snapshot;
    } catch {
      throw Error("independent_watch_scan_failed");
    }
  }
  // Provision dedicated account wallets in advance on the signer; no seed-based allocation.
  async allocate(_orderId: string): Promise<never> {
    throw Error("preprovisioned_watch_account_required");
  }
}
const hex = (s: unknown, n: number) =>
  typeof s === "string" && new RegExp(`^[a-f0-9]{${n}}$`).test(s);
const height = (n: number) => Number.isSafeInteger(n) && n > 0;
const paymentKey = (p: Payment) => `${p.txid}:${p.pool}:${p.index}`;
const receiptDigest = (s: WatchSnapshot) =>
  digest(
    s.payments
      .map((p) => ({
        key: paymentKey(p),
        zatoshis: p.zatoshis,
        height: p.height,
        block_hash: p.blockHash,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  );
export function validateWatchSnapshot(s: WatchSnapshot, now: number) {
  if (
    s.network !== "zcash-testnet" ||
    s.watchOnly !== true ||
    s.liveChain !== true ||
    s.liveRefundsEnabled !== false ||
    s.source !== "https://testnet.zec.rocks:443" ||
    !hex(s.account, 64) ||
    !hex(s.blockHash, 64) ||
    !height(s.tip) ||
    s.scanned !== s.tip ||
    !height(s.birthday) ||
    s.birthday >= s.tip ||
    !Number.isSafeInteger(s.observedAt) ||
    s.observedAt > now + 5 ||
    now - s.observedAt > 120 ||
    !hex(s.native?.fullViewingKey, 192) ||
    !hex(s.native?.anchor, 64) ||
    !Array.isArray(s.payments) ||
    !Array.isArray(s.native.inputs)
  )
    throw Error("invalid_independent_chain_snapshot");
  if (
    !height(s.native.anchorHeight) ||
    s.native.anchorHeight > s.tip - 9 ||
    s.native.anchorHeight < s.birthday
  )
    throw Error("invalid_independent_anchor_height");
  const seen = new Set<string>();
  for (const p of s.payments) {
    if (
      p.account !== s.account ||
      !hex(p.txid, 64) ||
      !hex(p.blockHash, 64) ||
      ![2, 3, 4].includes(p.pool) ||
      !Number.isSafeInteger(p.index) ||
      p.index < 0 ||
      !height(p.height) ||
      p.height > s.tip ||
      p.height <= s.birthday ||
      seen.has(paymentKey(p))
    )
      throw Error("invalid_independent_payment");
    amount(p.zatoshis, true);
    seen.add(paymentKey(p));
  }
  const nfs = new Set<string>(),
    keys = new Set<string>();
  for (const i of s.native.inputs) {
    const p = s.payments.find((p) => paymentKey(p) === i.paymentKey);
    if (
      !p ||
      p.pool !== 4 ||
      p.zatoshis !== i.zatoshis ||
      p.height !== i.minedHeight ||
      !hex(i.nullifier, 64) ||
      nfs.has(i.nullifier) ||
      keys.has(i.paymentKey)
    )
      throw Error("independent_note_payment_mismatch");
    nfs.add(i.nullifier);
    keys.add(i.paymentKey);
  }
}
/** Local reviewer decision, not an on-chain fact. Never imported from a refund bundle.
 * The absence of an undisclosed signed EVM transaction cannot be proven by RPC.
 * Separate-device review and an execution interlock remain required before enabling live refunds.
 */
export type RecoveryRegistration = {
  orderId: string;
  account: string;
  intent: { recipient: string; [key: string]: unknown };
  destination: string;
  orderState: "recovery" | "expired" | "failed";
  execution: "never-constructed";
  reviewedAt: number;
  expiresAt: number;
};
export class SignerRecoveryRegistry {
  constructor(readonly db: DatabaseSync) {
    db.exec(
      "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS watch_recovery_registry(order_id TEXT PRIMARY KEY,account TEXT NOT NULL UNIQUE,body TEXT NOT NULL,digest TEXT NOT NULL)",
    );
  }
  register(
    r: RecoveryRegistration,
    explicitReviewedDigest: string,
    now = Math.floor(Date.now() / 1000),
  ) {
    if (
      digest(r) !== explicitReviewedDigest ||
      !/^0x[a-f0-9]{64}$/.test(r.orderId) ||
      !hex(r.account, 64) ||
      !/^0x[a-fA-F0-9]{40}$/.test(r.intent.recipient) ||
      !["recovery", "expired", "failed"].includes(r.orderState) ||
      r.execution !== "never-constructed" ||
      !Number.isSafeInteger(r.reviewedAt) ||
      !Number.isSafeInteger(r.expiresAt) ||
      r.reviewedAt > now ||
      now - r.reviewedAt > 120 ||
      r.expiresAt <= now ||
      r.expiresAt - r.reviewedAt > 3600
    )
      throw Error("explicit_independent_recovery_review_required");
    const old = this.db
      .prepare("SELECT digest FROM watch_recovery_registry WHERE order_id=?")
      .get(r.orderId) as { digest: string } | undefined;
    if (old) {
      if (old.digest !== digest(r))
        throw Error("immutable_recovery_registration");
      return;
    }
    this.db
      .prepare("INSERT INTO watch_recovery_registry VALUES(?,?,?,?)")
      .run(r.orderId, r.account, canonical(r), digest(r));
  }
  read(orderId: string, now: number): RecoveryRegistration {
    const row = this.db
      .prepare(
        "SELECT body,digest FROM watch_recovery_registry WHERE order_id=?",
      )
      .get(orderId) as { body: string; digest: string } | undefined;
    if (!row) throw Error("independent_recovery_not_registered");
    const r = JSON.parse(row.body) as RecoveryRegistration;
    if (digest(r) !== row.digest || r.orderId !== orderId || r.expiresAt <= now)
      throw Error("independent_recovery_expired_or_changed");
    return r;
  }
}
export class WatchRefundReader
  implements IndependentReader, NativeEvidenceReader
{
  readonly liveChain = true as const;
  constructor(
    readonly scanner: Pick<WatchOnlyZcash, "observe">,
    readonly registry: SignerRecoveryRegistry,
    readonly clock = () => Math.floor(Date.now() / 1000),
  ) {}
  validateShieldedDestination(destination: string) {
    return new NativeDestinationDecoder().validate(destination);
  }
  private async evidence(orderId: string) {
    const r = this.registry.read(orderId, this.clock());
    const s = await this.scanner.observe();
    validateWatchSnapshot(s, this.clock());
    // Recheck authorization after a potentially long scan.
    this.registry.read(orderId, this.clock());
    if (s.account !== r.account) throw Error("independent_account_mismatch");
    if (!s.payments.length) throw Error("no_confirmed_independent_payment");
    if (s.payments.some((p) => s.tip - p.height + 1 < 10))
      throw Error("independent_payment_unconfirmed");
    if (s.native.inputs.some((i) => i.minedHeight > s.native.anchorHeight))
      throw Error("independent_note_after_anchor");
    // Native signer is Ironwood-only; no partial refund from mixed, spent or missing notes.
    if (
      s.payments.some((p) => p.pool !== 4) ||
      s.native.inputs.length !== s.payments.length
    )
      throw Error("independent_inputs_spent_missing_or_unsupported");
    const total = s.payments
      .reduce((v, p) => v + amount(p.zatoshis, true), 0n)
      .toString();
    amount(total, true);
    return { r, s, total };
  }
  async read(orderId: string): Promise<IndependentEvidence> {
    const { r, s, total } = await this.evidence(orderId);
    return {
      network: "zcash-testnet",
      orderId,
      intentDigest: digest(r.intent),
      paymentDigest: receiptDigest(s),
      recipient: r.intent.recipient,
      destination: r.destination,
      eligibleZatoshis: total,
      tip: s.tip,
      scanned: s.scanned,
      observedAt: s.observedAt,
      minimumConfirmations: Math.min(
        ...s.payments.map((p) => s.tip - p.height + 1),
      ),
      execution: r.execution,
      orderState: r.orderState,
    };
  }
  async readNative(orderId: string): Promise<NativeEvidence> {
    const { s } = await this.evidence(orderId);
    return {
      paymentDigest: receiptDigest(s),
      fullViewingKey: s.native.fullViewingKey,
      anchor: s.native.anchor,
      tip: s.tip,
      observedAt: s.observedAt,
      inputs: s.native.inputs.map(({ paymentKey: _, ...i }) => i),
    };
  }
}
