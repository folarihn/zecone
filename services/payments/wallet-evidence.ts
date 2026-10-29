// Pre-deadline wallet evidence for the restricted single-device pilot.
//
// Authenticated chain evidence proves WHERE a payment was mined (height), not
// WHEN it was signed or broadcast: miners set block timestamps, and a
// transaction broadcast after the 300 s payment deadline can still be mined at
// or below the order's inclusion height. For the pilot the customer is the
// operator's integrated ZecOne spend wallet, whose protected local journal
// records the exact transaction it signed. A real deposit qualifies for
// settlement only if that journal proves, for the exact txid the watcher later
// authenticated, that the session was bound to this order's deadline and
// height, and that SIGN, signing and the broadcast attempt all happened before
// the payment deadline. A deposit discovered by height alone, or from any other
// wallet, never inherits the quote: it goes to manual review.
import { DatabaseSync } from "node:sqlite";

const HEX64 = /^[0-9a-f]{64}$/;

export interface WalletEvidence {
  version: 1;
  sessionId: string;
  /** Transaction id the wallet derived from the exact signed bytes. */
  txid: string;
  /** SHA-256 of the exact signed bytes (the bytes themselves never leave the journal). */
  signedDigest: string;
  destination: string;
  zatoshis: string;
  /** Zcash expiry height of the signed transaction. */
  expiryHeight: number;
  /** Approval session expiry; --approval-deadline caps it at the payment deadline. */
  approvalExpires: number;
  signApprovedAt: number;
  signedAt: number;
  broadcastApprovedAt: number;
  /** When the wallet began its single broadcast attempt (SUBMITTING). */
  broadcastAttemptAt: number;
}

/** The order fields the rule needs (works for public and mirror payments). */
export interface EvidenceOrder {
  createdAt: number;
  zcashAddress: string | null;
  quote: { zecAmountZat: string } | null;
  detectedTxid: string | null;
  paymentDeadline: number | null;
  paymentExpiryHeight: number | null;
  chainEvidence?: { txid: string; height: number } | null;
}

const int = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Returns null when `ev` proves this order's payment was signed and broadcast
 * by the integrated wallet before its payment deadline, otherwise a reason code.
 */
export function assessWalletEvidence(
  o: EvidenceOrder,
  ev: WalletEvidence | null | undefined,
): string | null {
  if (!ev) return "no_wallet_journal_evidence";
  if (
    o.paymentDeadline === null ||
    o.paymentExpiryHeight === null ||
    !o.quote ||
    !o.zcashAddress
  )
    return "order_has_no_payment_window";
  if (
    ev.version !== 1 ||
    typeof ev.sessionId !== "string" ||
    !/^[0-9a-f]{32}$/.test(ev.sessionId) ||
    !HEX64.test(String(ev.txid)) ||
    !HEX64.test(String(ev.signedDigest)) ||
    ![
      ev.expiryHeight,
      ev.approvalExpires,
      ev.signApprovedAt,
      ev.signedAt,
      ev.broadcastApprovedAt,
      ev.broadcastAttemptAt,
    ].every(int)
  )
    return "wallet_evidence_malformed";
  if (o.detectedTxid === null || ev.txid !== o.detectedTxid)
    return "wallet_txid_mismatch";
  if (
    o.chainEvidence &&
    (o.chainEvidence.txid !== ev.txid ||
      o.chainEvidence.height > ev.expiryHeight)
  )
    return "chain_evidence_mismatch";
  if (ev.destination !== o.zcashAddress || ev.zatoshis !== o.quote.zecAmountZat)
    return "wallet_terms_mismatch";
  if (ev.expiryHeight > o.paymentExpiryHeight)
    return "wallet_expiry_above_inclusion_height";
  if (ev.approvalExpires > o.paymentDeadline)
    return "wallet_session_not_bound_to_deadline";
  if (ev.signApprovedAt < o.createdAt) return "wallet_session_predates_order";
  if (!(
    ev.signApprovedAt <= ev.signedAt &&
    ev.signedAt <= ev.broadcastApprovedAt &&
    ev.broadcastApprovedAt <= ev.broadcastAttemptAt
  ))
    return "wallet_journal_out_of_order";
  // Strictly before the deadline: a T0+300 s (or later) attempt never qualifies.
  if (ev.broadcastAttemptAt >= o.paymentDeadline)
    return "signed_or_broadcast_after_deadline";
  return null;
}

/**
 * Read the integrated wallet's evidence for `txid` from its protected v3 spend
 * journal (read-only). Never reads the encrypted signed bytes. Null if the
 * journal has no session that signed exactly this transaction.
 */
export function readWalletJournalEvidence(
  journalPath: string,
  txid: string,
): WalletEvidence | null {
  if (!HEX64.test(txid)) return null;
  const db = new DatabaseSync(journalPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT session_id, intent_json, txid, signed_digest FROM spend_sessions_v3 WHERE txid=?`,
      )
      .all(txid) as {
      session_id: string;
      intent_json: string;
      txid: string;
      signed_digest: string | null;
    }[];
    if (rows.length !== 1 || !rows[0].signed_digest) return null;
    const row = rows[0];
    const intent = JSON.parse(row.intent_json) as {
      destination?: unknown;
      zatoshis?: unknown;
      expiry_height?: unknown;
      expires?: unknown;
    };
    const firstAt = (state: string) =>
      (
        db
          .prepare(
            `SELECT MIN(created_at) AS at FROM session_events_v3 WHERE session_id=? AND next_state=?`,
          )
          .get(row.session_id, state) as { at: number | null } | undefined
      )?.at ?? null;
    const ev = {
      version: 1 as const,
      sessionId: row.session_id,
      txid: row.txid,
      signedDigest: row.signed_digest,
      destination: String(intent.destination ?? ""),
      zatoshis:
        typeof intent.zatoshis === "number" ||
        typeof intent.zatoshis === "string"
          ? String(intent.zatoshis)
          : "",
      expiryHeight: Number(intent.expiry_height),
      approvalExpires: Number(intent.expires),
      signApprovedAt: firstAt("SIGN_APPROVED"),
      signedAt: firstAt("SIGNED"),
      broadcastApprovedAt: firstAt("BROADCAST_APPROVED"),
      broadcastAttemptAt: firstAt("SUBMITTING"),
    };
    if (
      [
        ev.signApprovedAt,
        ev.signedAt,
        ev.broadcastApprovedAt,
        ev.broadcastAttemptAt,
      ].some((v) => v === null)
    )
      return null;
    return ev as WalletEvidence;
  } finally {
    db.close();
  }
}
