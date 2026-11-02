// Append-only renewal of an expired, unsettled mainnet order binding.
//
// A binding has two parts. Its payment fields (order, watch account, checkout
// recipient, amount, exact output, inclusion height, order window, ownership
// digest) are immutable and stay in the original `mainnet_watch_orders` row,
// which is never rewritten. Its `expires` is an operational authorization: when
// it lapses before the payout, the operator may approve one renewal at a time,
// recorded as a new row in `mainnet_watch_binding_renewals` that points at the
// previous binding digest and carries a new bounded expiry.
//
// A renewal is granted only after the exact bound payment is re-verified from a
// fresh authenticated watcher snapshot (never a caller-supplied observation),
// the Zcash spend session is FINALIZED and no Base settlement exists. It only
// re-enables fresh preparation: signing and broadcast keep their own exact
// approvals, and an execution consumes the renewal (single use).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  assertMainnetPaymentAuthorization,
  MainnetWatchJournal,
  mainnetBindingDigest,
  mainnetBindingImmutableDigest,
  type MainnetBoundPayment,
  type MainnetOrderBinding,
  type MainnetWatchSnapshot,
} from "./mainnet-watch.ts";

const HEX64 = /^[a-f0-9]{64}$/;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The checkout settlement binding window (scripts/checkout-settlement.ts). */
export const RENEWAL_MIN_WINDOW_SECONDS = 300;
export const RENEWAL_MAX_WINDOW_SECONDS = 3600;

export type BindingRenewalTerms = {
  version: 1;
  orderId: string;
  originalBindingDigest: string;
  previousBindingDigest: string;
  generation: number;
  immutableDigest: string;
  paymentCommitment: string;
  ownershipDigest: string;
  payment: MainnetBoundPayment;
  windowSeconds: number;
  termsDigest: string;
};

type OrderRow = {
  account: string;
  address: string;
  zatoshis: string;
  expires: number;
  binding_digest: string;
};

function originalRow(
  journal: MainnetWatchJournal,
  original: MainnetOrderBinding,
) {
  const row = journal.db
    .prepare(
      "SELECT account,address,zatoshis,expires,binding_digest FROM mainnet_watch_orders WHERE order_id=?",
    )
    .get(original.orderId) as OrderRow | undefined;
  if (!row) throw Error("RENEWAL_ORIGINAL_BINDING_NOT_FOUND");
  // The supplied original must reproduce the stored digest exactly.
  if (
    row.binding_digest !== mainnetBindingDigest(original) ||
    row.account !== original.account ||
    row.address !== original.address ||
    row.zatoshis !== original.zatoshis ||
    row.expires !== original.expires
  )
    throw Error("RENEWAL_ORIGINAL_BINDING_MISMATCH");
  return row;
}

/**
 * The exact renewal terms the operator approves. Deterministic (no clock): the
 * new expiry is `windowSeconds` from the moment the approved renewal is applied,
 * so an approval given now does not burn the window while waiting.
 */
export function bindingRenewalTerms(
  journal: MainnetWatchJournal,
  original: MainnetOrderBinding,
  paymentCommitment: string,
  windowSeconds: number,
): BindingRenewalTerms {
  if (
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < RENEWAL_MIN_WINDOW_SECONDS ||
    windowSeconds > RENEWAL_MAX_WINDOW_SECONDS
  )
    throw Error("RENEWAL_WINDOW_INVALID");
  if (
    original.payment === undefined ||
    original.sourceEvidenceDigest === undefined ||
    !HEX64.test(paymentCommitment)
  )
    throw Error("RENEWAL_BOUND_PAYMENT_REQUIRED");
  const row = originalRow(journal, original);
  const generation = journal.latestRenewalGeneration(original.orderId);
  const previous =
    generation === 0
      ? row.binding_digest
      : (
          journal.db
            .prepare(
              "SELECT renewed_binding_digest AS d FROM mainnet_watch_binding_renewals WHERE order_id=? AND generation=?",
            )
            .get(original.orderId, generation) as { d: string }
        ).d;
  const body = {
    version: 1 as const,
    orderId: original.orderId,
    originalBindingDigest: row.binding_digest,
    previousBindingDigest: previous,
    generation: generation + 1,
    immutableDigest: mainnetBindingImmutableDigest(original),
    paymentCommitment,
    ownershipDigest: original.sourceEvidenceDigest,
    payment: original.payment,
    windowSeconds,
  };
  return { ...body, termsDigest: digest(body) };
}

export const bindingRenewalApprovalText = (t: BindingRenewalTerms) =>
  `RENEW_MAINNET_ORDER_BINDING ${t.termsDigest}`;

/** Order, Zcash and Base state the renewal depends on (read-only). */
export type BindingRenewalFacts = {
  /** Checkout order state, and whether a payout was ever recorded on it. */
  orderState: string;
  payoutRecorded: boolean;
  /** States of every Zcash spend session for the bound txid. */
  spendSessionStates: string[];
  /** Base submission journal rows for this order or source commitment. */
  baseSubmissions: number;
  /** Payout-session states for this source commitment. */
  pilotSessionStates: string[];
  sourceConsumed: boolean;
};

