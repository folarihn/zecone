import { blockhash } from "@solana/kit";
import { SolanaError } from "./network.ts";
import type { SolanaSettlement } from "./settlement.ts";
import type { SwapPrepared } from "./cpmm.ts";
import { quoteDeadline } from "./swap-approval.ts";

// Manual unsigned review refresh only. Signed or uncertain transactions are never replaced.
export async function retireExpiredUnsignedSwap(
  service: SolanaSettlement,
  id: string,
  explicit: boolean,
) {
  if (!explicit) throw new SolanaError("MANUAL_UNSIGNED_REVIEW_REQUIRED");
  const i = service.eligible(id, true),
    row = service.row(id);
  if (
    !i.swap ||
    row.claimed ||
    row.signature ||
    row.wire ||
    row.state !== "AWAITING_SOLANA_AUTHORIZATION" ||
    !row.prepared
  )
    throw new SolanaError("SIGNED_OR_UNCERTAIN_REPLACEMENT_FORBIDDEN");
  const p = JSON.parse(row.prepared) as SwapPrepared;
  if (
    quoteDeadline(p) > service.now() &&
    (await service.network.valid(blockhash(p.lifetime.blockhash)))
  )
    throw new SolanaError("ORIGINAL_REVIEW_NOT_EXPIRED");
  service.store.atomic(() => {
    service.eligible(id, true);
    const current = service.row(id);
    if (
      current.claimed ||
      current.signature ||
      current.wire ||
      current.prepared !== row.prepared ||
      current.state !== row.state
    )
      throw new SolanaError("REPLACEMENT_RACE_VETO");
    service.store.db.exec(
      "CREATE TABLE IF NOT EXISTS solana_unsigned_review_archive(order_id TEXT NOT NULL,digest TEXT NOT NULL,prepared TEXT NOT NULL,retired_at INTEGER NOT NULL,PRIMARY KEY(order_id,digest))",
    );
    service.store.db
      .prepare("INSERT INTO solana_unsigned_review_archive VALUES(?,?,?,?)")
      .run(id, p.digest, row.prepared, service.now());
    service.store.db
      .prepare(
        "UPDATE solana_settlement SET prepared=NULL WHERE order_id=? AND claimed=0 AND signature IS NULL AND wire IS NULL",
      )
      .run(id);
    service.store.event(
      id,
      "manual_expired_unsigned_review_retired",
      {
        digest: p.digest,
        newApprovalRequired: true,
        signingClaim: false,
        oldApprovalRecordsPreserved: true,
      },
      service.now(),
    );
  });
}
