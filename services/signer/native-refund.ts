// Signer device only. Deliberately not imported by wallet/backend HTTP services.
import { spawn } from "node:child_process";
import { createHash, type KeyObject } from "node:crypto";
import { resolve } from "node:path";
import { decrypt } from "./keystore.ts";
import {
  IndependentRefundReviewer,
  type UnsignedRefundBundle,
} from "./refund-review.ts";
import {
  canonical,
  digest,
  verifyApproval,
  type Approval,
} from "../settlement/protocol.ts";

export type NativeEvidence = {
  paymentDigest?: string;
  fullViewingKey: string;
  anchor: string;
  tip: number;
  observedAt: number;
  inputs: { nullifier: string; zatoshis: string; minedHeight: number }[];
};
export type NativePolicy = NativeEvidence & {
  version: 1;
  network: "zcash-testnet";
  requestDigest: string;
  orderId: string;
  destination: string;
  refundZatoshis: string;
  feeCeilingZatoshis: string;
  eligibleZatoshis: string;
  expiresAt: number;
};
export type NativeReview = {
  requestDigest: string;
  pcztDigest: string;
  reviewDigest: string;
  shieldedSighash: string;
  refundZatoshis: string;
  feeZatoshis: string;
  changeZatoshis: string;
  expiryHeight: number;
  signedInputs: number;
  liveEnabled: false;
};
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** Bounded stdio transport; no shell, env secrets, key paths or network operation. */
export async function nativeCall(request: object): Promise<any> {
  const input = Buffer.from(JSON.stringify(request));
  if (input.length > 1114112) {
    input.fill(0);
    throw Error("native_input_limit");
  }
  return new Promise((yes, no) => {
    const child = spawn(
      resolve(
        `target/debug/zecone-refund-signer${process.platform === "win32" ? ".exe" : ""}`,
      ),
      ["isolated-development"],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    let length = 0,
      failed = false;
    const reject = () => {
      if (failed) return;
      failed = true;
      child.kill();
      input.fill(0);
      output.forEach((b) => b.fill(0));
      no(Error("native_refund_signer_rejected"));
    };
    const timer = setTimeout(
      reject,
      (request as { operation?: string }).operation === "finalize-isolated"
        ? 180000
        : 30000,
    );
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.stderr.resume(); // Never forward native parser/input details to application logs.
    child.stdout.on("data", (b: Buffer) => {
      length += b.length;
      if (length > 600000) reject();
      else output.push(b);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      input.fill(0);
      if (failed) return;
      if (code !== 0) {
        reject();
        return;
      }
      const bytes = Buffer.concat(output);
      try {
        yes(JSON.parse(bytes.toString("utf8")));
      } catch {
        no(Error("native_refund_invalid_response"));
      } finally {
        bytes.fill(0);
        output.forEach((b) => b.fill(0));
      }
    });
    child.stdin.end(input, () => input.fill(0));
  });
}
/** Separate vault for a NEW isolated Orchard spending key; never an existing seed. */
export class IsolatedSpendVault {
  #secret: Buffer | undefined;
  #expiry = 0;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  lock() {
    this.#generation++;
    this.#secret?.fill(0);
    this.#secret = undefined;
    this.#expiry = 0;
    clearTimeout(this.#timer);
  }
  get unlocked() {
    if (Date.now() >= this.#expiry) this.lock();
    return !!this.#secret;
  }
  async unlock(
    envelope: unknown,
    password: Buffer,
    consent: boolean,
    ttlMs = 60000,
  ) {
    this.lock();
    if (
      consent !== true ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 300000
    )
      throw Error("explicit_isolated_unlock_required");
    const generation = this.#generation,
      secret = await decrypt(envelope, password, "isolated-wallet-test");
    if (secret.length !== 32 || generation !== this.#generation) {
      secret.fill(0);
      throw Error("invalid_or_cancelled_isolated_unlock");
    }
    this.#secret = secret;
    this.#expiry = Date.now() + ttlMs;
    this.#timer = setTimeout(() => this.lock(), ttlMs);
    this.#timer.unref();
  }
  async sign(policy: NativePolicy, pczt: Buffer, reviewedDigest: string) {
    if (!this.unlocked) throw Error("isolated_spend_vault_locked");
    // JSON/Node/native copies cannot all be guaranteed zeroized. Never log them.
    return nativeCall({
      operation: "sign",
      pcztHex: pczt.toString("hex"),
      policy,
      reviewedDigest,
      secretKeyHex: this.#secret!.toString("hex"),
    });
  }
}
export interface NativeEvidenceReader {
  readonly liveChain?: boolean;
  // Signer-owned note/nullifier/anchor evidence; never the untrusted export bundle.
  readNative(orderId: string): Promise<NativeEvidence>;
}
type JournalRow = {
  id: string;
  order_id: string;
  binding: string;
  state: string;
  pczt: Uint8Array | null;
  pczt_hash: string | null;
  review: string | null;
};
export class IsolatedNativeRefundSigner {
  constructor(
    readonly reviewer: IndependentRefundReviewer,
    readonly reader: NativeEvidenceReader,
    readonly signerPublicKey: KeyObject,
    readonly vault: IsolatedSpendVault,
  ) {
    if (
      signerPublicKey.type !== "public" ||
      signerPublicKey.asymmetricKeyType !== "ed25519" ||
      signerPublicKey.equals(reviewer.operatorKey)
    )
      throw Error("signer_public_key_required");
    reviewer.db
      .exec(`CREATE TABLE IF NOT EXISTS native_refund_journal(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE,binding TEXT NOT NULL,state TEXT NOT NULL,pczt BLOB,pczt_hash TEXT,review TEXT);
      CREATE TABLE IF NOT EXISTS native_refund_events(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,event TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_refund_input_claims(nullifier TEXT PRIMARY KEY,refund_id TEXT NOT NULL);`);
  }
  async review(bundle: UnsignedRefundBundle, pczt: Buffer) {
    bundle = structuredClone(bundle);
    pczt = Buffer.from(pczt);
    if (pczt.length > 262144) throw Error("native_pczt_size");
    await this.reviewer.review(bundle);
    const r = bundle.request,
      { paymentDigest, ...e } = await this.reader.readNative(r.orderId);
    if (this.reader.liveChain === true && paymentDigest !== r.paymentDigest)
      throw Error("independent_native_payment_set_changed");
    const policy: NativePolicy = {
      ...e,
      version: 1,
      network: "zcash-testnet",
      requestDigest: digest(r),
      orderId: r.orderId,
      destination: r.destination,
      refundZatoshis: r.refundZatoshis,
      feeCeilingZatoshis: r.feeCeilingZatoshis,
      eligibleZatoshis: r.eligibleZatoshis,
      expiresAt: r.expires,
    };
    const response = await nativeCall({
      operation: "review",
      pcztHex: pczt.toString("hex"),
      policy,
    });
    if (
      response.transactionSigned !== false ||
      response.liveEnabled !== false ||
      response.review?.requestDigest !== digest(r) ||
      response.review?.pcztDigest !== hash(pczt)
    )
      throw Error("native_review_mismatch");
    return { policy, review: response.review as NativeReview };
  }
  recover(id: string) {
    const r = this.reviewer.db
      .prepare("SELECT * FROM native_refund_journal WHERE id=?")
      .get(id) as JournalRow | undefined;
    if (!r) throw Error("native_request_unknown");
    if (
      r.state !== "SIGNED" ||
      !r.pczt ||
      !r.review ||
      hash(Buffer.from(r.pczt)) !== r.pczt_hash
    )
      throw Error("native_signing_outcome_uncertain");
    return {
      signedPczt: Buffer.from(r.pczt),
      review: JSON.parse(r.review) as NativeReview,
      liveEnabled: false as const,
      broadcast: false as const,
    };
  }
  async sign(
    bundle: UnsignedRefundBundle,
    pczt: Buffer,
    approval: Approval,
    explicitNativeReview: string,
  ) {
    if (this.reader.liveChain === true)
      throw Error("separate_device_validation_required_live_refunds_disabled");
    bundle = structuredClone(bundle);
    pczt = Buffer.from(pczt);
    approval = structuredClone(approval);
    verifyApproval("signer", bundle.request, approval, this.signerPublicKey);
    const { policy, review } = await this.review(bundle, pczt);
    if (review.reviewDigest !== explicitNativeReview)
      throw Error("explicit_native_review_required");
    const db = this.reviewer.db,
      r = bundle.request;
    db.exec("BEGIN IMMEDIATE");
    try {
      const old = db
        .prepare("SELECT * FROM native_refund_journal WHERE id=?")
        .get(r.id) as JournalRow | undefined;
      if (old) {
        if (old.binding !== review.reviewDigest)
          throw Error("native_replay_conflict");
        db.exec("COMMIT");
        return this.recover(r.id);
      }
      if (!this.vault.unlocked) throw Error("isolated_spend_vault_locked");
      db.prepare(
        "INSERT INTO native_refund_journal VALUES(?,?,?,'SIGNING',NULL,NULL,NULL)",
      ).run(r.id, r.orderId, review.reviewDigest);
      for (const input of policy.inputs)
        db.prepare("INSERT INTO native_refund_input_claims VALUES(?,?)").run(
          input.nullifier,
          r.id,
        );
      db.prepare(
        "INSERT INTO native_refund_events(id,event,at) VALUES(?,'native_signing_claimed',?)",
      ).run(r.id, this.reviewer.clock());
      db.exec("COMMIT");
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
    // Any error/timeout from this point leaves SIGNING. It must never auto-retry.
    const result = await this.vault.sign(policy, pczt, review.reviewDigest);
    if (
      result.transactionSigned !== true ||
      result.broadcast !== false ||
      result.liveEnabled !== false ||
      canonical(result.review) !== canonical(review) ||
      typeof result.signedPcztHex !== "string" ||
      !/^([a-f0-9]{2})+$/.test(result.signedPcztHex) ||
      result.signedPcztHex.length > 524288
    )
      throw Error("native_signed_result_mismatch");
    const signed = Buffer.from(result.signedPcztHex, "hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      const updated = db
        .prepare(
          "UPDATE native_refund_journal SET state='SIGNED',pczt=?,pczt_hash=?,review=? WHERE id=? AND state='SIGNING'",
        )
        .run(signed, hash(signed), canonical(review), r.id);
      if (updated.changes !== 1) throw Error("native_journal_conflict");
      db.prepare(
        "INSERT INTO native_refund_events(id,event,at) VALUES(?,'native_signature_saved',?)",
      ).run(r.id, this.reviewer.clock());
      db.exec("COMMIT");
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
    return this.recover(r.id);
  }
  broadcast(): never {
    throw Error("separate_device_validation_required_live_refunds_disabled");
  }
}