const PREPARATION_ONLY_STATES = new Set(["ABORTED", "DRY_RUN"]);

export function assertBindingRenewalFacts(f: BindingRenewalFacts) {
  if (f.orderState !== "ZEC_CONFIRMED" || f.payoutRecorded)
    throw Error("RENEWAL_ORDER_NOT_ELIGIBLE");
  if (
    f.spendSessionStates.length !== 1 ||
    f.spendSessionStates[0] !== "FINALIZED"
  )
    throw Error("RENEWAL_ZCASH_SESSION_NOT_FINALIZED");
  // Any prepared-for-signing, signed, broadcast, uncertain or finalized payout
  // blocks renewal; only aborted sessions and unsigned dry runs are allowed.
  if (
    f.baseSubmissions !== 0 ||
    f.sourceConsumed ||
    !f.pilotSessionStates.every((s) => PREPARATION_ONLY_STATES.has(s))
  )
    throw Error("RENEWAL_BASE_SETTLEMENT_EXISTS");
}

/** Read the renewal facts from the operator's existing journals (read-only). */
export function readBindingRenewalFacts(
  paths: {
    payments: string;
    spendJournal: string;
    submissions: string;
    pilotSessions: string;
  },
  ids: {
    paymentId: string;
    txid: string;
    orderId: string;
    paymentCommitment: string;
  },
): BindingRenewalFacts {
  for (const p of Object.values(paths))
    if (!existsSync(p)) throw Error("RENEWAL_JOURNAL_MISSING");
  const ro = (p: string) => new DatabaseSync(p, { readOnly: true });
  let db = ro(paths.payments);
  const order = db
    .prepare("SELECT state, payout_tx_hash FROM payments WHERE id=?")
    .get(ids.paymentId) as
    { state: string; payout_tx_hash: string | null } | undefined;
  db.close();
  if (!order) throw Error("RENEWAL_ORDER_NOT_FOUND");
  db = ro(paths.spendJournal);
  const spend = (
    db
      .prepare("SELECT state FROM spend_sessions_v3 WHERE txid=?")
      .all(ids.txid) as { state: string }[]
  ).map((r) => r.state);
  db.close();
  db = ro(paths.submissions);
  const submissions = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM mainnet_submissions WHERE order_id=? OR source_commitment=?",
      )
      .get(ids.orderId, ids.paymentCommitment) as { n: number }
  ).n;
  db.close();
  db = ro(paths.pilotSessions);
  const sessions = (
    db
      .prepare("SELECT state FROM pilot_sessions WHERE source=?")
      .all(ids.paymentCommitment) as { state: string }[]
  ).map((r) => r.state);
  const consumed = !!db
    .prepare("SELECT 1 FROM pilot_consumed_sources WHERE source=?")
    .get(ids.paymentCommitment);
  db.close();
  return {
    orderState: order.state,
    payoutRecorded: order.payout_tx_hash !== null,
    spendSessionStates: spend,
    baseSubmissions: submissions,
    pilotSessionStates: sessions,
    sourceConsumed: consumed,
  };
}

/**
 * Re-verify the exact bound payment for `binding` from a fresh authenticated
 * snapshot with the full watch rules, in memory, continuing from the persistent
 * checkpoint so a reorganization since then is detected. Writes nothing.
 */
export function reverifyBoundPayment(
  journal: MainnetWatchJournal,
  binding: MainnetOrderBinding,
  paymentCommitment: string,
  snapshot: MainnetWatchSnapshot,
) {
  const now = journal.now();
  const p = binding.payment;
  if (!p) throw Error("RENEWAL_BOUND_PAYMENT_REQUIRED");
  const scratch = new MainnetWatchJournal(":memory:", () => now);
  let observation;
  try {
    const cp = journal.db
      .prepare("SELECT * FROM mainnet_watch_checkpoint WHERE id=1")
      .get() as Record<string, string | number> | undefined;
    if (cp)
      scratch.db
        .prepare(
          "INSERT INTO mainnet_watch_checkpoint(id,tip,block_hash,anchor,anchor_height,source,peer_source,observed_at) VALUES(1,?,?,?,?,?,?,?)",
        )
        .run(
          cp.tip,
          cp.block_hash,
          cp.anchor,
          cp.anchor_height,
          cp.source,
          cp.peer_source,
          cp.observed_at,
        );
    observation = scratch.observe(binding, snapshot);
    if (
      observation.status !== "confirmed" ||
      observation.reorgDetected ||
      observation.paymentDigest !== paymentCommitment
    )
      throw Error("RENEWAL_PAYMENT_NOT_REVERIFIED");
    assertMainnetPaymentAuthorization(
      observation,
      {
        orderId: binding.orderId,
        paymentDigest: paymentCommitment,
        zatoshis: binding.zatoshis,
      },
      now,
    );
  } catch (e) {
    throw e instanceof Error && e.message.startsWith("RENEWAL_")
      ? e
      : Error("RENEWAL_PAYMENT_NOT_REVERIFIED");
  } finally {
    scratch.close();
  }
  // The persistent record of this output must still belong to this order only,
  // confirmed in the same block the fresh snapshot shows.
  const note = snapshot.payments.find(
    (n) => n.txid === p.txid && n.pool === p.pool && n.index === p.index,
  );
  const row = journal.db
    .prepare(
      "SELECT order_id,block_hash,status,active FROM mainnet_watch_payments WHERE payment_key=?",
    )
    .get(`${p.txid}:${p.pool}:${p.index}`) as
    | { order_id: string; block_hash: string; status: string; active: number }
    | undefined;
  if (
    !note ||
    !row ||
    row.order_id !== binding.orderId ||
    row.status !== "confirmed" ||
    row.active !== 1 ||
    row.block_hash !== note.blockHash
  )
    throw Error("RENEWAL_PAYMENT_EVIDENCE_MISMATCH");
  return {
    tip: observation.tip,
    blockHash: observation.blockHash,
    confirmations: observation.confirmations,
    paymentDigest: observation.paymentDigest!,
    observedAt: observation.observedAt,
  };
}

