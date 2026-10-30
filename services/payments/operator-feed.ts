// Operator-fed watcher for the public payment API (restricted mainnet pilot).
//
// The public API never holds a viewing key, wallet or signer. The operator
// machine runs the existing authenticated watcher (PaymentWatchBridge over a
// local mirror of the real orders) and the existing payout session, then
// reports results here over the loopback-only operator listener:
//   * heartbeat   — verified watcher tip; real checkouts pause when it is stale;
//   * observation — detection, confirmation progress, ZEC_CONFIRMED, MANUAL_REVIEW;
//   * payout      — the Base transaction, which this module re-verifies on public
//                   Base RPCs (recipient, value, relayer, success, finality)
//                   before the order may complete.
// The same state machine, single-txid attribution and allocation rules apply.
import type { PaymentStore } from "./store.ts";
import type { ChainEvidence, Payment } from "./types.ts";
import type { WatchHealth } from "./watch-bridge.ts";
import { assessWalletEvidence, type WalletEvidence } from "./wallet-evidence.ts";

const HEX64 = /^[a-f0-9]{64}$/;
const BASE_TX = /^0x[a-f0-9]{64}$/;
const INT = /^(0|[1-9][0-9]{0,30})$/;

export class OperatorFeedError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
const fail = (code: string, status = 409): never => {
  throw new OperatorFeedError(code, status);
};

export interface BasePayoutCheck {
  /** Confirms a successful relayer → recipient transfer of exactly `wei`; reports finality. */
  verify(
    txHash: string,
    expected: { to: string; wei: string },
  ): Promise<{ block: number; finalized: boolean }>;
}

export interface OperatorFeedOptions {
  minimumConfirmations: number;
  maxPayoutWei: bigint;
  payout: BasePayoutCheck;
  now: () => number;
}

export class OperatorWatchFeed {
  constructor(
    private readonly store: PaymentStore,
    private readonly opts: OperatorFeedOptions,
  ) {
    if (opts.minimumConfirmations < 20)
      throw Error("MONITOR_CONFIRMATIONS_TOO_LOW");
  }

  private checkpoint() {
    return this.store.db
      .prepare(`SELECT * FROM watch_checkpoint WHERE id=1`)
      .get() as
      | {
          tip: number;
          block_hash: string;
          observed_at: number;
          updated_at: number;
        }
      | undefined;
  }

  health(maxAgeSeconds = 900): WatchHealth {
    const cp = this.checkpoint();
    return {
      ready: !!cp && this.opts.now() - cp.observed_at <= maxAgeSeconds,
      tip: cp?.tip ?? null,
      tipHash: cp?.block_hash ?? null,
      observedAt: cp?.observed_at ?? null,
      lastTickAt: cp?.updated_at ?? null,
      lastError: null,
      reorgsDetected: 0,
      notes: { attributed: 0, unattributed: 0, reorged: 0 },
    };
  }

  heartbeat(b: {
    tip: unknown;
    tipHash: unknown;
    source: unknown;
    peerSource: unknown;
    observedAt: unknown;
  }) {
    const now = this.opts.now();
    const source = typeof b.source === "string" ? b.source.trim().toLowerCase() : "";
    const peerSource = typeof b.peerSource === "string" ? b.peerSource.trim().toLowerCase() : "";
    if (
      !Number.isSafeInteger(b.tip) ||
      (b.tip as number) < 1 ||
      typeof b.tipHash !== "string" ||
      !HEX64.test(b.tipHash) ||
      !source ||
      !peerSource ||
      source === peerSource ||
      !Number.isSafeInteger(b.observedAt) ||
      (b.observedAt as number) > now + 60 ||
      (b.observedAt as number) < now - 900
    )
      fail("HEARTBEAT_INVALID", 400);
    const prior = this.checkpoint();
    if (
      prior &&
      ((b.tip as number) < prior.tip ||
        ((b.tip as number) === prior.tip && b.tipHash !== prior.block_hash) ||
        (b.observedAt as number) < prior.observed_at)
    )
      fail("HEARTBEAT_REGRESSION");
    this.store.db
      .prepare(
        `INSERT INTO watch_checkpoint(id,tip,block_hash,source,peer_source,observed_at,updated_at) VALUES(1,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET tip=excluded.tip, block_hash=excluded.block_hash, source=excluded.source,
           peer_source=excluded.peer_source, observed_at=excluded.observed_at, updated_at=excluded.updated_at`,
      )
      .run(
        b.tip as number,
        b.tipHash as string,
        b.source as string,
        b.peerSource as string,
        b.observedAt as number,
        now,
      );
    return this.health();
  }

