// Portable exchange for SIMULATED isolation only. No key material or chain evidence
// is accepted from the backend package. The signer supplies its own reader/vaults.
import { createHash } from "node:crypto";
import { canonical, digest, validateRequest } from "../settlement/protocol.ts";
import type { UnsignedRefundBundle } from "./refund-review.ts";
import { IsolatedNativeRefundSigner, nativeCall } from "./native-refund.ts";
export type PortableRequest = {
  version: 1;
  mode: "simulated-isolation";
  bundle: UnsignedRefundBundle;
  unsignedPcztHex: string;
};
export type PortableTransaction = {
  version: 1;
  network: "zcash-testnet";
  simulatedIsolation: true;
  refundId: string;
  requestDigest: string;
  rawTransactionHex: string;
  txid: string;
  liveEnabled: false;
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export function exportPortableRequest(
  bundle: UnsignedRefundBundle,
  pczt: Buffer,
): Buffer {
  return Buffer.from(
    canonical({
      version: 1,
      mode: "simulated-isolation",
      bundle,
      unsignedPcztHex: pczt.toString("hex"),
    }),
  );
}
export function parsePortableRequest(bytes: Buffer): PortableRequest {
  if (bytes.length > 589824) throw Error("portable_size_limit");
  const p = JSON.parse(bytes.toString("utf8")) as PortableRequest;
  if (
    Object.keys(p).sort().join(",") !== "bundle,mode,unsignedPcztHex,version" ||
    p.version !== 1 ||
    p.mode !== "simulated-isolation" ||
    typeof p.unsignedPcztHex !== "string" ||
    !/^([a-f0-9]{2})+$/.test(p.unsignedPcztHex) ||
    p.unsignedPcztHex.length > 524288 ||
    Object.keys(p.bundle).sort().join(",") !==
      "operatorApproval,request,userSignature"
  )
    throw Error("invalid_portable_package");
  validateRequest(p.bundle.request, Math.floor(Date.now() / 1000));
  return p;
}
export class PortableRefundSession {
  constructor(readonly signer: IsolatedNativeRefundSigner) {
    signer.reviewer.db.exec(
      "CREATE TABLE IF NOT EXISTS portable_refund_finalization(id TEXT PRIMARY KEY,binding TEXT NOT NULL,state TEXT NOT NULL,result TEXT,result_hash TEXT)",
    );
  }
  async review(bytes: Buffer) {
    const p = parsePortableRequest(bytes),
      pczt = Buffer.from(p.unsignedPcztHex, "hex");
    const { review } = await this.signer.review(p.bundle, pczt),
      r = p.bundle.request;
    const display = {
      mode: p.mode,
      network: r.network,
      orderId: r.orderId,
      refundId: r.id,
      destination: r.destination,
      refundZatoshis: r.refundZatoshis,
      feeZatoshis: review.feeZatoshis,
      feeCeilingZatoshis: r.feeCeilingZatoshis,
      expiryHeight: review.expiryHeight,
      requestDigest: digest(r),
      packageHash: sha(bytes),
      nativeReviewDigest: review.reviewDigest,
      liveEnabled: false,
    };
    return { ...display, approvalDigest: digest(display) };
  }
  recover(id: string): PortableTransaction {
    const row = this.signer.reviewer.db
      .prepare(
        "SELECT state,result,result_hash FROM portable_refund_finalization WHERE id=?",
      )
      .get(id) as
      | { state: string; result: string | null; result_hash: string | null }
      | undefined;
    if (
      !row ||
      row.state !== "EXPORTED" ||
      !row.result ||
      sha(Buffer.from(row.result)) !== row.result_hash
    )
      throw Error("portable_finalization_uncertain");
    return JSON.parse(row.result);
  }
  async signAndExport(
    bytes: Buffer,
    explicitApprovalDigest: string,
  ): Promise<PortableTransaction> {
    if (this.signer.reader.liveChain === true)
      throw Error("separate_device_validation_required_live_refunds_disabled");
    bytes = Buffer.from(bytes);
    const display = await this.review(bytes);
    if (display.approvalDigest !== explicitApprovalDigest)
      throw Error("manual_portable_review_required");
    const p = parsePortableRequest(bytes),
      r = p.bundle.request,
      pczt = Buffer.from(p.unsignedPcztHex, "hex"),
      db = this.signer.reviewer.db;
    const old = db
      .prepare("SELECT binding FROM portable_refund_finalization WHERE id=?")
      .get(r.id) as { binding: string } | undefined;
    if (old) {
      if (old.binding !== display.approvalDigest)
        throw Error("portable_replay_conflict");
      return this.recover(r.id);
    }
    const approval = await this.signer.reviewer.approve(p.bundle, digest(r));
    const { policy, review } = await this.signer.review(p.bundle, pczt);
    if (review.reviewDigest !== display.nativeReviewDigest)
      throw Error("portable_review_changed");
    const signed = await this.signer.sign(
      p.bundle,
      pczt,
      approval,
      review.reviewDigest,
    );
    // A durable claim precedes expensive randomized proving. A crash cannot silently
    // generate a different transaction on retry. Saved bytes are the sole recovery output.
    db.prepare(
      "INSERT INTO portable_refund_finalization VALUES(?,?,'FINALIZING',NULL,NULL)",
    ).run(r.id, display.approvalDigest);
    const result = await nativeCall({
      operation: "finalize-isolated",
      pcztHex: signed.signedPczt.toString("hex"),
      originalPcztHex: p.unsignedPcztHex,
      policy,
      reviewedDigest: review.reviewDigest,
    });
    if (
      result.liveEnabled !== false ||
      result.broadcast !== false ||
      !/^[a-f0-9]{64}$/.test(result.txid) ||
      typeof result.rawTransactionHex !== "string" ||
      !/^([a-f0-9]{2})+$/.test(result.rawTransactionHex) ||
      result.rawTransactionHex.length > 524288
    )
      throw Error("invalid_portable_finalization");
    const response: PortableTransaction = {
      version: 1,
      network: "zcash-testnet",
      simulatedIsolation: true,
      refundId: r.id,
      requestDigest: digest(r),
      rawTransactionHex: result.rawTransactionHex,
      txid: result.txid,
      liveEnabled: false,
    };
    const encoded = canonical(response);
    db.prepare(
      "UPDATE portable_refund_finalization SET state='EXPORTED',result=?,result_hash=? WHERE id=? AND state='FINALIZING'",
    ).run(encoded, sha(Buffer.from(encoded)), r.id);
    return this.recover(r.id);
  }
}
