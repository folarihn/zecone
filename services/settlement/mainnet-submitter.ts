// Durable mainnet submission bookkeeping. There is deliberately no network
// sender here: an operator can claim an already signed bundle exactly once, and
// finalization requires an independently fetched finalized receipt.
import { getBase58Encoder } from "@solana/kit";
import { encodeFunctionData, parseAbi } from "viem";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BASE_MAINNET_CHAIN_ID,
  SOLANA_MAINNET_GENESIS,
} from "./mainnet-address.ts";
import { readProductionRpc } from "./mainnet-probe.ts";
import {
  independentProviders,
  type ProductionProfile,
} from "./production-safety.ts";
import type {
  MainnetTransferTerms,
  VerifiedMainnetBundle,
} from "./mainnet-transfer.ts";

export type MainnetSubmitLimits = {
  perTransaction: string;
  daily: string;
  confirmations: number;
};

export type MainnetSubmissionState =
  "prepared" | "claimed" | "broadcast" | "finalized" | "failed" | "uncertain";

export type MainnetClaim = {
  orderId: string;
  network: "base" | "solana";
  transactionId: string;
  signed: string;
  attempt: number;
};

export type BaseFinalizedReceipt = {
  chainId: number;
  transactionHash: string;
  status: "success";
  blockNumber: bigint | number | string;
  confirmations: number;
  to: string;
  value: bigint | string;
};

export type SolanaFinalizedReceipt = {
  genesis: string;
  signature: string;
  slot: number;
  confirmationStatus: "finalized";
  err: null;
};

const HEX64 = /^[a-f0-9]{64}$/;
const BASE_TX = /^0x[a-f0-9]{64}$/;
const operatorAbi = parseAbi([
  "function operatorFeeScalar() view returns (uint32)",
  "function operatorFeeConstant() view returns (uint64)",
]);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const integer = (value: unknown) =>
  typeof value === "string" && /^[1-9][0-9]{0,30}$/.test(value)
    ? BigInt(value)
    : null;
const rpcInteger = (value: unknown) => {
  if (
    typeof value !== "number" &&
    !(typeof value === "string" && /^0x[0-9a-f]+$/i.test(value))
  )
    throw Error("INVALID_RPC_INTEGER");
  const n =
    typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)
      ? Number(BigInt(value))
      : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw Error("INVALID_RPC_INTEGER");
  return n;
};

const rpcAmount = (value: unknown) => {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value))
    throw Error("INVALID_RPC_AMOUNT");
  return BigInt(value);
};

// Only receipts produced by these canonical read paths can change financial state.
const acceptedReceipts = new WeakMap<object, string>();
const canonicalId = (network: string, id: string) =>
  network === "base" ? id.toLowerCase() : id;