  /** Real orders the operator watcher must follow (non-terminal monitor payments). */
  realOrders(): (Payment & { reviewReason: string | null })[] {
    return (
      this.store.db
        .prepare(
          `SELECT id FROM payments WHERE mode='monitor' AND state NOT IN ('COMPLETED','EXPIRED','FAILED') ORDER BY created_at`,
        )
        .all() as { id: string }[]
    ).map((r) => {
      const payment = this.store.getPayment(r.id)!;
      const reviewReason =
        payment.state === "MANUAL_REVIEW"
          ? ([...this.store.listEvents(payment.id)]
              .reverse()
              .find((e) => e.state === "MANUAL_REVIEW")?.data.reason ?? null)
          : null;
      return {
        ...payment,
        reviewReason:
          typeof reviewReason === "string" &&
          /^[a-z0-9_]{1,64}$/.test(reviewReason)
            ? reviewReason
            : null,
      };
    });
  }

  private real(id: string): Payment {
    const p = this.store.getPayment(id);
    if (!p || p.mode !== "monitor") return fail("REAL_ORDER_NOT_FOUND", 404);
    return p;
  }

  observe(
    id: string,
    o: {
      state?: unknown;
      txid?: unknown;
      zat?: unknown;
      chainEvidence?: unknown;
      reason?: unknown;
      walletEvidence?: unknown;
      tip?: unknown;
    },
  ): Payment {
    const now = this.opts.now();
    const p = this.real(id);
    if (o.state === "EXPIRED") {
      const cp = this.checkpoint() ?? fail("ABSENCE_RESOLUTION_INVALID");
      const latest = [...this.store.listEvents(p.id)]
        .reverse()
        .find((e) => e.state === "MANUAL_REVIEW");
      if (
        o.reason !== "no_payment_after_delayed_observation" ||
        !Number.isSafeInteger(o.tip) ||
        o.tip !== cp.tip ||
        p.state !== "MANUAL_REVIEW" ||
        p.detectedTxid !== null ||
        p.paymentExpiryHeight === null ||
        cp.tip < p.paymentExpiryHeight ||
        latest?.data.reason !== "observation_incomplete"
      )
        fail("ABSENCE_RESOLUTION_INVALID");
      const verifiedTip = cp.tip;
      if (
        !this.store.transition(
          p.id,
          "EXPIRED",
          {
            reason: "no_payment_after_delayed_observation",
            inclusionHeight: p.paymentExpiryHeight,
            watcherTip: verifiedTip,
            evidence: "operator-authenticated-absence",
          },
          now,
        )
      )
        fail("TRANSITION_REFUSED");
      return this.store.getPayment(p.id)!;
    }
    if (o.state === "MANUAL_REVIEW") {
      const reason =
        typeof o.reason === "string" && /^[a-z0-9_]{1,64}$/.test(o.reason)
          ? o.reason
          : "operator_review";
      if (
        p.state !== "MANUAL_REVIEW" &&
        !this.store.transition(
          p.id,
          "MANUAL_REVIEW",
          { reason, evidence: "mainnet-observed" },
          now,
        )
      )
        fail("TRANSITION_REFUSED");
      return this.store.getPayment(p.id)!;
    }
    if (o.state !== "VERIFYING" && o.state !== "ZEC_CONFIRMED")
      return fail("OBSERVATION_STATE_INVALID", 400);
    const e = o.chainEvidence as ChainEvidence;
    if (
      typeof o.txid !== "string" ||
      !HEX64.test(o.txid) ||
      typeof o.zat !== "string" ||
      !INT.test(o.zat) ||
      !e ||
      e.txid !== o.txid ||
      e.zatoshis !== o.zat ||
      !Number.isSafeInteger(e.height) ||
      !Number.isSafeInteger(e.confirmations) ||
      !Number.isSafeInteger(e.tip) ||
      !HEX64.test(String(e.blockHash)) ||
      !HEX64.test(String(e.ownershipDigest)) ||
      (e.paymentDigest !== null && !HEX64.test(String(e.paymentDigest))) ||
      e.minimumConfirmations !== this.opts.minimumConfirmations ||
      !Array.isArray(e.sources) ||
      e.sources.length !== 2
    )
      fail("OBSERVATION_INVALID", 400);
    if (
      e.sources.some((source) => typeof source !== "string" || !source.trim()) ||
      new Set(e.sources.map((source) => source.trim().toLowerCase())).size !== 2
    )
      fail("OBSERVATION_SOURCES_NOT_INDEPENDENT", 400);
    if (!p.quote || o.zat !== p.quote.zecAmountZat)
      fail("OBSERVATION_AMOUNT_MISMATCH");
    // Same attribution rule as the in-process bridge: only notes mined after allocation.
    if (p.allocationTip === null || e.height <= p.allocationTip)
      fail("OBSERVATION_BEFORE_ALLOCATION");
    // ...and only notes included at or below the agreed inclusion height.
    if (p.paymentExpiryHeight !== null && e.height > p.paymentExpiryHeight)
      fail("OBSERVATION_AFTER_INCLUSION_HEIGHT");
    // Height alone cannot show the payment was made before the deadline: the
    // integrated wallet's journal must prove this exact txid was signed and
    // broadcast in time (see wallet-evidence.ts).
    const ev = o.walletEvidence as WalletEvidence | undefined;
    const evidenceFailure = assessWalletEvidence(
      { ...p, detectedTxid: o.txid as string, chainEvidence: e },
      ev,
    );
    if (evidenceFailure) fail(`WALLET_EVIDENCE_${evidenceFailure.toUpperCase()}`);
    if (p.walletEvidence && JSON.stringify(p.walletEvidence) !== JSON.stringify(ev))
      fail("WALLET_EVIDENCE_CHANGED");
    this.store.tx(() => {
      if (p.state === "AWAITING_PAYMENT")
        this.store.markDetected(
          p.id,
          o.txid as string,
          o.zat as string,
          now,
          "mainnet-observed",
        );
      else if (p.detectedTxid !== o.txid) fail("OBSERVATION_TXID_MISMATCH");
      const cur = this.store.getPayment(p.id)!;
      if (!["VERIFYING", "ZEC_CONFIRMED"].includes(cur.state))
        fail("TRANSITION_REFUSED");
      if (!cur.walletEvidence) this.store.setWalletEvidence(p.id, ev!, now);
      this.store.setChainEvidence(p.id, { ...e, observedAt: now }, now);
      if (o.state === "ZEC_CONFIRMED" && cur.state === "VERIFYING") {
        if (
          !e.paymentDigest ||
          e.confirmations < this.opts.minimumConfirmations
        )
          fail("NOT_CONFIRMED");
        this.store.transition(
          p.id,
          "ZEC_CONFIRMED",
          {
            evidence: "mainnet-observed",
            txid: e.txid,
            height: e.height,
            confirmations: e.confirmations,
            tip: e.tip,
            paymentDigest: e.paymentDigest,
            settlement: "operator-approved",
          },
          now,
        );
      }
    });
    return this.store.getPayment(p.id)!;
  }