export type BindingRenewal = {
  renewalId: string;
  generation: number;
  expires: number;
  renewedBinding: MainnetOrderBinding;
  renewedBindingDigest: string;
  termsDigest: string;
  evidence: {
    tip: number;
    blockHash: string;
    confirmations: number;
    paymentDigest: string;
    observedAt: number;
  };
};

/**
 * Re-verify the exact bound payment from `snapshot` (fresh, authenticated
 * watcher output) and append one renewal. Throws without writing anything
 * unless every condition holds.
 */
export function renewMainnetOrderBinding(
  journal: MainnetWatchJournal,
  input: {
    original: MainnetOrderBinding;
    paymentCommitment: string;
    windowSeconds: number;
    approval: string;
    snapshot: MainnetWatchSnapshot;
    facts: BindingRenewalFacts;
  },
): BindingRenewal {
  const now = journal.now();
  const { original, paymentCommitment } = input;
  const terms = bindingRenewalTerms(
    journal,
    original,
    paymentCommitment,
    input.windowSeconds,
  );
  if (input.approval !== bindingRenewalApprovalText(terms))
    throw Error("RENEWAL_EXACT_APPROVAL_REQUIRED");
  if (original.expires > now) throw Error("RENEWAL_ORIGINAL_NOT_EXPIRED");
  if (
    journal.db
      .prepare(
        "SELECT 1 FROM mainnet_watch_binding_renewals WHERE order_id=? AND expires>?",
      )
      .get(original.orderId, now)
  )
    throw Error("RENEWAL_ACTIVE_RENEWAL_EXISTS");
  assertBindingRenewalFacts(input.facts);

  const expires = now + input.windowSeconds;
  const renewed: MainnetOrderBinding = { ...original, expires };
  const evidence = reverifyBoundPayment(
    journal,
    renewed,
    paymentCommitment,
    input.snapshot,
  );
  const renewedDigest = mainnetBindingDigest(renewed);
  const renewalId = digest({
    termsDigest: terms.termsDigest,
    expires,
    renewedBindingDigest: renewedDigest,
  });
  journal.atomic(() => {
    // Re-checked inside the write transaction: concurrent renewals race on
    // UNIQUE(order_id, generation) and at most one is recorded.
    if (
      journal.latestRenewalGeneration(original.orderId) !==
      terms.generation - 1
    )
      throw Error("RENEWAL_CONCURRENT_RENEWAL");
    if (
      journal.db
        .prepare(
          "SELECT 1 FROM mainnet_watch_binding_renewals WHERE order_id=? AND expires>?",
        )
        .get(original.orderId, now)
    )
      throw Error("RENEWAL_ACTIVE_RENEWAL_EXISTS");
    journal.db
      .prepare(
        "INSERT INTO mainnet_watch_binding_renewals(renewal_id,order_id,generation,original_binding_digest,previous_binding_digest,immutable_digest,renewed_binding_digest,payment_commitment,terms_digest,approval_digest,expires,evidence_json,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        renewalId,
        original.orderId,
        terms.generation,
        terms.originalBindingDigest,
        terms.previousBindingDigest,
        terms.immutableDigest,
        renewedDigest,
        paymentCommitment,
        terms.termsDigest,
        digest(input.approval),
        expires,
        JSON.stringify({ ...evidence, facts: input.facts }),
        now,
      );
  });
  return {
    renewalId,
    generation: terms.generation,
    expires,
    renewedBinding: renewed,
    renewedBindingDigest: renewedDigest,
    termsDigest: terms.termsDigest,
    evidence,
  };
}