export async function readBaseFinalizedReceipt(
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  transactionId: string,
  fetcher: typeof fetch = fetch,
): Promise<BaseFinalizedReceipt> {
  if (
    profile.network !== "base" ||
    terms.network !== "base" ||
    !BASE_TX.test(transactionId.toLowerCase())
  )
    throw Error("INVALID_BASE_RECEIPT_REQUEST");
  independentProviders(profile);
  const rows = await Promise.all(
    profile.providers.map(async (p) => {
      const rpc = (m: string, args: unknown[] = []) =>
        readProductionRpc(p, m, args, fetcher);
      if ((await rpc("eth_chainId")) !== "0x2105") throw Error("WRONG_NETWORK");
      const [r, t, head] = await Promise.all([
        rpc("eth_getTransactionReceipt", [transactionId]),
        rpc("eth_getTransactionByHash", [transactionId]),
        rpc("eth_getBlockByNumber", ["finalized", false]),
      ]);
      if (!r || !t) throw Error("MAINNET_RECEIPT_NOT_FOUND");
      if (
        !head ||
        r.status !== "0x1" ||
        String(t.hash).toLowerCase() !== transactionId.toLowerCase() ||
        String(r.transactionHash).toLowerCase() !==
          transactionId.toLowerCase() ||
        t.to?.toLowerCase() !== terms.recipient.toLowerCase() ||
        r.to?.toLowerCase() !== terms.recipient.toLowerCase() ||
        t.from?.toLowerCase() !== terms.relayer.toLowerCase() ||
        r.from?.toLowerCase() !== terms.relayer.toLowerCase() ||
        rpcAmount(t.value) !== BigInt(terms.amount) ||
        !["0x", ""].includes(t.input) ||
        rpcAmount(t.chainId) !== 8453n ||
        t.type !== "0x0" ||
        t.blockHash !== r.blockHash ||
        t.blockNumber !== r.blockNumber
      )
        throw Error("MAINNET_FINALITY_NOT_PROVEN");
      const number = rpcInteger(r.blockNumber),
        tip = rpcInteger(head.number),
        block = await rpc("eth_getBlockByNumber", [r.blockNumber, false]);
      if (
        number < 1 ||
        tip < number ||
        typeof r.blockHash !== "string" ||
        !BASE_TX.test(r.blockHash.toLowerCase()) ||
        block?.hash !== r.blockHash ||
        Math.floor(Date.now() / 1000) - rpcInteger(head.timestamp) > 1800
      )
        throw Error("MAINNET_FINALITY_NOT_PROVEN");
      // Missing L1 fee evidence is a veto, never silently charged as zero.
      if (
        r.l1Fee === undefined ||
        r.gasUsed === undefined ||
        r.effectiveGasPrice === undefined
      )
        throw Error("MAINNET_FEE_EVIDENCE_REQUIRED");
      const operatorParams = await Promise.all(
        (["operatorFeeScalar", "operatorFeeConstant"] as const).map((name) =>
          rpc("eth_call", [
            {
              to: "0x4200000000000000000000000000000000000015",
              data: encodeFunctionData({
                abi: operatorAbi,
                functionName: name,
              }),
            },
            r.blockNumber,
          ]),
        ),
      );
      if (
        operatorParams.some(
          (v) => typeof v !== "string" || !/^0x[0-9a-f]{64}$/i.test(v),
        )
      )
        throw Error("MAINNET_FEE_EVIDENCE_REQUIRED");
      const [operatorScalar, operatorConstant] = operatorParams.map(rpcAmount);
      // Isthmus and Jovian use different nonzero-scalar formulas. Until the
      // exact Base fork is pinned, do not guess which formula applies.
      if (operatorScalar !== 0n)
        throw Error("MAINNET_OPERATOR_FEE_RULE_NOT_VERIFIED");
      const fee =
        rpcAmount(r.gasUsed) * rpcAmount(r.effectiveGasPrice) +
        rpcAmount(r.l1Fee) +
        operatorConstant;
      if (
        fee > BigInt(terms.feeCap) ||
        rpcAmount(r.l1Fee) > BigInt(terms.l1DataFeeBound) ||
        BigInt(terms.amount) + fee > BigInt(terms.maximumDestinationDebit)
      )
        throw Error("MAINNET_FEE_CAP");
      // Until all active Base fee components are identified, execution stays disabled.
      return {
        chainId: 8453,
        transactionHash: transactionId.toLowerCase(),
        status: "success" as const,
        blockNumber: number,
        confirmations: tip - number + 1,
        to: terms.recipient,
        value: terms.amount,
        blockHash: r.blockHash,
        fee: fee.toString(),
      };
    }),
  );
  if (
    rows.some(
      (r) =>
        r.blockHash !== rows[0].blockHash ||
        r.blockNumber !== rows[0].blockNumber ||
        r.fee !== rows[0].fee,
    )
  )
    throw Error("MAINNET_RECEIPT_DISAGREEMENT");
  const result = {
    ...rows[0],
    confirmations: Math.min(...rows.map((r) => r.confirmations)),
  };
  Object.freeze(result);
  acceptedReceipts.set(result, digest(terms));
  return result;
}
export async function readSolanaFinalizedReceipt(
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  transactionId: string,
  fetcher: typeof fetch = fetch,
): Promise<SolanaFinalizedReceipt> {
  if (
    profile.network !== "solana" ||
    terms.network !== "solana" ||
    !transactionId.trim()
  )
    throw Error("INVALID_SOLANA_RECEIPT_REQUEST");
  independentProviders(profile);
  const rows = await Promise.all(
    profile.providers.map(async (p) => {
      const rpc = (m: string, args: unknown[] = []) =>
        readProductionRpc(p, m, args, fetcher);
      if ((await rpc("getGenesisHash")) !== SOLANA_MAINNET_GENESIS)
        throw Error("WRONG_NETWORK");
      const tx = await rpc("getTransaction", [
        transactionId,
        {
          commitment: "finalized",
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        },
      ]);
      if (!tx) throw Error("MAINNET_RECEIPT_NOT_FOUND");
      const message = tx.transaction?.message,
        meta = tx.meta,
        keys = message?.accountKeys;
      if (
        tx.version !== "legacy" ||
        !meta ||
        meta.err !== null ||
        tx.transaction.signatures?.length !== 1 ||
        tx.transaction.signatures[0] !== transactionId ||
        keys?.length !== 3 ||
        keys[0] !== terms.relayer ||
        keys[1] !== terms.recipient ||
        keys[2] !== "11111111111111111111111111111111" ||
        message.instructions?.length !== 1 ||
        meta.preBalances?.length !== 3 ||
        meta.postBalances?.length !== 3 ||
        message.header?.numRequiredSignatures !== 1 ||
        message.header?.numReadonlySignedAccounts !== 0 ||
        message.header?.numReadonlyUnsignedAccounts !== 1
      )
        throw Error("MAINNET_FINALITY_NOT_PROVEN");
      const ix = message.instructions[0],
        data = Buffer.from(getBase58Encoder().encode(ix.data));
      if (
        ix.programIdIndex !== 2 ||
        JSON.stringify(ix.accounts) !== "[0,1]" ||
        data.length !== 12 ||
        data.readUInt32LE(0) !== 2 ||
        data.readBigUInt64LE(4) !== BigInt(terms.amount)
      )
        throw Error("MAINNET_DELIVERY_MISMATCH");
      const fee = BigInt(rpcInteger(meta.fee)),
        pre: bigint[] = meta.preBalances.map((v: unknown) =>
          BigInt(rpcInteger(v)),
        ),
        post: bigint[] = meta.postBalances.map((v: unknown) =>
          BigInt(rpcInteger(v)),
        );
      if (
        post[1] - pre[1] !== BigInt(terms.amount) ||
        pre[0] - post[0] !== BigInt(terms.amount) + fee ||
        pre[2] !== post[2] ||
        fee > BigInt(terms.feeCap) ||
        BigInt(terms.amount) + fee > BigInt(terms.maximumDestinationDebit)
      )
        throw Error("MAINNET_DELIVERY_MISMATCH");
      return {
        genesis: SOLANA_MAINNET_GENESIS,
        signature: transactionId,
        slot: rpcInteger(tx.slot),
        confirmationStatus: "finalized" as const,
        err: null,
        fee: fee.toString(),
        messageDigest: digest(message),
      };
    }),
  );
  if (
    rows.some(
      (r) =>
        r.slot !== rows[0].slot ||
        r.fee !== rows[0].fee ||
        r.messageDigest !== rows[0].messageDigest,
    ) ||
    rows[0].slot < 1
  )
    throw Error("MAINNET_RECEIPT_DISAGREEMENT");
  const result = rows[0];
  Object.freeze(result);
  acceptedReceipts.set(result, digest(terms));
  return result;
}
export class MainnetSubmissionJournal {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly limits: MainnetSubmitLimits,
    readonly now = () => Math.floor(Date.now() / 1000),
  ) {
    if (
      !integer(limits.perTransaction) ||
      !integer(limits.daily) ||
      BigInt(limits.daily) < BigInt(limits.perTransaction) ||
      !Number.isSafeInteger(limits.confirmations) ||
      limits.confirmations < 1
    )
      throw Error("INVALID_SUBMIT_LIMITS");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mainnet_submissions(order_id TEXT PRIMARY KEY, network TEXT NOT NULL, source_commitment TEXT NOT NULL, terms_digest TEXT NOT NULL, prepared_digest TEXT NOT NULL, signed_digest TEXT NOT NULL, transaction_id TEXT NOT NULL, signed TEXT NOT NULL, maximum_debit TEXT NOT NULL, day INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, broadcast_txid TEXT, finalized_ref TEXT, detail_digest TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS mainnet_submissions_source ON mainnet_submissions(source_commitment) WHERE state NOT IN ('failed');
      CREATE UNIQUE INDEX IF NOT EXISTS mainnet_submissions_source_forever ON mainnet_submissions(source_commitment);
      CREATE UNIQUE INDEX IF NOT EXISTS mainnet_submissions_tx ON mainnet_submissions(transaction_id);
      CREATE TABLE IF NOT EXISTS mainnet_submitter_control(id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL, reason TEXT, changed INTEGER NOT NULL);
      INSERT OR IGNORE INTO mainnet_submitter_control(id,paused,reason,changed) VALUES(1,1,'DEFAULT_PAUSED',0);`);
    if (
      !this.db
        .prepare("PRAGMA table_info(mainnet_submissions)")
        .all()
        .some((c) => c.name === "terms_binding")
    )
      this.db.exec(
        "ALTER TABLE mainnet_submissions ADD COLUMN terms_binding TEXT",
      );
    if (
      !this.db
        .prepare("PRAGMA table_info(mainnet_submissions)")
        .all()
        .some((c) => c.name === "expires")
    )
      this.db.exec(
        "ALTER TABLE mainnet_submissions ADD COLUMN expires INTEGER",
      );
  }
  close() {
    this.db.close();
  }
  private atomic<T>(fn: () => T): T {
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
  private paused() {
    return (
      (
        this.db
          .prepare("SELECT paused FROM mainnet_submitter_control WHERE id=1")
          .get() as { paused: number }
      ).paused === 1
    );
  }
  pause(reason: string) {
    if (!reason.trim()) throw Error("PAUSE_REASON_REQUIRED");
    this.db
      .prepare(
        "UPDATE mainnet_submitter_control SET paused=1,reason=?,changed=? WHERE id=1",
      )
      .run(reason.trim(), this.now());
  }
  resume() {
    this.db
      .prepare(
        "UPDATE mainnet_submitter_control SET paused=0,reason=NULL,changed=? WHERE id=1",
      )
      .run(this.now());
  }
  get isPaused() {
    return this.paused();
  }
  prepare(
    terms: MainnetTransferTerms,
    bundle: VerifiedMainnetBundle,
    orderId = bundle.termsDigest,
  ) {
    return this.atomic(() => this.prepareLocked(terms, bundle, orderId));
  }
  private prepareLocked(
    terms: MainnetTransferTerms,
    bundle: VerifiedMainnetBundle,
    orderId: string,
  ) {
    if (
      this.paused() ||
      !orderId.trim() ||
      orderId.length > 128 ||
      bundle.broadcast !== false ||
      !terms.quoteDigest ||
      !HEX64.test(terms.quoteDigest) ||
      !HEX64.test(terms.sourcePaymentCommitment) ||
      !Number.isSafeInteger(terms.expires) ||
      terms.expires <= this.now() ||
      !HEX64.test(bundle.termsDigest) ||
      !HEX64.test(bundle.preparedDigest) ||
      !HEX64.test(bundle.signedDigest) ||
      !bundle.transactionId.trim() ||
      bundle.network !== terms.network ||
      integer(terms.maximumDestinationDebit) === null ||
      BigInt(terms.maximumDestinationDebit) > BigInt(this.limits.perTransaction)
    )
      throw Error("INVALID_MAINNET_SUBMISSION");
    const network = this.db
      .prepare("SELECT network FROM mainnet_submissions LIMIT 1")
      .get();
    if (network && network.network !== terms.network)
      throw Error("SEPARATE_NETWORK_JOURNAL_REQUIRED");
    const existing = this.db
      .prepare("SELECT * FROM mainnet_submissions WHERE order_id=?")
      .get(orderId) as
      | { signed_digest: string; state: string; terms_binding: string }
      | undefined;
    if (existing) {
      if (
        existing.signed_digest !== bundle.signedDigest ||
        existing.terms_binding !== digest(terms) ||
        existing.state === "failed"
      )
        throw Error("CONFLICTING_MAINNET_SUBMISSION");
      return;
    }
    const day = Math.floor(this.now() / 86400),
      used = this.db
        .prepare(
          "SELECT maximum_debit FROM mainnet_submissions WHERE day=? OR state!='finalized'",
        )
        .all(day) as { maximum_debit: string }[],
      total =
        used.reduce((a, r) => a + BigInt(r.maximum_debit), 0n) +
        BigInt(terms.maximumDestinationDebit);
    if (total > BigInt(this.limits.daily)) throw Error("MAINNET_DAILY_LIMIT");
    try {
      this.db
        .prepare(
          "INSERT INTO mainnet_submissions(order_id,network,source_commitment,terms_digest,prepared_digest,signed_digest,transaction_id,signed,maximum_debit,day,state,attempts,created,updated,detail_digest,terms_binding,expires) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',0,?,?,?,?,?)",
        )
        .run(
          orderId,
          bundle.network,
          terms.sourcePaymentCommitment,
          bundle.termsDigest,
          bundle.preparedDigest,
          bundle.signedDigest,
          canonicalId(bundle.network, bundle.transactionId),
          bundle.signed,
          terms.maximumDestinationDebit,
          day,
          this.now(),
          this.now(),
          digest(bundle),
          digest(terms),
          terms.expires,
        );
    } catch (e) {
      if (String(e).includes("UNIQUE"))
        throw Error("MAINNET_SUBMISSION_REPLAY");
      throw e;
    }
  }
  claim(orderId: string): MainnetClaim {
    return this.atomic(() => {
      if (this.paused()) throw Error("MAINNET_SUBMITTER_PAUSED");
      const row = this.db
        .prepare("SELECT * FROM mainnet_submissions WHERE order_id=?")
        .get(orderId) as
        | {
            network: "base" | "solana";
            transaction_id: string;
            signed: string;
            attempts: number;
            state: string;
            expires: number;
          }
        | undefined;
      if (!row) throw Error("UNKNOWN_MAINNET_SUBMISSION");
      if (!Number.isSafeInteger(row.expires) || row.expires <= this.now())
        throw Error("MAINNET_APPROVAL_EXPIRED");
      if (row.state !== "prepared")
        throw Error("MAINNET_SUBMISSION_NOT_CLAIMABLE");
      this.db
        .prepare(
          "UPDATE mainnet_submissions SET state='claimed',attempts=attempts+1,updated=? WHERE order_id=?",
        )
        .run(this.now(), orderId);
      return {
        orderId,
        network: row.network,
        transactionId: row.transaction_id,
        signed: row.signed,
        attempt: row.attempts + 1,
      };
    });
  }
  markBroadcast(orderId: string, transactionId: string) {
    return this.atomic(() => this.markBroadcastLocked(orderId, transactionId));
  }
  private markBroadcastLocked(orderId: string, transactionId: string) {
    const row = this.db
      .prepare(
        "SELECT transaction_id,state FROM mainnet_submissions WHERE order_id=?",
      )
      .get(orderId) as { transaction_id: string; state: string } | undefined;
    if (!row) throw Error("UNKNOWN_MAINNET_SUBMISSION");
    if (row.state !== "claimed")
      throw Error("MAINNET_SUBMISSION_NOT_BROADCASTABLE");
    if (
      canonicalId(String(this.status(orderId).network), row.transaction_id) !==
      canonicalId(String(this.status(orderId).network), transactionId)
    )
      throw Error("MAINNET_BROADCAST_ID_MISMATCH");
    this.db
      .prepare(
        "UPDATE mainnet_submissions SET state='broadcast',broadcast_txid=?,updated=? WHERE order_id=?",
      )
      .run(transactionId, this.now(), orderId);
  }
  markUncertain(orderId: string, detail: string) {
    return this.atomic(() => this.markUncertainLocked(orderId, detail));
  }
  private markUncertainLocked(orderId: string, detail: string) {
    const row = this.db
      .prepare("SELECT state FROM mainnet_submissions WHERE order_id=?")
      .get(orderId) as { state: string } | undefined;
    if (!row || !["claimed", "broadcast", "uncertain"].includes(row.state))
      throw Error("MAINNET_SUBMISSION_NOT_UNCERTAIN");
    this.db
      .prepare(
        "UPDATE mainnet_submissions SET state='uncertain',detail_digest=?,updated=? WHERE order_id=?",
      )
      .run(digest(detail), this.now(), orderId);
  }
  markFailed(_orderId: string): never {
    // Signed bytes already exist. Absence of a response is never failure proof.
    throw Error("SIGNED_MAINNET_ATTEMPT_REQUIRES_RECONCILIATION");
  }
  finalizeBase(
    orderId: string,
    receipt: BaseFinalizedReceipt,
    terms: MainnetTransferTerms,
  ) {
    if (
      acceptedReceipts.get(receipt) !== digest(terms) ||
      this.db
        .prepare(
          "SELECT terms_binding FROM mainnet_submissions WHERE order_id=?",
        )
        .get(orderId)?.terms_binding !== digest(terms)
    )
      throw Error("CANONICAL_FINALITY_EVIDENCE_REQUIRED");
    if (
      terms.network !== "base" ||
      receipt.chainId !== BASE_MAINNET_CHAIN_ID ||
      receipt.status !== "success" ||
      !BASE_TX.test(receipt.transactionHash.toLowerCase()) ||
      receipt.confirmations < this.limits.confirmations ||
      receipt.to.toLowerCase() !== terms.recipient.toLowerCase() ||
      BigInt(receipt.value) !== BigInt(terms.amount) ||
      !Number.isSafeInteger(Number(receipt.blockNumber)) ||
      Number(receipt.blockNumber) <= 0
    )
      throw Error("MAINNET_FINALITY_NOT_PROVEN");
    this.finalize(
      orderId,
      receipt.transactionHash.toLowerCase(),
      String(receipt.blockNumber),
    );
  }
  finalizeSolana(
    orderId: string,
    receipt: SolanaFinalizedReceipt,
    terms: MainnetTransferTerms,
  ) {
    if (
      acceptedReceipts.get(receipt) !== digest(terms) ||
      this.db
        .prepare(
          "SELECT terms_binding FROM mainnet_submissions WHERE order_id=?",
        )
        .get(orderId)?.terms_binding !== digest(terms)
    )
      throw Error("CANONICAL_FINALITY_EVIDENCE_REQUIRED");
    if (
      terms.network !== "solana" ||
      receipt.genesis !== SOLANA_MAINNET_GENESIS ||
      receipt.confirmationStatus !== "finalized" ||
      receipt.err !== null ||
      !receipt.signature.trim() ||
      !Number.isSafeInteger(receipt.slot) ||
      receipt.slot < 1
    )
      throw Error("MAINNET_FINALITY_NOT_PROVEN");
    this.finalize(orderId, receipt.signature, String(receipt.slot));
  }
  private finalize(orderId: string, ref: string, block: string) {
    return this.atomic(() => this.finalizeLocked(orderId, ref, block));
  }
  private finalizeLocked(orderId: string, ref: string, block: string) {
    const row = this.db
      .prepare(
        "SELECT transaction_id,state FROM mainnet_submissions WHERE order_id=?",
      )
      .get(orderId) as { transaction_id: string; state: string } | undefined;
    if (!row) throw Error("UNKNOWN_MAINNET_SUBMISSION");
    if (!["broadcast", "uncertain"].includes(row.state))
      throw Error("MAINNET_SUBMISSION_NOT_FINALIZABLE");
    if (
      canonicalId(String(this.status(orderId).network), row.transaction_id) !==
      canonicalId(String(this.status(orderId).network), ref)
    )
      throw Error("MAINNET_FINALITY_ID_MISMATCH");
    this.db
      .prepare(
        "UPDATE mainnet_submissions SET state='finalized',finalized_ref=?,detail_digest=?,updated=? WHERE order_id=?",
      )
      .run(block, digest({ ref, block }), this.now(), orderId);
  }
  async finalizeFromChain(
    orderId: string,
    terms: MainnetTransferTerms,
    profile: ProductionProfile,
    fetcher: typeof fetch = fetch,
  ) {
    const row = this.status(orderId) as {
      transaction_id: string;
      state: MainnetSubmissionState;
    };
    if (!["broadcast", "uncertain"].includes(row.state))
      throw Error("MAINNET_SUBMISSION_NOT_FINALIZABLE");
    try {
      if (terms.network === "base")
        this.finalizeBase(
          orderId,
          await readBaseFinalizedReceipt(
            profile,
            terms,
            row.transaction_id,
            fetcher,
          ),
          terms,
        );
      else
        this.finalizeSolana(
          orderId,
          await readSolanaFinalizedReceipt(
            profile,
            terms,
            row.transaction_id,
            fetcher,
          ),
          terms,
        );
    } catch (e) {
      if (e instanceof Error && e.message === "MAINNET_RECEIPT_NOT_FOUND") {
        this.markUncertain(orderId, "FINALIZED_RECEIPT_NOT_OBSERVED");
        return this.status(orderId);
      }
      throw e;
    }
    return this.status(orderId);
  }
  status(orderId: string) {
    const row = this.db
      .prepare(
        "SELECT order_id,network,terms_digest,transaction_id,maximum_debit,state,attempts,created,updated,broadcast_txid,finalized_ref FROM mainnet_submissions WHERE order_id=?",
      )
      .get(orderId);
    if (!row) throw Error("UNKNOWN_MAINNET_SUBMISSION");
    return row;
  }
}