  async payout(
    id: string,
    b: { txHash?: unknown; wei?: unknown },
  ): Promise<Payment> {
    const p = this.real(id);
    if (
      typeof b.txHash !== "string" ||
      !BASE_TX.test(b.txHash) ||
      typeof b.wei !== "string" ||
      !INT.test(b.wei) ||
      b.wei === "0"
    )
      fail("PAYOUT_INVALID", 400);
    if (BigInt(b.wei as string) > this.opts.maxPayoutWei)
      fail("PAYOUT_ABOVE_PILOT_LIMIT");
    if (
      ![
        "ZEC_CONFIRMED",
        "PAYOUT_PENDING",
        "PAYOUT_SUBMITTED",
        "PAYOUT_CONFIRMED",
        "COMPLETED",
      ].includes(p.state)
    )
      fail("ORDER_NOT_CONFIRMED");
    if (assessWalletEvidence(p, p.walletEvidence))
      fail("WALLET_EVIDENCE_REQUIRED");
    if (
      p.payoutTxHash !== null &&
      (p.payoutTxHash !== b.txHash || p.payoutWei !== b.wei)
    )
      fail("PAYOUT_ALREADY_RECORDED");
    if (p.state === "COMPLETED") return p;
    const chain = await this.opts.payout.verify(b.txHash as string, {
      to: p.request.recipient,
      wei: b.wei as string,
    });
    const now = this.opts.now();
    this.store.tx(() => {
      const data = {
        evidence: "mainnet-observed",
        txHash: b.txHash,
        wei: b.wei,
        block: chain.block,
      };
      if (this.store.getPayment(p.id)!.state === "ZEC_CONFIRMED") {
        this.store.transition(
          p.id,
          "PAYOUT_PENDING",
          { ...data, settlement: "operator-approved" },
          now,
        );
        this.store.setPayout(p.id, b.txHash as string, b.wei as string, now);
      }
      if (this.store.getPayment(p.id)!.state === "PAYOUT_PENDING")
        this.store.transition(p.id, "PAYOUT_SUBMITTED", data, now);
      if (
        chain.finalized &&
        this.store.getPayment(p.id)!.state === "PAYOUT_SUBMITTED"
      ) {
        this.store.transition(p.id, "PAYOUT_CONFIRMED", data, now);
        this.store.transition(p.id, "COMPLETED", data, now);
      }
    });
    return this.store.getPayment(p.id)!;
  }
}

