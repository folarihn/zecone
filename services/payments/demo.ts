// Recorded, verified mainnet evidence used by the honest demo mode. The demo
// never pretends a new payment occurred: it replays real on-chain facts from
// the ZecOne mainnet pilot and labels every replayed step
// `evidence: "recorded-mainnet-replay"`. No transaction is built, signed or
// broadcast, and no new financial obligation is created.
import type { PaymentStore } from "./store.ts";
import type { Payment } from "./types.ts";

export interface MainnetEvidence {
  zcashDeposit: {
    txid: string;
    zatoshis: string;
    zec: string;
    block: number;
    note: string; // pool:index
  };
  basePayout: {
    txHash: string;
    wei: string;
    eth: string;
    block: number;
  };
  zcashWithdrawal: {
    txid: string;
    sentZat: string;
    feeZat: string;
    changeZat: string;
    block: number;
  };
}

export const MAINNET_EVIDENCE: MainnetEvidence = {
  zcashDeposit: {
    txid: "8f512d50e1ee36eb222537bdba8b8f762f39256e28259a422913392d86b5f86c",
    zatoshis: "645937",
    zec: "0.00645937",
    block: 3529711,
    note: "ironwood:0",
  },
  basePayout: {
    txHash: "0xc677e9fa956015732c79bfda0991369245bae9394b6f0b9e13425a8e247648a7",
    wei: "3284955372432969",
    eth: "0.003284955372432969",
    block: 53065894,
  },
  zcashWithdrawal: {
    txid: "0316e2140f5a3440c2755e3f92c748a5f215d509d690d52b4858bfcc9a8af02f",
    sentZat: "100000",
    feeZat: "10000",
    changeZat: "535937",
    block: 3531047,
  },
};

export const ZCASH_EXPLORER_TX = (txid: string) => `https://zcashblockexplorer.com/transactions/${txid}`;
export const BASE_EXPLORER_TX = (txHash: string) => `https://basescan.org/tx/${txHash}`;

const REPLAY = { replay: true, evidence: "recorded-mainnet-replay" } as const;

/**
 * Advance a demo payment by exactly one lifecycle step using recorded evidence.
 * Returns the new state, or null if the payment is not an advanceable demo payment.
 * Live payments are refused unconditionally.
 */
export function replayStep(store: PaymentStore, id: string, now = Math.floor(Date.now() / 1000)): string | null {
  const p = store.getPayment(id);
  if (!p || p.mode !== "demo") return null;
  const d = MAINNET_EVIDENCE;
  switch (p.state) {
    case "AWAITING_PAYMENT":
      if (p.expiresAt !== null && p.expiresAt <= now) return null;
      store.markDetected(id, d.zcashDeposit.txid, d.zcashDeposit.zatoshis, now, "recorded-mainnet-replay");
      return "VERIFYING";
    case "PAYMENT_DETECTED":
      return store.transition(id, "VERIFYING", { ...REPLAY }, now) ? "VERIFYING" : null;
    case "VERIFYING":
      return store.transition(
        id,
        "ZEC_CONFIRMED",
        { ...REPLAY, txid: d.zcashDeposit.txid, block: d.zcashDeposit.block, policyMinConfirmations: 20 },
        now,
      )
        ? "ZEC_CONFIRMED"
        : null;
    case "ZEC_CONFIRMED":
      return store.transition(id, "PAYOUT_PENDING", { ...REPLAY }, now) ? "PAYOUT_PENDING" : null;
    case "PAYOUT_PENDING":
      store.setPayout(id, d.basePayout.txHash, d.basePayout.wei, now);
      return store.transition(id, "PAYOUT_SUBMITTED", { ...REPLAY, txHash: d.basePayout.txHash }, now)
        ? "PAYOUT_SUBMITTED"
        : null;
    case "PAYOUT_SUBMITTED":
      return store.transition(id, "PAYOUT_CONFIRMED", { ...REPLAY, block: d.basePayout.block }, now)
        ? "PAYOUT_CONFIRMED"
        : null;
    case "PAYOUT_CONFIRMED":
      return store.transition(id, "COMPLETED", { ...REPLAY }, now) ? "COMPLETED" : null;
    default:
      return null;
  }
}

/** Replay every remaining step at once (operator/CLI convenience). */
export function replayToCompletion(store: PaymentStore, id: string, now = Math.floor(Date.now() / 1000)): Payment | null {
  for (let i = 0; i < 10; i++) {
    const s = replayStep(store, id, now);
    if (s === null) break;
    if (s === "COMPLETED") break;
  }
  return store.getPayment(id);
}

/**
 * Demo observer: stands in for the live watch-only scanner in demo mode. After a
 * demo payment has been awaiting payment for `startAfterSeconds`, it replays one
 * recorded step every `stepSeconds`. It is server-side only — no browser action
 * can trigger it — and it never touches a live payment.
 */
export class DemoObserver {
  constructor(
    private readonly store: PaymentStore,
    private readonly opts: { startAfterSeconds: number; stepSeconds: number },
  ) {}

  tick(now = Math.floor(Date.now() / 1000)): number {
    const rows = this.store.db
      .prepare(
        `SELECT id, state, created_at, updated_at FROM payments WHERE mode='demo'
         AND state IN ('AWAITING_PAYMENT','PAYMENT_DETECTED','VERIFYING','ZEC_CONFIRMED','PAYOUT_PENDING','PAYOUT_SUBMITTED','PAYOUT_CONFIRMED')`,
      )
      .all() as { id: string; state: string; created_at: number; updated_at: number }[];
    let advanced = 0;
    for (const r of rows) {
      const due =
        r.state === "AWAITING_PAYMENT"
          ? now - r.updated_at >= this.opts.startAfterSeconds
          : now - r.updated_at >= this.opts.stepSeconds;
      if (!due) continue;
      try {
        if (replayStep(this.store, r.id, now)) advanced++;
      } catch {
        /* concurrent transition or expiry; next tick re-evaluates */
      }
    }
    return advanced;
  }
}
