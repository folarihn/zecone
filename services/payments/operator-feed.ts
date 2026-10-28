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
    if (
      !Number.isSafeInteger(b.tip) ||
      (b.tip as number) < 1 ||
      typeof b.tipHash !== "string" ||
      !HEX64.test(b.tipHash) ||
      typeof b.source !== "string" ||
      typeof b.peerSource !== "string" ||
      b.source === b.peerSource ||
      !Number.isSafeInteger(b.observedAt) ||
      (b.observedAt as number) > now + 60 ||
      (b.observedAt as number) < now - 900
    )
      fail("HEARTBEAT_INVALID", 400);
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
  realOrders(): Payment[] {
    return (
      this.store.db
        .prepare(
          `SELECT id FROM payments WHERE mode='monitor' AND state NOT IN ('COMPLETED','EXPIRED','FAILED') ORDER BY created_at`,
        )
        .all() as { id: string }[]
    ).map((r) => this.store.getPayment(r.id)!);
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
    },
  ): Payment {
    const now = this.opts.now();
    const p = this.real(id);
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
    if (!p.quote || o.zat !== p.quote.zecAmountZat)
      fail("OBSERVATION_AMOUNT_MISMATCH");
    // Same attribution rule as the in-process bridge: only notes mined after allocation.
    if (p.allocationTip === null || e.height <= p.allocationTip)
      fail("OBSERVATION_BEFORE_ALLOCATION");
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
  if (rpcUrls.length < 2 || rpcUrls.some((u) => !u.startsWith("https://")))
    throw Error("BASE_PAYOUT_RPCS_REQUIRED");
  const rpc = async (url: string, method: string, params: unknown[]) => {
    const r = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json()) as { result?: any };
    return j.result ?? null;
  };
  return {
    async verify(txHash, expected) {
      const results = await Promise.all(
        rpcUrls.map(async (url) => {
          const [chain, tx, receipt, finalized] = await Promise.all([
            rpc(url, "eth_chainId", []),
            rpc(url, "eth_getTransactionByHash", [txHash]),
            rpc(url, "eth_getTransactionReceipt", [txHash]),
            rpc(url, "eth_getBlockByNumber", ["finalized", false]),
          ]);
          if (chain !== "0x2105") fail("BASE_WRONG_NETWORK");
          if (!tx || !receipt) fail("BASE_PAYOUT_NOT_FOUND");
          if (
            String(tx.from).toLowerCase() !== relayer.toLowerCase() ||
            String(tx.to).toLowerCase() !== expected.to.toLowerCase() ||
            BigInt(tx.value) !== BigInt(expected.wei) ||
            receipt.status !== "0x1"
          )
            fail("BASE_PAYOUT_MISMATCH");
          const block = Number(BigInt(receipt.blockNumber));
          return {
            block,
            finalized: !!finalized && Number(BigInt(finalized.number)) >= block,
          };
        }),
      );
      if (results.some((r) => r.block !== results[0].block))
        fail("BASE_PROVIDERS_DISAGREE");
      return {
        block: results[0].block,
        finalized: results.every((r) => r.finalized),
      };
    },
  };
}
