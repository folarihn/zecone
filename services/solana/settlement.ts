import { randomBytes } from "node:crypto";
import { assertReviewCurrent } from "./swap-approval.ts";
import { Store, type Snapshot } from "../execution/store.ts";
import { Devnet, GENESIS, SolanaError, publicKey, json } from "./network.ts";
import { prepare, inspect, digest, type Prepared } from "./transactions.ts";
import type { SolanaDeliveryIntent } from "./settlement-model.ts";
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
  signTransaction,
  signature,
  type KeyPairSigner,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import {
  validateWatchSnapshot,
  type WatchSnapshot,
} from "../signer/watch-evidence.ts";
export const clock = () => Math.floor(Date.now() / 1000);
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
}
// Read calls use bounded retry; a broadcast deliberately bypasses the retry wrapper.
export class SolanaSettlementNetwork implements SettlementNetwork {
  constructor(readonly net = new Devnet()) {}
  balance = (a: string) => this.net.balance(a);
  latest = () => this.net.latest();
  fee = (m: string) => this.net.fee(m);
  valid = (h: ReturnType<typeof blockhash>) => this.net.valid(h);
  simulate = (w: string) => this.net.simulate(w);
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
  receipt(sig: string) {
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
  ) {
    publicKey(input.recipient);
    publicKey(input.relayer);
    if (
      input.recipient === input.relayer ||
      !["1000000", "2000000", "5000000"].includes(input.lamports)
    )
      throw new SolanaError("DELIVERY_POLICY");
    if (
      !/^[a-f0-9]{64}$/.test(input.account) ||
      !input.paymentAddress.startsWith("utest1")
    )
      throw new SolanaError("ISOLATED_SHIELDED_PROFILE_REQUIRED");
    if (swap) {
      validateTerms(swap);
      if (!this.swapPolicy || input.lamports !== swap.amountIn)
        throw new SolanaError("SWAP_POLICY_REQUIRED");
    }
    const id =
      `0x${digest(`${swap ? "phase7c" : "phase7b"}:${input.profileId}:${input.requestId}`)}` as const;
    const old = this.store.get(id);
    if (old) {
      const i = this.intent(id);
      if (
        i.recipient !== input.recipient ||
        i.lamports !== input.lamports ||
        i.relayer !== input.relayer ||
        json(i.swap) !== json(swap)
      )
        throw new SolanaError("IDEMPOTENCY_CONFLICT");
      return this.view(id);
    }
    const i: SolanaDeliveryIntent = {
      family: "solana",
      action: swap ? "SOLANA_DEVNET_SPL_SWAP" : "SOLANA_DEVNET_SOL_DELIVERY",
      ...(swap ? { swap } : {}),
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
      !["SOLANA_DEVNET_SOL_DELIVERY", "SOLANA_DEVNET_SPL_SWAP"].includes(
        i.action,
      ) ||
      i.network !== "solana:devnet" ||
      i.genesis !== GENESIS
    )
      throw new SolanaError("WRONG_NETWORK");
    if (i.action === "SOLANA_DEVNET_SPL_SWAP") {
      if (!this.swapPolicy) throw new SolanaError("SWAP_POLICY_REQUIRED");
      validateTerms(i.swap!);
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
  eligible(id: string) {
    const row = this.row(id),
      o = this.store.get(id)!;
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
  async prepare(id: string) {
    const i = this.eligible(id),
      row = this.row(id);
    if (row.prepared) return JSON.parse(row.prepared) as StoredPrepared;
    if (
      !this.store.db
        .prepare(
          "UPDATE solana_settlement SET state='PREPARING' WHERE order_id=? AND state='AWAITING_SOLANA_AUTHORIZATION'",
        )
        .run(id).changes
    )
      throw new SolanaError("DUPLICATE_EXECUTION");
    try {
      const required = BigInt(i.lamports) + BigInt(i.feeCap),
        balance = await this.network.balance(i.relayer);
      if (balance < required)
        throw new SolanaError("INSUFFICIENT_RELAYER_BALANCE");
      const p = i.swap
        ? await this.swapPolicy!.prepare(i)
        : await prepare(
            this.network as unknown as Devnet,
            {
              family: "solana",
              network: "solana:devnet",
              genesis: GENESIS,
              owner: i.relayer,
              recipient: i.recipient,
              amount: i.lamports,
              asset: { kind: "SOL" },
              feeCap: i.feeCap,
            },
            [i.relayer, i.recipient],
          );
      if (p.simulation.err) throw new SolanaError("SIMULATION_FAILED");
      this.eligible(id);
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
      this.recover(id, e instanceof SolanaError ? e.code : "RPC_UNAVAILABLE");
      throw e;
    }
  }
  async execute(
    id: string,
    approval: { orderId: string; digest: string; approved: true },
    signer: KeyPairSigner,
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
      if (
        (await this.network.balance(i.relayer)) <
        BigInt(i.lamports) + BigInt(i.feeCap)
      )
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
        this.store.event(
          id,
          "solana_signing_claimed",
          { digest: p.digest },
          this.now(),
        );
      });
      const signed = await signTransaction([signer.keyPair], tx),
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
        (!i.swap && keys.length !== 3) ||
        keys[0] !== i.relayer ||
        (!i.swap && keys[1] !== i.recipient) ||
        (!i.swap && keys[2] !== "11111111111111111111111111111111") ||
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
          (BigInt(m.postBalances[1]) - BigInt(m.preBalances[1]) !==
            BigInt(i.lamports) ||
            BigInt(m.preBalances[0]) - BigInt(m.postBalances[0]) !==
              BigInt(i.lamports) + fee))
      )
        throw new SolanaError("BALANCE_EFFECT_MISMATCH");
      const effects = i.swap
        ? await this.swapPolicy!.verifyEffects(i, receipt)
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
