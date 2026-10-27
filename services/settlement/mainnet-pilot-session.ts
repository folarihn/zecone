// A single-use, interactive coordinator. Keys, RPCs and the existing executor
// remain in adapters; neither approval can authorize a later quote or session.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { keccak256, type Hex } from "viem";
import {
  assertPreparedMainnetTransfer,
  preparedDigest,
  termsDigest,
  type MainnetPrepared,
  type MainnetTransferTerms,
  type MainnetSignedBundle,
  type VerifiedMainnetBundle,
} from "./mainnet-transfer.ts";
import type { MainnetSigningApproval } from "./mainnet-signer.ts";

export type PilotPlan = {
  terms: MainnetTransferTerms;
  prepared: MainnetPrepared;
};
export type PilotReview = {
  action: "SIGN" | "BROADCAST";
  sessionId: string;
  chainId: 8453;
  recipient: string;
  amount: string;
  maximumDestinationDebit: string;
  feeCap: string;
  sourceCommitment: string;
  expires: number;
  termsDigest: string;
  preparedDigest: string;
  transactionId: string | null;
  signedDigest: string | null;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function pilotApprovalText(review: PilotReview) {
  return `${review.action} ${review.sessionId} ${hash(review)}`;
}

export class PilotSessionJournal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path === ":memory:") throw Error("DURABLE_PILOT_SESSION_REQUIRED");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pilot_sessions(id TEXT PRIMARY KEY, source TEXT NOT NULL,
        state TEXT NOT NULL, terms_digest TEXT, prepared_digest TEXT, transaction_id TEXT,
        expires INTEGER, detail TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS pilot_active_source ON pilot_sessions(source)
        WHERE state IN ('RUNNING','SIGNING','SIGNED','SUBMITTING','UNCERTAIN_SIGNING','UNCERTAIN');
      CREATE TABLE IF NOT EXISTS pilot_consumed_sources(source TEXT PRIMARY KEY, session_id TEXT NOT NULL);`);
  }
  begin(id: string, source: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db
          .prepare("SELECT 1 FROM pilot_consumed_sources WHERE source=?")
          .get(source)
      )
        throw Error("PILOT_SOURCE_ALREADY_CONSUMED");
      this.db
        .prepare(
          "INSERT INTO pilot_sessions(id,source,state) VALUES(?,?,'RUNNING')",
        )
        .run(id, source);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  record(
    id: string,
    state: string,
    plan?: PilotPlan,
    transactionId?: string,
    detail?: string,
  ) {
    this.db
      .prepare(
        `UPDATE pilot_sessions SET state=?,terms_digest=COALESCE(?,terms_digest),
      prepared_digest=COALESCE(?,prepared_digest),transaction_id=COALESCE(?,transaction_id),
      expires=COALESCE(?,expires),detail=? WHERE id=?`,
      )
      .run(
        state,
        plan ? termsDigest(plan.terms) : null,
        plan ? preparedDigest(plan.prepared) : null,
        transactionId ?? null,
        plan?.terms.expires ?? null,
        detail ?? null,
        id,
      );
  }
  claim(id: string, source: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.db
        .prepare("SELECT state FROM pilot_sessions WHERE id=? AND source=?")
        .get(id, source) as { state: string } | undefined;
      if (state?.state !== "SIGNED") throw Error("PILOT_SESSION_NOT_SIGNED");
      this.db
        .prepare(
          "INSERT INTO pilot_consumed_sources(source,session_id) VALUES(?,?)",
        )
        .run(source, id);
      this.record(id, "SUBMITTING");
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  priorTransactions(source: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT transaction_id FROM pilot_sessions WHERE source=? AND transaction_id IS NOT NULL",
        )
        .all(source) as { transaction_id: string }[]
    ).map((r) => r.transaction_id);
  }
  close() {
    this.db.close();
  }
}

export type PilotSessionAdapters = {
  preflight(priorTransactions: string[]): Promise<void>;
  prepare(): Promise<PilotPlan>;
  validate(plan: PilotPlan): Promise<void>;
  approve(review: PilotReview, exactText: string): Promise<string>;
  sign(
    plan: PilotPlan,
    approval: MainnetSigningApproval,
  ): Promise<MainnetSignedBundle>;
  verify(
    plan: PilotPlan,
    signed: MainnetSignedBundle,
  ): Promise<VerifiedMainnetBundle>;
  submit(
    plan: PilotPlan,
    signed: MainnetSignedBundle,
    verified: VerifiedMainnetBundle,
  ): Promise<unknown>;
};

export async function runPilotSession(
  journal: PilotSessionJournal,
  source: string,
  adapters: PilotSessionAdapters,
  now = () => Math.floor(Date.now() / 1000),
  id = randomBytes(16).toString("hex"),
  options: { dryRun?: boolean } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(source))
    throw Error("PILOT_SOURCE_COMMITMENT_REQUIRED");
  journal.begin(id, source);
  let plan: PilotPlan | undefined,
    signed: MainnetSignedBundle | undefined,
    verified: VerifiedMainnetBundle | undefined,
    signedId: string | undefined,
    signingStarted = false,
    submitting = false;
  const check = () => {
    if (!plan || plan.terms.expires <= now())
      throw Error("PILOT_QUOTE_EXPIRED_REPREPARE_AND_REAPPROVE");
    if (
      plan.terms.network !== "base" ||
      plan.terms.sourcePaymentCommitment !== source ||
      plan.prepared.kind !== "base-unsigned"
    )
      throw Error("PILOT_EXACT_SOURCE_AND_BASE_REQUIRED");
    assertPreparedMainnetTransfer(plan.terms, plan.prepared);
  };
  const review = (action: PilotReview["action"]): PilotReview => ({
    action,
    sessionId: id,
    chainId: 8453,
    recipient: plan!.terms.recipient,
    amount: plan!.terms.amount,
    maximumDestinationDebit: plan!.terms.maximumDestinationDebit,
    feeCap: plan!.terms.feeCap,
    sourceCommitment: source,
    expires: plan!.terms.expires,
    termsDigest: termsDigest(plan!.terms),
    preparedDigest: preparedDigest(plan!.prepared),
    transactionId: verified?.transactionId ?? null,
    signedDigest: verified?.signedDigest ?? null,
  });
  const confirm = async (action: PilotReview["action"]) => {
    check();
    const body = review(action),
      expected = pilotApprovalText(body);
    if ((await adapters.approve(body, expected)) !== expected)
      throw Error("PILOT_EXACT_APPROVAL_REQUIRED");
    check();
    // Detect mutation of any approved term or prepared byte while prompting.
    if (hash(body) !== hash(review(action)))
      throw Error("PILOT_APPROVED_STATE_CHANGED");
    await adapters.validate(plan!);
    check();
    if (hash(body) !== hash(review(action)))
      throw Error("PILOT_APPROVED_STATE_CHANGED");
  };
  try {
    await adapters.preflight(journal.priorTransactions(source));
    plan = await adapters.prepare();
    check();
    await adapters.validate(plan);
    check();
    if (options.dryRun) {
      // Exercise live proof, pricing, preparation, simulation and policy gates.
      // Deliberately stop before requesting either real approval or accessing
      // the payout signer. No pretend signature/hash/authorization is created.
      const signingReview = review("SIGN");
      journal.record(id, "DRY_RUN", plan);
      return {
        state: "dry-run-passed",
        sessionId: id,
        signingReview,
        signingApprovalRequired: pilotApprovalText(signingReview),
        broadcastApprovalRequired:
          "SEPARATE_EXACT_REVIEW_AFTER_VERIFIED_SIGNATURE",
        signing: false,
        broadcast: false,
        authorizationGranted: false,
        secondsRemaining: plan.terms.expires - now(),
      };
    }
    await confirm("SIGN");
    journal.record(id, "SIGNING", plan);
    signingStarted = true;
    signed = await adapters.sign(plan, {
      version: 1,
      termsDigest: termsDigest(plan.terms),
      preparedDigest: preparedDigest(plan.prepared),
      maximumDestinationDebit: plan.terms.maximumDestinationDebit,
      expires: plan.terms.expires,
    });
    signedId = keccak256(signed.signed as Hex);
    journal.record(id, "SIGNED", plan, signedId);
    // A signature made during expiry is retained; it never grants broadcast approval.
    check();
    verified = await adapters.verify(plan, signed);
    check();
    if (
      verified.termsDigest !== termsDigest(plan.terms) ||
      verified.preparedDigest !== preparedDigest(plan.prepared)
    )
      throw Error("PILOT_SIGNED_BINDING_MISMATCH");
    journal.record(id, "SIGNED", plan, verified.transactionId);
    await confirm("BROADCAST");
    await adapters.preflight(journal.priorTransactions(source));
    check();
    journal.claim(id, source);
    submitting = true;
    // Existing executor repeats expiry, native provenance, signed authorization,
    // nonce/liquidity, lease, prior-submission and durable one-shot claim checks.
    const result = await adapters.submit(plan, signed, verified);
    journal.record(id, "BROADCAST", plan, verified.transactionId);
    return result;
  } catch (e) {
    journal.record(
      id,
      submitting
        ? "UNCERTAIN"
        : signed
          ? "ABORTED_SIGNED"
          : signingStarted
            ? "UNCERTAIN_SIGNING"
            : "ABORTED",
      plan,
      verified?.transactionId ?? signedId,
      e instanceof Error ? e.message : "PILOT_FAILED",
    );
    throw e;
  }
}
