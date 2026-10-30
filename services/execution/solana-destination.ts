import {
  type Action,
  type Prepared,
  prepare,
  validateAction,
} from "../solana/transactions.ts";
import { type Devnet, SolanaError } from "../solana/network.ts";
import { type SolanaJournal } from "../solana/journal.ts";
export type SolanaQuote = {
  family: "solana";
  network: "solana:devnet";
  action: Action;
  orderId: string;
  expires: number;
  paymentZatoshis: string;
  liveExecution: false;
};
export type DestinationState =
  | "AUTHORIZED"
  | "PREPARED"
  | "SIMULATION_FAILED"
  | "AWAITING_EXPLICIT_APPROVAL"
  | "PROCESSED"
  | "CONFIRMED"
  | "FINALIZED"
  | "FAILED"
  | "UNKNOWN"
  | "RECOVERY_REVIEW";
// Synthetic harness only. No historical Store/payment import and no live verifier capability.
export async function exerciseSolanaDestination(
  input: {
    fixture: true;
    paymentId: string;
    verifiedConfirmations: number;
    quote: SolanaQuote;
  },
  net: Devnet,
  journal: SolanaJournal,
  disposable: readonly string[],
): Promise<Prepared> {
  if (
    input.quote.family !== "solana" ||
    input.quote.network !== "solana:devnet" ||
    input.fixture !== true ||
    !input.paymentId.startsWith("synthetic:") ||
    !input.quote.orderId.startsWith("fixture-") ||
    input.quote.liveExecution !== false ||
    input.verifiedConfirmations < 10 ||
    input.quote.expires <= Date.now()
  )
    throw new SolanaError("LIVE_SETTLEMENT_DISABLED");
  validateAction(input.quote.action, disposable);
  // Payment binding survives restart; no fixture payment can authorize two orders.
  journal.db.exec(
    "CREATE TABLE IF NOT EXISTS solana_fixture_payments(payment TEXT PRIMARY KEY,order_id TEXT UNIQUE NOT NULL)",
  );
  const old = journal.db
    .prepare("SELECT order_id FROM solana_fixture_payments WHERE payment=?")
    .get(input.paymentId);
  if (old && old.order_id !== input.quote.orderId)
    throw new SolanaError("PAYMENT_REPLAY");
  journal.db
    .prepare("INSERT OR IGNORE INTO solana_fixture_payments VALUES(?,?)")
    .run(input.paymentId, input.quote.orderId);
  const binding = journal.db
    .prepare("SELECT payment FROM solana_fixture_payments WHERE order_id=?")
    .get(input.quote.orderId);
  if (binding?.payment !== input.paymentId)
    throw new SolanaError("PAYMENT_REPLAY");
  const saved = journal.get(input.quote.orderId);
  if (saved) {
    if (saved.recovery) throw new SolanaError("EXECUTION_RECOVERY_CONFLICT");
    const p = JSON.parse(saved.payload) as Prepared;
    journal.save(input.quote.orderId, { ...p, action: input.quote.action });
    return p;
  }
  const prepared = await prepare(net, input.quote.action, disposable);
  journal.save(input.quote.orderId, prepared);
  return prepared;
}