/** Public Base RPC verification; every configured provider must agree. */
export function basePayoutCheck(
  rpcUrls: string[],
  relayer: string,
  fetcher: typeof fetch = fetch,
): BasePayoutCheck {
  let providers: URL[];
  try {
    providers = rpcUrls.map((value) => new URL(value));
  } catch {
    throw Error("BASE_PAYOUT_RPCS_REQUIRED");
  }
  if (
    providers.length < 2 ||
    providers.some((u) => u.protocol !== "https:" || !!u.username || !!u.password) ||
    new Set(providers.map((u) => u.hostname.toLowerCase())).size !== providers.length
  )
    throw Error("BASE_PAYOUT_RPCS_REQUIRED");
  const rpc = async (url: string, method: string, params: unknown[]) => {
    const r = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) fail("BASE_RPC_HTTP_ERROR");
    const j = (await r.json()) as { result?: any; error?: unknown };
    if (j.error || !("result" in j)) fail("BASE_RPC_RESPONSE_INVALID");
    return j.result ?? null;
  };
  return {
    async verify(txHash, expected) {
      const results = await Promise.all(
        providers.map(async (provider) => {
          const url = provider.toString();
          const [chain, tx, receipt, finalized] = await Promise.all([
            rpc(url, "eth_chainId", []),
            rpc(url, "eth_getTransactionByHash", [txHash]),
            rpc(url, "eth_getTransactionReceipt", [txHash]),
            rpc(url, "eth_getBlockByNumber", ["finalized", false]),
          ]);
          if (chain !== "0x2105") fail("BASE_WRONG_NETWORK");
          if (!tx || !receipt) fail("BASE_PAYOUT_NOT_FOUND");
          const blockHash = String(receipt.blockHash ?? "").toLowerCase();
          if (
            String(tx.hash ?? "").toLowerCase() !== txHash.toLowerCase() ||
            String(receipt.transactionHash ?? "").toLowerCase() !== txHash.toLowerCase() ||
            !/^0x[a-f0-9]{64}$/.test(blockHash) ||
            String(tx.blockHash ?? "").toLowerCase() !== blockHash ||
            String(tx.blockNumber ?? "").toLowerCase() !== String(receipt.blockNumber ?? "").toLowerCase() ||
            String(tx.from).toLowerCase() !== relayer.toLowerCase() ||
            String(tx.to).toLowerCase() !== expected.to.toLowerCase() ||
            BigInt(tx.value) !== BigInt(expected.wei) ||
            receipt.status !== "0x1"
          )
            fail("BASE_PAYOUT_MISMATCH");
          const block = Number(BigInt(receipt.blockNumber));
          return {
            block,
            blockHash,
            finalized: !!finalized && Number(BigInt(finalized.number)) >= block,
          };
        }),
      );
      if (results.some((r) => r.block !== results[0].block || r.blockHash !== results[0].blockHash))
        fail("BASE_PROVIDERS_DISAGREE");
      return {
        block: results[0].block,
        finalized: results.every((r) => r.finalized),
      };
    },
  };
}
