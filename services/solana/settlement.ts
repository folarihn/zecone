import { randomBytes } from "node:crypto";
import { assertReviewCurrent } from "./swap-approval.ts";
import {
  recoverySchema,
  recoveryRecord,
  assertPreparationRecovery,
  assertExactRecoveryExecution,
  consumeExactRecoveryApproval,
} from "./paid-recovery.ts";
import { ata } from "./transactions.ts";
import { Store, type Snapshot } from "../execution/store.ts";
import { Devnet, GENESIS, SolanaError, publicKey, json } from "./network.ts";
import { prepare, inspect, digest, type Prepared } from "./transactions.ts";
import type {
  SolanaDeliveryIntent,
  SolanaSplAsset,
} from "./settlement-model.ts";
import {
  validateTerms,
  type CpmmPolicy,
  type SwapTerms,
  type SwapPrepared,
} from "./cpmm.ts";
type StoredPrepared = Prepared | SwapPrepared;
import {
  blockhash,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  signature,
  type KeyPairSigner,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import { signWithLocalSigner, type LeasedSigner } from "./leased-signer.ts";
import {
  EvidenceReader,
  verificationConfig,
  type VerificationConfig,
} from "../execution/rpc-confidence.ts";
import { solanaReceiptEvidence } from "./receipt-confidence.ts";
import { DEVNET } from "./network.ts";
import {
  validateWatchSnapshot,
  type WatchSnapshot,
} from "../signer/watch-evidence.ts";
export const clock = () => Math.floor(Date.now() / 1000);
export const deliveryAsset = (i: SolanaDeliveryIntent) =>
  i.spl
    ? { kind: "SPL" as const, mint: i.spl.mint, decimals: i.spl.decimals }
    : { kind: "SOL" as const };
type Execution = {
  order_id: string;
  state: string;
  prepared: string | null;
  wire: string | null;
  signature: string | null;
  claimed: number;
  receipt: string | null;
};
export interface SettlementNetwork {
  balance: Devnet["balance"];
  latest: Devnet["latest"];
  fee: Devnet["fee"];
  valid: Devnet["valid"];
  simulate: Devnet["simulate"];
  send(wire: string): Promise<string>;
  receipt(sig: string): Promise<any>;
  recoveryAbsence?(intent: SolanaDeliveryIntent, since: number): Promise<void>;
}
// Read calls use bounded retry; a broadcast deliberately bypasses the retry wrapper.
export class SolanaSettlementNetwork implements SettlementNetwork {
  #evidenceConfig?: VerificationConfig;
  constructor(
    readonly net = new Devnet(),
    evidenceConfig?: VerificationConfig,
  ) {
    this.#evidenceConfig = evidenceConfig;
  }
  private verification() {
    return (
      this.#evidenceConfig ?? verificationConfig("ZECONE_SOLANA_RPC", DEVNET)
    );
  }
  // Separate read-only report: does not rewrite persisted receipts or grant execution.
  receiptEvidence(sig: string) {
    return solanaReceiptEvidence(new EvidenceReader(this.verification()), sig);
  }
  balance = (a: string) => this.net.balance(a);
  latest = () => this.net.latest();
  fee = (m: string) => this.net.fee(m);
  valid = (h: ReturnType<typeof blockhash>) => this.net.valid(h);
  simulate = (w: string) => this.net.simulate(w);
  async recoveryAbsence(i: SolanaDeliveryIntent, since: number) {
    const output = await ata(i.recipient, i.swap!.outputMint);
    for (const key of [i.relayer, output]) {
      const rows = await this.net.read(
        (s) =>
          this.net.rpc
            .getSignaturesForAddress(publicKey(key), {
              commitment: "confirmed",
              limit: 1000,
            })
            .send({ abortSignal: s }),
        false,
      );
      if (
        (rows.length === 1000 &&
          (!rows.at(-1)?.blockTime ||
            Number(rows.at(-1)!.blockTime) >= since)) ||
        rows.some((r) => r.blockTime === null || Number(r.blockTime) >= since)
      )
        throw new SolanaError("RECOVERY_HISTORY_RECONCILIATION_REQUIRED");
    }
    if (await this.net.account(output))
      throw new SolanaError("PRIOR_OUTPUT_ACCOUNT_REQUIRES_REVIEW");
  }
  async send(wire: string) {
    await this.net.health(); // Full genesis check BEFORE the sole submission attempt.
    return this.net.rpc
      .sendTransaction(wire as Base64EncodedWireTransaction, {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0n,
      })
      .send({ abortSignal: AbortSignal.timeout(15000) });
  }
  async receipt(sig: string) {
    const config = this.verification();
    if (config.requireCorroboration) {
      const reader = new EvidenceReader(config);
      const result = await solanaReceiptEvidence(reader, sig);
      reader.assertAccepted(result);
      return result.evidence;
    }
    return this.net.read((s) =>
      this.net.rpc
        .getTransaction(signature(sig), {
          commitment: "finalized",
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        })
        .send({ abortSignal: s }),
    );
  }
}
async function splDeliveryEffects(
  i: SolanaDeliveryIntent,
  receipt: any,
  keys: string[],
) {
  if (!i.spl) throw new SolanaError("SPL_ASSET");
  const mint = i.spl.mint,
    recipientAta = String(await ata(i.recipient, mint)),
    relayerAta = String(await ata(i.relayer, mint)),
    recipientIndex = keys.indexOf(recipientAta),
    relayerIndex = keys.indexOf(relayerAta);
  if (recipientIndex < 0 || relayerIndex < 0)
    throw new SolanaError("SPL_ACCOUNT_MISSING");
  const total = (balances: any[], index: number, owner: string): bigint => {
    const rows = balances.filter(
      (b) => b.accountIndex === index && b.mint === mint && b.owner === owner,
    );
    if (!rows.length) throw new SolanaError("SPL_BALANCE_MISSING");
    return rows.reduce(
      (sum: bigint, b: any) => sum + BigInt(b.uiTokenAmount.amount),
      0n,
    );
  };
  const pre = receipt.meta?.preTokenBalances,
    post = receipt.meta?.postTokenBalances;
  if (!Array.isArray(pre) || !Array.isArray(post))
    throw new SolanaError("SPL_BALANCE_MISSING");
  const amount = BigInt(i.lamports),
    recipientDelta =
      total(post, recipientIndex, i.recipient) -
      total(pre, recipientIndex, i.recipient),
    relayerDelta =
      total(pre, relayerIndex, i.relayer) -
      total(post, relayerIndex, i.relayer);
  if (recipientDelta !== amount || relayerDelta !== amount)
    throw new SolanaError("SPL_BALANCE_EFFECT_MISMATCH");
  return {
    recipientDelta: recipientDelta.toString(),
    relayerDelta: relayerDelta.toString(),
    mint,
  };
}
export class SolanaSettlement {
  constructor(
    readonly store: Store,
    readonly network: SettlementNetwork,
    readonly now = clock,
    readonly swapPolicy?: CpmmPolicy,
  ) {
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS solana_settlement(order_id TEXT PRIMARY KEY REFERENCES orders(id),state TEXT NOT NULL,prepared TEXT,wire TEXT,signature TEXT UNIQUE,claimed INTEGER NOT NULL DEFAULT 0,receipt TEXT); CREATE TABLE IF NOT EXISTS solana_authorizations(order_id TEXT PRIMARY KEY,payment_digest TEXT NOT NULL,verified_at INTEGER NOT NULL);`,
    );
    // Signed bytes survive; ambiguous claims are reconciliation-only, never re-signed.
    store.db.exec(
      "UPDATE solana_settlement SET state='RECOVERY_REQUIRED' WHERE state IN ('PREPARING','SIGNING')",
    );
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS solana_exact_approvals(order_id TEXT NOT NULL REFERENCES orders(id),digest TEXT NOT NULL,approved_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(order_id,digest)); UPDATE solana_settlement SET state='RECOVERY_REQUIRED' WHERE state='VALIDATING'",
    );
    recoverySchema(this);
  }
  quote(
    input: {
      profileId: string;
      requestId: string;
      recipient: string;
      relayer: string;
      lamports: string;
      account: string;
      paymentAddress: string;
    },
    swap?: SwapTerms,
    spl?: SolanaSplAsset,
  ) {
    publicKey(input.recipient);
    publicKey(input.relayer);
    if (swap && spl) throw new SolanaError("AMBIGUOUS_DELIVERY_ASSET");
    if (
      input.recipient === input.relayer ||
      (spl
        ? !/^[1-9]\d{0,17}$/.test(input.lamports)
        : !["1000000", "2000000", "5000000"].includes(input.lamports))
    )
      throw new SolanaError("DELIVERY_POLICY");
    if (
      !/^[a-f0-9]{64}$/.test(input.account) ||
      !input.paymentAddress.startsWith("utest1")
    )
      throw new SolanaError("ISOLATED_SHIELDED_PROFILE_REQUIRED");
    if (spl) {
      if (
        spl.kind !== "SPL" ||
        !Number.isInteger(spl.decimals) ||
        spl.decimals < 0 ||
        spl.decimals > 255 ||
        BigInt(input.lamports) > 1_000_000_000_000n
      )
        throw new SolanaError("UNSUPPORTED_SPL_ASSET");
      publicKey(spl.mint);
    }
    if (swap) {
      validateTerms(swap);
      if (!this.swapPolicy || input.lamports !== swap.amountIn)
        throw new SolanaError("SWAP_POLICY_REQUIRED");
    }
    const id =
      `0x${digest(`${swap ? "phase7c" : spl ? "spl-delivery" : "phase7b"}:${input.profileId}:${input.requestId}`)}` as const;
    const old = this.store.get(id);
    if (old) {
      const i = this.intent(id);
      if (
        i.recipient !== input.recipient ||
        i.lamports !== input.lamports ||
        i.relayer !== input.relayer ||
        json(i.swap) !== json(swap) ||
        json(i.spl) !== json(spl)
      )
        throw new SolanaError("IDEMPOTENCY_CONFLICT");
      return this.view(id);
    }
    const i: SolanaDeliveryIntent = {
      family: "solana",
      action: swap
        ? "SOLANA_DEVNET_SPL_SWAP"
        : spl
          ? "SOLANA_DEVNET_SPL_DELIVERY"
          : "SOLANA_DEVNET_SOL_DELIVERY",
      ...(swap ? { swap } : {}),
      ...(spl ? { spl } : {}),
      network: "solana:devnet",
      genesis: GENESIS,
      recipient: input.recipient,
      relayer: input.relayer,
      lamports: input.lamports,
      feeCap: "10000",
      zatoshis: "100000",
      nonce: `0x${randomBytes(32).toString("hex")}`,
      expiry: this.now() + 7200,
      pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE",
      profileId: input.profileId,
      requestId: input.requestId,
    };
    this.store.create(id, i, input.account, input.paymentAddress, this.now());
    this.store.db
      .prepare("INSERT INTO solana_settlement(order_id,state) VALUES(?,?)")
      .run(id, "PAYMENT_PENDING");
    return this.view(id);
  }
  intent(id: string) {
    const o = this.store.get(id);
    if (!o) throw new SolanaError("UNKNOWN_ORDER");
    const i = JSON.parse(o.intent) as SolanaDeliveryIntent;
    if (
      i.family !== "solana" ||
      ![
        "SOLANA_DEVNET_SOL_DELIVERY",
        "SOLANA_DEVNET_SPL_DELIVERY",
        "SOLANA_DEVNET_SPL_SWAP",
      ].includes(i.action) ||
      i.network !== "solana:devnet" ||
      i.genesis !== GENESIS
    )
      throw new SolanaError("WRONG_NETWORK");
    if (i.action === "SOLANA_DEVNET_SPL_SWAP") {
      if (!this.swapPolicy) throw new SolanaError("SWAP_POLICY_REQUIRED");
      validateTerms(i.swap!);
    }
    if (i.action === "SOLANA_DEVNET_SPL_DELIVERY") {
      if (!i.spl || i.spl.kind !== "SPL") throw new SolanaError("SPL_ASSET");
      publicKey(i.spl.mint);
    }
    return i;
  }
  row(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM solana_settlement WHERE order_id=?")
      .get(id) as Execution | undefined;
    if (!row) throw new SolanaError("UNKNOWN_ORDER");
    return row;
  }
  authorize(id: string, s: WatchSnapshot) {
    validateWatchSnapshot(s, this.now());
    const o = this.store.get(id)!;
    if (s.account !== o.account || s.address !== o.address)
      throw new SolanaError("PAYMENT_PROFILE_MISMATCH");
    for (const p of s.payments)
      if (
        p.pool !== 4 ||
        !s.native.inputs.some(
          (n) =>
            n.paymentKey === `${p.txid}:${p.pool}:${p.index}` &&
            n.zatoshis === p.zatoshis &&
            n.minedHeight === p.height,
        )
      )
        throw new SolanaError("OWNED_SHIELDED_NOTE_REQUIRED");
    this.store.observe(s, this.now());
    const total = this.store.totals(id),
      i = this.intent(id);
    const row = this.row(id);
    if (
      recoveryRecord(this, id) &&
      !row.claimed &&
      row.state !== "RECOVERY_REQUIRED"
    ) {
      try {
        assertPreparationRecovery(this, id);
      } catch {
        this.recover(id, "paid_recovery_evidence_veto");
      }
      return this.view(id);
    }
    if (row.claimed || ["COMPLETED", "RECOVERY_REQUIRED"].includes(row.state)) {
      if (total.confirmed < BigInt(i.zatoshis))
        this.recover(id, "payment_reorg_after_execution");
      return this.view(id);
    }
    if (total.received > BigInt(i.zatoshis)) {
      this.recover(id, "excess_or_duplicate_payment");
      return this.view(id);
    }
    if (i.expiry <= this.now() && total.received > 0n) {
      this.recover(id, "expired_payment");
      return this.view(id);
    }
    if (!this.store.eligible(this.store.get(id)!, this.now()))
      return this.view(id);
    const proof = digest(
      json(
        s.payments
          .map((p) => ({
            txid: p.txid,
            pool: p.pool,
            index: p.index,
            zatoshis: p.zatoshis,
            height: p.height,
            blockHash: p.blockHash,
          }))
          .sort((a, b) => a.txid.localeCompare(b.txid)),
      ),
    );
    this.store.db
      .prepare(
        "INSERT INTO solana_authorizations VALUES(?,?,?) ON CONFLICT(order_id) DO UPDATE SET payment_digest=excluded.payment_digest,verified_at=excluded.verified_at",
      )
      .run(id, proof, this.now());
    this.store.db
      .prepare(
        "UPDATE solana_settlement SET state='AWAITING_SOLANA_AUTHORIZATION' WHERE order_id=? AND claimed=0 AND state NOT IN ('PREPARING','VALIDATING','RECOVERY_REQUIRED')",
      )
      .run(id);
    this.store.event(
      id,
      "solana_payment_authorized",
      { paymentDigest: proof, tip: s.tip, confirmations: 10 },
      this.now(),
    );
    return this.view(id);
  }
  eligible(id: string, preparationOnly = false) {
    const row = this.row(id),
      o = this.store.get(id)!;
    if (recoveryRecord(this, id)) {
      if (preparationOnly) assertPreparationRecovery(this, id);
      else assertExactRecoveryExecution(this, id);
      return this.intent(id);
    }
    if (
      row.claimed ||
      row.state === "RECOVERY_REQUIRED" ||
      !this.store.eligible(o, this.now()) ||
      !this.store.db
        .prepare("SELECT order_id FROM solana_authorizations WHERE order_id=?")
        .get(id)
    )
      throw new SolanaError("PAYMENT_NOT_ELIGIBLE_OR_RECOVERY");
    return this.intent(id);
  }
  preparationDeadline(id: string) {
    const grant = recoveryRecord(this, id);
    if (grant) {
      assertPreparationRecovery(this, id);
      return Number(grant.prepare_until);
    }
    return this.intent(id).expiry;
  }
  async prepare(id: string) {
    const i = this.eligible(id, true),
      row = this.row(id);
    if (row.prepared) {
      const cached = JSON.parse(row.prepared) as StoredPrepared;
      if (i.swap) {
        assertReviewCurrent(cached as SwapPrepared, this.now());
        if (!(await this.network.valid(blockhash(cached.lifetime.blockhash))))
          throw new SolanaError("BLOCKHASH_EXPIRED");
      }
      return cached;
    }
    if (
      !this.store.db
        .prepare(
          "UPDATE solana_settlement SET state='PREPARING' WHERE order_id=? AND state='AWAITING_SOLANA_AUTHORIZATION'",
        )
        .run(id).changes
    )
      throw new SolanaError("DUPLICATE_EXECUTION");
    try {
      const balance = await this.network.balance(i.relayer);
      if (i.spl) {
        if (balance < BigInt(i.feeCap))
          throw new SolanaError("INSUFFICIENT_RELAYER_BALANCE");
        const account: any = await (this.network as unknown as Devnet).account(
          await ata(i.relayer, i.spl.mint),
        );
        if (
          BigInt(account?.data?.parsed?.info?.tokenAmount?.amount ?? 0) <
          BigInt(i.lamports)
        )
          throw new SolanaError("INSUFFICIENT_RELAYER_TOKENS");
      } else if (balance < BigInt(i.lamports) + BigInt(i.feeCap))
        throw new SolanaError("INSUFFICIENT_RELAYER_BALANCE");
      const p = i.swap
        ? await this.swapPolicy!.prepare(i, this.preparationDeadline(id))
        : await prepare(
            this.network as unknown as Devnet,
            {
              family: "solana",
              network: "solana:devnet",
              genesis: GENESIS,
              owner: i.relayer,
              recipient: i.recipient,
              amount: i.lamports,
              asset: deliveryAsset(i),
              feeCap: i.feeCap,
            },
            [i.relayer, i.recipient],
          );
      if (p.simulation.err) throw new SolanaError("SIMULATION_FAILED");
      if (
        i.swap &&
        this.store.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='solana_unsigned_review_archive'",
          )
          .get() &&
        this.store.db
          .prepare(
            "SELECT 1 FROM solana_unsigned_review_archive WHERE order_id=? AND digest=?",
          )
          .get(id, p.digest)
      )
        throw new SolanaError("STALE_TRANSACTION_DIGEST_REUSED");
      this.eligible(id, true);
      this.store.db
        .prepare(
          "UPDATE solana_settlement SET state='AWAITING_SOLANA_AUTHORIZATION',prepared=? WHERE order_id=? AND state='PREPARING'",
        )
        .run(json(p), id);
      this.store.event(
        id,
        "solana_prepared",
        { digest: p.digest, fee: p.fee, lifetime: p.lifetime },
        this.now(),
      );
      return p;
    } catch (e) {
      if (
        i.swap &&
        e instanceof SolanaError &&
        ["RPC_UNAVAILABLE", "BLOCKHASH_EXPIRED", "SWAP_QUOTE_EXPIRED"].includes(
          e.code,
        )
      ) {
        // The preparation claim has never loaded a key or produced signed bytes.
        // Keep the verified order available for a new review; never execute a retry here.
        this.store.atomic(() => {
          if (
            this.store.db
              .prepare(
                "UPDATE solana_settlement SET state='AWAITING_SOLANA_AUTHORIZATION' WHERE order_id=? AND state='PREPARING' AND claimed=0 AND wire IS NULL AND signature IS NULL",
              )
              .run(id).changes !== 1
          )
            throw new SolanaError("UNSIGNED_RETRY_STATE_VETO");
          this.store.event(
            id,
            "unsigned_preparation_retry_required",
            { reason: e.code, approvalCarried: false },
            this.now(),
          );
        });
      } else
        this.recover(id, e instanceof SolanaError ? e.code : "RPC_UNAVAILABLE");
      throw e;
    }
  }
  async execute(
    id: string,
    approval: { orderId: string; digest: string; approved: true },
    signer: KeyPairSigner | LeasedSigner,
  ) {
    const i = this.eligible(id),
      row = this.row(id);
    const p: StoredPrepared = row.prepared
      ? JSON.parse(row.prepared)
      : undefined;
    if (
      !p ||
      approval.approved !== true ||
      approval.orderId !== id ||
      approval.digest !== p.digest ||
      signer.address !== i.relayer
    )
      throw new SolanaError("EXACT_APPROVAL_REQUIRED");
    // The transaction approval is scoped to this digest. A durable preflight claim
    // excludes concurrent attempts before any network await or signer access.
    if (i.swap)
      this.store.atomic(() => {
        assertReviewCurrent(p as SwapPrepared, this.now());
        if (
          !this.store.db
            .prepare(
              "UPDATE solana_settlement SET state='VALIDATING' WHERE order_id=? AND state='AWAITING_SOLANA_AUTHORIZATION' AND claimed=0 AND prepared=? AND signature IS NULL AND wire IS NULL",
            )
            .run(id, row.prepared).changes
        )
          throw new SolanaError("CONCURRENT_OR_DUPLICATE_EXECUTION");
        this.store.db
          .prepare("INSERT INTO solana_exact_approvals VALUES(?,?,?,?,?)")
          .run(
            id,
            p.digest,
            this.now(),
            (p as SwapPrepared).approvalExpiresAt ??
              (p as SwapPrepared).expiresAt,
            "VALIDATING",
          );
        this.store.event(
          id,
          "exact_swap_approval_received",
          { digest: p.digest },
          this.now(),
        );
      });
    try {
      if (!(await this.network.valid(blockhash(p.lifetime.blockhash)))) {
        if (!i.swap) this.recover(id, "BLOCKHASH_EXPIRED");
        throw new SolanaError("BLOCKHASH_EXPIRED");
      }
      const relayerBalance = await this.network.balance(i.relayer);
      if (i.spl) {
        if (relayerBalance < BigInt(i.feeCap))
          throw new SolanaError("INSUFFICIENT_RELAYER_BALANCE");
        const account: any = await (this.network as unknown as Devnet).account(
          await ata(i.relayer, i.spl.mint),
        );
        if (
          BigInt(account?.data?.parsed?.info?.tokenAmount?.amount ?? 0) <
          BigInt(i.lamports)
        )
          throw new SolanaError("INSUFFICIENT_RELAYER_TOKENS");
      } else if (relayerBalance < BigInt(i.lamports) + BigInt(i.feeCap))
        throw new SolanaError("INSUFFICIENT_RELAYER_BALANCE");
      const tx = i.swap
        ? await this.swapPolicy!.inspect(i, p as SwapPrepared)
        : await inspect(
            p.wire,
            {
              ...(p as Prepared).action,
              owner: i.relayer,
              recipient: i.recipient,
              amount: i.lamports,
              asset: deliveryAsset(i),
              feeCap: i.feeCap,
            },
            {
              blockhash: blockhash(p.lifetime.blockhash),
              lastValidBlockHeight: BigInt(p.lifetime.lastValidBlockHeight),
            },
            [i.relayer, i.recipient],
          );
      if ((await this.network.simulate(p.wire)).err)
        throw new SolanaError("SIMULATION_FAILED");
      const fee = await this.network.fee(
        Buffer.from(tx.messageBytes).toString("base64"),
      );
      if (fee === null || fee > BigInt(i.feeCap))
        throw new SolanaError("FEE_CAP");
      if (
        i.swap &&
        !(await this.network.valid(blockhash(p.lifetime.blockhash)))
      )
        throw new SolanaError("BLOCKHASH_EXPIRED");
      this.store.atomic(() => {
        this.eligible(id);
        if (i.swap) assertReviewCurrent(p as SwapPrepared, this.now());
        if (
          !this.store.db
            .prepare(
              "UPDATE solana_settlement SET state='SIGNING',claimed=1 WHERE order_id=? AND claimed=0 AND state=?",
            )
            .run(id, i.swap ? "VALIDATING" : "AWAITING_SOLANA_AUTHORIZATION")
            .changes
        )
          throw new SolanaError("DUPLICATE_EXECUTION");
        if (
          i.swap &&
          this.store.db
            .prepare(
              "UPDATE solana_exact_approvals SET state='CONSUMED' WHERE order_id=? AND digest=? AND state='VALIDATING'",
            )
            .run(id, p.digest).changes !== 1
        )
          throw new SolanaError("EXACT_APPROVAL_ALREADY_CONSUMED");
        if (i.swap) consumeExactRecoveryApproval(this, id, p.digest);
        this.store.event(
          id,
          "solana_signing_claimed",
          { digest: p.digest },
          this.now(),
        );
      });
      const signed = await signWithLocalSigner(signer, tx),
        sig = getSignatureFromTransaction(signed),
        wire = getBase64EncodedWireTransaction(signed);
      this.store.atomic(() => {
        const persisted = this.store.db
          .prepare(
            "UPDATE solana_settlement SET state='SUBMISSION_UNCERTAIN',wire=?,signature=? WHERE order_id=? AND state='SIGNING'",
          )
          .run(wire, sig, id);
        if (persisted.changes !== 1)
          throw new SolanaError("RECOVERY_VETO_BEFORE_BROADCAST");
        this.store.transition(id, "prepared", this.now(), { signature: sig });
        this.store.event(
          id,
          "solana_broadcast_claimed",
          { signature: sig },
          this.now(),
        );
      });
      // One invocation only. Timeout/lost response remains signature-reconciliation-only.
      try {
        const returned = await this.network.send(wire);
        if (returned !== sig)
          throw new SolanaError("RPC_SIGNATURE_DISAGREEMENT");
        this.store.db
          .prepare(
            "UPDATE solana_settlement SET state='EXECUTING' WHERE order_id=?",
          )
          .run(id);
        this.store.submitted(id, this.now());
      } catch {
        this.store.event(
          id,
          "solana_submission_uncertain",
          { signature: sig, replacementAuthorized: false },
          this.now(),
        );
      }
      return this.view(id);
    } catch (e) {
      if (
        i.swap &&
        e instanceof SolanaError &&
        [
          "BLOCKHASH_EXPIRED",
          "USER_APPROVAL_EXPIRED",
          "SWAP_QUOTE_EXPIRED",
        ].includes(e.code)
      ) {
        const current = this.row(id);
        if (
          !current.claimed &&
          !current.signature &&
          !current.wire &&
          current.state === "VALIDATING"
        ) {
          this.store.atomic(() => {
            this.store.db
              .prepare(
                "UPDATE solana_settlement SET state='AWAITING_SOLANA_AUTHORIZATION' WHERE order_id=? AND state='VALIDATING' AND claimed=0 AND signature IS NULL AND wire IS NULL",
              )
              .run(id);
            this.store.db
              .prepare(
                "UPDATE solana_exact_approvals SET state='EXPIRED' WHERE order_id=? AND digest=? AND state='VALIDATING'",
              )
              .run(id, p.digest);
            this.store.event(
              id,
              "unsigned_approval_expired_no_signing",
              { digest: p.digest, reason: e.code },
              this.now(),
            );
          });
          throw e;
        }
      }
      if (i.swap && this.row(id).state !== "COMPLETED")
        this.recover(
          id,
          e instanceof SolanaError ? e.code : "EXECUTION_FAILED",
        );
      throw e;
    }
  }
  async reconcile(id: string) {
    const row = this.row(id);
    if (!row.signature) return this.view(id);
    const i = this.intent(id);
    let receipt: any;
    try {
      receipt = await this.network.receipt(row.signature);
    } catch {
      return this.view(id);
    }
    if (!receipt) return this.view(id);
    try {
      if (receipt.meta?.err) throw new SolanaError("TRANSACTION_FAILED");
      const message = receipt.transaction?.message,
        keys = message?.accountKeys;
      if (
        receipt.version !== "legacy" ||
        !Array.isArray(keys) ||
        (!i.swap && !i.spl && keys.length !== 3) ||
        keys[0] !== i.relayer ||
        (!i.swap && !i.spl && keys[1] !== i.recipient) ||
        (!i.swap && !i.spl && keys[2] !== "11111111111111111111111111111111") ||
        receipt.transaction.signatures?.[0] !== row.signature
      )
        throw new SolanaError("RECEIPT_MISMATCH");
      const p = JSON.parse(row.prepared!) as StoredPrepared;
      // Compare the RPC's complete message with the approved SDK-compiled message.
      const original = getCompiledMessage(p.wire);
      const actual = {
        accountKeys: message.accountKeys,
        header: {
          numRequiredSignatures: message.header.numRequiredSignatures,
          numReadonlySignedAccounts: message.header.numReadonlySignedAccounts,
          numReadonlyUnsignedAccounts:
            message.header.numReadonlyUnsignedAccounts,
        },
        recentBlockhash: message.recentBlockhash,
        instructions: message.instructions.map((x: any) => ({
          accounts: x.accounts,
          data: x.data,
          programIdIndex: x.programIdIndex,
        })),
      };
      if (json(actual) !== json(original))
        throw new SolanaError("RECEIPT_MESSAGE_DISAGREEMENT");
      const m = receipt.meta,
        fee = BigInt(m.fee);
      if (
        fee > BigInt(i.feeCap) ||
        fee !== BigInt(p.fee) ||
        m.preBalances.length !== keys.length ||
        m.postBalances.length !== keys.length ||
        (!i.swap &&
          !i.spl &&
          (BigInt(m.postBalances[1]) - BigInt(m.preBalances[1]) !==
            BigInt(i.lamports) ||
            BigInt(m.preBalances[0]) - BigInt(m.postBalances[0]) !==
              BigInt(i.lamports) + fee))
      )
        throw new SolanaError("BALANCE_EFFECT_MISMATCH");
      const effects = i.swap
        ? await this.swapPolicy!.verifyEffects(i, receipt)
        : i.spl
          ? splDeliveryEffects(i, receipt, keys)
          : {
              recipientDelta: i.lamports,
              relayerDelta: (BigInt(i.lamports) + fee).toString(),
            };
      this.store.atomic(() => {
        if (this.row(id).state === "RECOVERY_REQUIRED")
          throw new SolanaError("RECOVERY_VETO");
        this.store.db
          .prepare(
            "UPDATE solana_settlement SET state='COMPLETED',receipt=? WHERE order_id=?",
          )
          .run(json(receipt), id);
        this.store.transition(id, "settled", this.now(), {
          signature: row.signature,
          finalized: true,
          ...effects,
          fee: fee.toString(),
        });
      });
    } catch (e) {
      this.recover(id, e instanceof SolanaError ? e.code : "INVALID_RECEIPT");
    }
    return this.view(id);
  }
  recover(id: string, reason: string) {
    this.store.atomic(() => {
      if (this.row(id).state === "COMPLETED")
        throw new SolanaError("COMPLETED_DELIVERY_REFUND_VETO");
      this.store.db
        .prepare(
          "UPDATE solana_settlement SET state='RECOVERY_REQUIRED' WHERE order_id=?",
        )
        .run(id);
      this.store.transition(id, "recovery", this.now());
      this.store.recover(
        id,
        reason,
        { liveRefundsEnabled: false, replacementAuthorized: false },
        this.now(),
      );
    });
  }
  view(id: string) {
    const row = this.row(id),
      o = this.store.get(id)!,
      i = this.intent(id),
      totals = this.store.totals(id);
    const payments = this.store.db
      .prepare("SELECT key,height FROM payments WHERE order_id=? AND active=1")
      .all(id);
    const scanRow = this.store.db
      .prepare(
        "SELECT detail FROM audit WHERE order_id=? AND event='scan_verified' ORDER BY seq DESC LIMIT 1",
      )
      .get(id);
    const tip = scanRow ? JSON.parse(String(scanRow.detail)).tip : 0;
    const completion = this.store.db
      .prepare(
        "SELECT detail FROM audit WHERE order_id=? AND event LIKE '%->settled' ORDER BY seq DESC LIMIT 1",
      )
      .get(id);
    return {
      id,
      kind: "solana",
      action: i.action,
      ...(i.swap ? { swap: i.swap } : {}),
      ...(i.spl ? { spl: i.spl } : {}),
      asset: deliveryAsset(i),
      network: "solana:devnet",
      recipient: i.recipient,
      relayer: i.relayer,
      lamports: i.lamports,
      zatoshis: i.zatoshis,
      expires: i.expiry,
      pricing: i.pricing,
      feeCap: i.feeCap,
      state:
        !row.claimed &&
        o.state === "expired" &&
        row.state !== "RECOVERY_REQUIRED"
          ? "PAYMENT_EXPIRED"
          : row.state,
      orderState: o.state,
      receivedZatoshis: totals.received.toString(),
      confirmedZatoshis: totals.confirmed.toString(),
      requiredConfirmations: 10,
      confirmations: payments.length
        ? Math.min(
            ...payments.map((p) => Math.max(0, tip - Number(p.height) + 1)),
          )
        : 0,
      paymentTxs: [
        ...new Set(payments.map((p) => String(p.key).split(":")[0])),
      ],
      paymentAddress: o.address,
      signature: row.signature,
      explorer: row.signature
        ? `https://explorer.solana.com/tx/${row.signature}?cluster=devnet`
        : null,
      liveRefundsEnabled: false,
      deliveredAmount:
        row.state === "COMPLETED" && completion
          ? JSON.parse(String(completion.detail)).recipientDelta
          : null,
      prepared: row.prepared
        ? {
            digest: JSON.parse(row.prepared).digest,
            fee: JSON.parse(row.prepared).fee,
            lifetime: JSON.parse(row.prepared).lifetime,
          }
        : null,
    };
  }
}
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getBase58Decoder,
} from "@solana/kit";
export function getCompiledMessage(wire: string) {
  const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64")),
    m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (m.version !== "legacy") throw new SolanaError("UNSUPPORTED_TRANSACTION");
  return {
    accountKeys: m.staticAccounts,
    header: {
      numRequiredSignatures: m.header.numSignerAccounts,
      numReadonlySignedAccounts: m.header.numReadonlySignerAccounts,
      numReadonlyUnsignedAccounts: m.header.numReadonlyNonSignerAccounts,
    },
    recentBlockhash: m.lifetimeToken,
    instructions: m.instructions.map((x) => ({
      accounts: Array.from(x.accountIndices ?? []),
      data: getBase58Decoder().decode(x.data ?? new Uint8Array()),
      programIdIndex: x.programAddressIndex,
    })),
  };
}
