// Synthetic chain fixtures; real SDK compilation/signing. Never live swap evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeyPairSigner,
  blockhash,
  getBase64EncodedWireTransaction,
  getAddressEncoder,
} from "@solana/kit";
import {
  CpmmPolicy,
  validateTerms,
  quoteOutput,
  swapTransaction,
  inspectSwap,
  decodePool,
  verifyProgram,
  CPMM,
  POOL,
  WSOL,
  OUTPUT,
  AUTH,
  CONFIG,
  VAULT_IN,
  VAULT_OUT,
  OBSERVATION,
  PROGRAM_HASH,
  type SwapTerms,
  type SwapPrepared,
  type RawAccount,
} from "../services/solana/cpmm.ts";
import { TOKEN, GENESIS, Devnet } from "../services/solana/network.ts";
import { digest, ata } from "../services/solana/transactions.ts";
import { EncryptedAccounts } from "../services/solana/encrypted-accounts.ts";
import { WindowsUnlock } from "../services/solana/windows-unlock.ts";
import { Store } from "../services/execution/store.ts";
import {
  SolanaSettlement,
  getCompiledMessage,
} from "../services/solana/settlement.ts";
import { ScopedHistory, swapBrowserView } from "../services/solana/privacy.ts";
import { Sessions } from "../services/wallet/security.ts";
import { swapApi } from "../services/solana/swap-api.ts";
import { createServer, request } from "node:http";
import { once } from "node:events";
import type { WatchSnapshot } from "../services/signer/watch-evidence.ts";
import { retireExpiredUnsignedSwap } from "../services/solana/swap-review.ts";
import {
  economicReview,
  checkEconomicReview,
  assertReviewCurrent,
} from "../services/solana/swap-approval.ts";
import {
  authorizePaidPreparation,
  recoveryRecord,
  authorizeExactRecoveredTransaction,
  reviewUnsignedRpcRecovery,
} from "../services/solana/paid-recovery.ts";
const key = await generateKeyPairSigner(),
  recipient = (await generateKeyPairSigner()).address;
const liquidity = {
  reserveIn: 800000000n,
  reserveOut: 60000000000n,
  feeRate: 2500n,
};
const expected = quoteOutput(liquidity);
const terms: SwapTerms = {
  program: CPMM,
  pool: POOL,
  inputMint: WSOL,
  outputMint: OUTPUT,
  inputDecimals: 9,
  outputDecimals: 6,
  amountIn: "1000000",
  slippageBps: 100,
  expectedOut: expected.toString(),
  minimumOut: ((expected * 9900n) / 10000n).toString(),
  programHash: PROGRAM_HASH,
};
function setup(file = ":memory:", overrides: any = {}) {
  const store = new Store(file);
  let now = 100000,
    sends = 0,
    receipt: any = null;
  const net: any = {
    balance: async () => 100000000n,
    latest: async () => ({
      blockhash: blockhash("11111111111111111111111111111111"),
      lastValidBlockHeight: 1000n,
    }),
    fee: async () => 5000n,
    valid: async () => true,
    simulate: async () => ({ err: null, unitsConsumed: 90000n }),
    send: async () => {
      sends++;
      return service.row(id).signature;
    },
    receipt: async () => receipt,
    ...overrides,
  };
  const policy = new CpmmPolicy(net as Devnet, () => now);
  policy.pool = async () => liquidity;
  policy.accounts = async () => {};
  const service = new SolanaSettlement(store, net, () => now, policy);
  const q = {
    profileId: randomUUID(),
    requestId: randomUUID(),
    recipient,
    relayer: key.address,
    lamports: "1000000",
    account: "a".repeat(64),
    paymentAddress: "utest1_SYNTHETIC_SWAP_ONLY",
  };
  const id = service.quote(q, terms).id;
  const snapshot = (amount = "100000", conf = 10): WatchSnapshot => ({
    network: "zcash-testnet",
    watchOnly: true,
    liveChain: true,
    liveRefundsEnabled: false,
    source: "https://testnet.zec.rocks:443",
    account: q.account,
    address: q.paymentAddress,
    birthday: 800,
    tip: 1000,
    scanned: 1000,
    observedAt: now,
    blockHash: "b".repeat(64),
    payments: [
      {
        account: q.account,
        txid: "c".repeat(64),
        pool: 4,
        index: 0,
        zatoshis: amount,
        height: 1001 - conf,
        blockHash: "d".repeat(64),
      },
    ],
    native: {
      fullViewingKey: "e".repeat(192),
      anchor: "f".repeat(64),
      anchorHeight: 990,
      inputs: [
        {
          nullifier: "f".repeat(64),
          zatoshis: amount,
          minedHeight: 1001 - conf,
          paymentKey: `${"c".repeat(64)}:4:0`,
        },
      ],
    },
  });
  async function effects(p: SwapPrepared, out = expected) {
    const message = getCompiledMessage(p.wire),
      keys = message.accountKeys,
      input = await ata(key.address, WSOL),
      output = await ata(recipient, OUTPUT);
    const pre = keys.map(() => 1n),
      post = keys.map(() => 1n);
    pre[0] = 100000000n;
    post[0] = 100000000n - 1000000n - 5000n - 2n * 2039280n;
    for (const a of [input, output]) {
      pre[keys.indexOf(a as any)] = 0n;
      post[keys.indexOf(a as any)] = 2039280n;
    }
    const entry = (
      a: string,
      mint: string,
      owner: string,
      amount: bigint,
      decimals: number,
    ) => ({
      accountIndex: keys.indexOf(a as any),
      mint,
      owner,
      programId: TOKEN,
      uiTokenAmount: { amount: amount.toString(), decimals },
    });
    return {
      version: "legacy",
      slot: 123n,
      transaction: { message, signatures: [service.row(id).signature] },
      meta: {
        err: null,
        fee: 5000n,
        preBalances: pre,
        postBalances: post,
        preTokenBalances: [
          entry(VAULT_IN, WSOL, AUTH, 800000000n, 9),
          entry(VAULT_OUT, OUTPUT, AUTH, 60000000000n, 6),
        ],
        postTokenBalances: [
          entry(VAULT_IN, WSOL, AUTH, 801000000n, 9),
          entry(VAULT_OUT, OUTPUT, AUTH, 60000000000n - out, 6),
          entry(input, WSOL, key.address, 0n, 9),
          entry(output, OUTPUT, recipient, out, 6),
        ],
      },
    };
  }
  return {
    store,
    service,
    policy,
    id,
    q,
    net,
    snapshot,
    effects,
    setReceipt: (r: any) => (receipt = r),
    time: (t: number) => (now = t),
    sends: () => sends,
  };
}
test("manual expired unsigned review archives bytes and vetoes valid, claimed or signed replacement", async () => {
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot());
    const p = await x.service.prepare(x.id);
    await assert.rejects(retireExpiredUnsignedSwap(x.service, x.id, false));
    await assert.rejects(retireExpiredUnsignedSwap(x.service, x.id, true));
    x.time(100100);
    x.service.authorize(x.id, x.snapshot());
    for (const mutation of [
      "claimed=1",
      "signature='uncertain'",
      "wire='signed'",
    ]) {
      x.store.db.exec(`UPDATE solana_settlement SET ${mutation}`);
      await assert.rejects(retireExpiredUnsignedSwap(x.service, x.id, true));
      x.store.db.exec(
        "UPDATE solana_settlement SET claimed=0,signature=NULL,wire=NULL",
      );
    }
    await retireExpiredUnsignedSwap(x.service, x.id, true);
    assert.equal(x.service.row(x.id).prepared, null);
    const saved = x.store.db
      .prepare("SELECT digest,prepared FROM solana_unsigned_review_archive")
      .get()!;
    assert.equal(saved.digest, p.digest);
    assert.equal(JSON.parse(saved.prepared as string).wire, p.wire);
    assert.equal(x.sends(), 0);
    await assert.rejects(
      x.service.execute(
        x.id,
        { orderId: x.id, digest: p.digest, approved: true },
        key,
      ),
    );
  } finally {
    x.store.close();
  }
});
async function paidRecoveryFixture() {
  const x = setup(":memory:", { recoveryAbsence: async () => {} });
  x.service.authorize(x.id, x.snapshot());
  const old = await x.service.prepare(x.id);
  x.time(107201);
  x.service.authorize(x.id, x.snapshot());
  return { ...x, old, attempt: randomUUID() };
}

test("reviewed unsigned RPC recovery binds the same paid order; duplicates and unrelated vetoes survive restart", async () => {
  const x = await paidRecoveryFixture();
  try {
    await authorizePaidPreparation(
      x.service,
      x.id,
      x.attempt,
      true,
      x.snapshot(),
    );
    await retireExpiredUnsignedSwap(x.service, x.id, true);
    x.service.recover(x.id, "RPC_UNAVAILABLE");
    await assert.rejects(
      reviewUnsignedRpcRecovery(
        x.service,
        x.id,
        x.attempt,
        false,
        x.snapshot(),
      ),
      /EXPLICIT/,
    );
    const paymentBefore = JSON.stringify(
      x.store.db.prepare("SELECT * FROM payments").all(),
    );
    const results = await Promise.allSettled([
      reviewUnsignedRpcRecovery(x.service, x.id, x.attempt, true, x.snapshot()),
      reviewUnsignedRpcRecovery(x.service, x.id, x.attempt, true, x.snapshot()),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(x.service.row(x.id).state, "AWAITING_SOLANA_AUTHORIZATION");
    assert.equal(
      JSON.stringify(x.store.db.prepare("SELECT * FROM payments").all()),
      paymentBefore,
    );
    const restarted = new SolanaSettlement(
      x.store,
      x.net,
      () => 107201,
      x.policy,
    );
    assert.equal(restarted.eligible(x.id, true).recipient, recipient);
    assert.throws(() => restarted.eligible(x.id));
    x.net.latest = async () => ({
      blockhash: blockhash(key.address),
      lastValidBlockHeight: 1200n,
    });
    assert.equal((await restarted.prepare(x.id)).simulation.err, null);
    assert.equal(x.sends(), 0);
    assert.equal(restarted.row(x.id).claimed, 0);
    assert.equal(restarted.row(x.id).wire, null);
    assert.equal(
      x.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM solana_paid_recovery_exact_approvals",
        )
        .get()!.n,
      0,
    );
  } finally {
    x.store.close();
  }
});

test("transient unsigned preparation failure releases only its claim and never retries execution", async () => {
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot());
    x.net.balance = async () => {
      throw new (await import("../services/solana/network.ts")).SolanaError(
        "RPC_UNAVAILABLE",
      );
    };
    await assert.rejects(x.service.prepare(x.id), /RPC_UNAVAILABLE/);
    assert.equal(x.service.row(x.id).state, "AWAITING_SOLANA_AUTHORIZATION");
    assert.equal(x.service.row(x.id).claimed, 0);
    assert.equal(x.sends(), 0);
  } finally {
    x.store.close();
  }
});

test("reserve-read quote age and post-simulation block margin cannot be reset for review", async () => {
  for (const cause of ["quote", "block-margin"]) {
    const x = setup();
    try {
      x.service.authorize(x.id, x.snapshot());
      if (cause === "quote")
        x.policy.accounts = async () => {
          x.time(100091);
        };
      else
        x.net.blockhashStatus = async () => ({ valid: true, remaining: 99n });
      await assert.rejects(
        x.service.prepare(x.id),
        cause === "quote" ? /SWAP_QUOTE_EXPIRED/ : /BLOCKHASH_EXPIRED/,
      );
      assert.equal(x.service.row(x.id).state, "AWAITING_SOLANA_AUTHORIZATION");
      assert.equal(x.service.row(x.id).prepared, null);
      assert.equal(x.service.row(x.id).claimed, 0);
      assert.equal(x.sends(), 0);
    } finally {
      x.store.close();
    }
  }
});
test("explicit paid recovery binds original payment/intent and prepares only; no implicit execution grant", async () => {
  const x = await paidRecoveryFixture();
  try {
    const intent = x.store.get(x.id)!.intent,
      oldDeadline = x.service.intent(x.id).expiry;
    const grant = await authorizePaidPreparation(
      x.service,
      x.id,
      x.attempt,
      true,
      x.snapshot(),
    );
    assert.equal(grant.scope, "PREPARATION_ONLY");
    assert.equal(grant.prepare_until, 107201 + 7200);
    assert.equal(x.store.get(x.id)!.intent, intent);
    assert.equal(x.service.intent(x.id).expiry, oldDeadline);
    assert.equal(x.store.get(x.id)!.state, "recovery");
    await assert.rejects(
      x.service.prepare(x.id),
      /USER_APPROVAL_EXPIRED|SWAP_QUOTE_EXPIRED/,
    );
    await retireExpiredUnsignedSwap(x.service, x.id, true);
    x.net.latest = async () => ({
      blockhash: blockhash(key.address),
      lastValidBlockHeight: 1200n,
    });
    const p = (await x.service.prepare(x.id)) as SwapPrepared;
    assert.notEqual(p.digest, x.old.digest);
    assert.equal(p.quoteExpiresAt, 107291);
    assert.deepEqual(p.swap, terms);
    assert.equal(x.store.totals(x.id).confirmed, 100000n);
    assert.throws(() => x.service.eligible(x.id));
    await assert.rejects(
      x.service.execute(
        x.id,
        { orderId: x.id, digest: p.digest, approved: true },
        key,
      ),
    );
    assert.equal(x.service.row(x.id).claimed, 0);
    assert.equal(x.sends(), 0);
    assert.equal(
      x.store.db.prepare("SELECT COUNT(*) AS n FROM orders").get()!.n,
      1,
    );
    assert.ok(economicReview(x.service, x.id).reviewUntil > 107201);
  } finally {
    x.store.close();
  }
});
test("paid preparation registration requires explicit exact target and is idempotent without extending deadline", async () => {
  const x = await paidRecoveryFixture();
  try {
    await assert.rejects(
      authorizePaidPreparation(x.service, x.id, x.attempt, false, x.snapshot()),
    );
    await assert.rejects(
      authorizePaidPreparation(
        x.service,
        "0x" + "0".repeat(64),
        x.attempt,
        true,
        x.snapshot(),
      ),
    );
    const first = await authorizePaidPreparation(
      x.service,
      x.id,
      x.attempt,
      true,
      x.snapshot(),
    );
    x.time(107211);
    const again = await authorizePaidPreparation(
      x.service,
      x.id,
      x.attempt,
      true,
      x.snapshot(),
    );
    assert.equal(first.prepare_until, again.prepare_until);
    await assert.rejects(
      authorizePaidPreparation(
        x.service,
        x.id,
        randomUUID(),
        true,
        x.snapshot(),
      ),
      /EXISTING_RECOVERY_ATTEMPT/,
    );
    assert.equal(
      x.store.db
        .prepare("SELECT COUNT(*) AS n FROM solana_paid_preparation_recoveries")
        .get()!.n,
      1,
    );
  } finally {
    x.store.close();
  }
});
test("refund and prior settlement claims veto paid-order reopening", async () => {
  for (const kind of [
    "signing",
    "wire",
    "signature",
    "veto",
    "construction",
    "refund",
    "uncertain",
    "unrelatedRecovery",
  ]) {
    const x = await paidRecoveryFixture();
    try {
      if (kind === "signing")
        x.store.db.exec("UPDATE solana_settlement SET claimed=1");
      if (kind === "wire")
        x.store.db.exec("UPDATE solana_settlement SET wire='SYNTHETIC_SIGNED'");
      if (kind === "signature")
        x.store.db.exec(
          "UPDATE solana_settlement SET signature='SYNTHETIC_UNKNOWN'",
        );
      if (kind === "veto") {
        x.store.db.exec(
          "CREATE TABLE settlement_execution_veto(order_id TEXT)",
        );
        x.store.db
          .prepare("INSERT INTO settlement_execution_veto VALUES(?)")
          .run(x.id);
      }
      if (kind === "construction")
        x.store.db
          .prepare("INSERT INTO execution_construction_claims VALUES(?,0,1)")
          .run(x.id);
      if (kind === "refund") {
        x.store.db.exec(
          "CREATE TABLE settlement_refunds(order_id TEXT,state TEXT)",
        );
        x.store.db
          .prepare("INSERT INTO settlement_refunds VALUES(?,'review_required')")
          .run(x.id);
      }
      if (kind === "uncertain")
        x.store.event(x.id, "solana_submission_uncertain", {}, 107201);
      if (kind === "unrelatedRecovery")
        x.store.recover(x.id, "RPC_UNAVAILABLE", {}, 107201);
      await assert.rejects(
        authorizePaidPreparation(
          x.service,
          x.id,
          x.attempt,
          true,
          x.snapshot(),
        ),
      );
      assert.equal(recoveryRecord(x.service, x.id), undefined);
      assert.equal(x.sends(), 0);
    } finally {
      x.store.close();
    }
  }
});
test("independent submission reconciliation must succeed before a paid recovery grant", async () => {
  const x = await paidRecoveryFixture();
  try {
    x.net.recoveryAbsence = async () => {
      throw Error("synthetic uncertain RPC history");
    };
    await assert.rejects(
      authorizePaidPreparation(x.service, x.id, x.attempt, true, x.snapshot()),
    );
    assert.equal(x.service.row(x.id).state, "RECOVERY_REQUIRED");
    assert.equal(recoveryRecord(x.service, x.id), undefined);
  } finally {
    x.store.close();
  }
});
test("paid preparation cannot change original economic terms or survive changed evidence, refunds or expiry", async () => {
  for (const kind of [
    "recipient",
    "mint",
    "minimum",
    "slippage",
    "evidence",
    "refund",
    "expiry",
  ]) {
    const x = await paidRecoveryFixture();
    try {
      await authorizePaidPreparation(
        x.service,
        x.id,
        x.attempt,
        true,
        x.snapshot(),
      );
      if (["recipient", "mint", "minimum", "slippage"].includes(kind)) {
        const i = JSON.parse(x.store.get(x.id)!.intent);
        if (kind === "recipient") i.recipient = key.address;
        if (kind === "mint") i.swap.outputMint = WSOL;
        if (kind === "minimum") i.swap.minimumOut = "1";
        if (kind === "slippage") i.swap.slippageBps = 200;
        x.store.db
          .prepare("UPDATE orders SET intent=? WHERE id=?")
          .run(JSON.stringify(i), x.id);
      }
      if (kind === "evidence")
        x.store.db.exec("UPDATE payments SET block_hash='changed'");
      if (kind === "refund") {
        x.store.db.exec(
          "CREATE TABLE settlement_execution_veto(order_id TEXT)",
        );
        x.store.db
          .prepare("INSERT INTO settlement_execution_veto VALUES(?)")
          .run(x.id);
      }
      if (kind === "expiry") {
        x.time(114402);
        x.service.authorize(x.id, x.snapshot());
      }
      await assert.rejects(x.service.prepare(x.id));
      assert.equal(x.sends(), 0);
    } finally {
      x.store.close();
    }
  }
});
test("paid recovery survives restart as preparation only and preserves original expired approval records", async () => {
  const x = await paidRecoveryFixture();
  try {
    x.store.db
      .prepare("INSERT INTO solana_exact_approvals VALUES(?,?,?,?,?)")
      .run(x.id, x.old.digest, 100000, 100090, "EXPIRED");
    const oldRow = x.store.db
      .prepare("SELECT * FROM solana_exact_approvals")
      .get();
    await authorizePaidPreparation(
      x.service,
      x.id,
      x.attempt,
      true,
      x.snapshot(),
    );
    await retireExpiredUnsignedSwap(x.service, x.id, true);
    const restarted = new SolanaSettlement(
      x.store,
      x.net,
      () => 107201,
      x.policy,
    );
    assert.equal(restarted.eligible(x.id, true).recipient, recipient);
    assert.throws(() => restarted.eligible(x.id));
    assert.deepEqual(
      x.store.db.prepare("SELECT * FROM solana_exact_approvals").get(),
      oldRow,
    );
    x.net.latest = async () => ({
      blockhash: blockhash(key.address),
      lastValidBlockHeight: 1200n,
    });
    const p = await restarted.prepare(x.id);
    await assert.rejects(
      restarted.execute(
        x.id,
        { orderId: x.id, digest: x.old.digest, approved: true },
        key,
      ),
    );
    await assert.rejects(
      restarted.execute(
        x.id,
        { orderId: x.id, digest: p.digest, approved: true },
        key,
      ),
    );
    assert.equal(x.sends(), 0);
  } finally {
    x.store.close();
  }
});
test("concurrent paid recovery registration creates one attempt and leaves other orders locked", async () => {
  const x = await paidRecoveryFixture();
  try {
    const other = x.service.quote(
      {
        ...x.q,
        requestId: randomUUID(),
        account: "1".repeat(64),
        paymentAddress: "utest1_OTHER_RECOVERY_SYNTHETIC",
      },
      terms,
    );
    const outcomes = await Promise.allSettled([
      authorizePaidPreparation(x.service, x.id, x.attempt, true, x.snapshot()),
      authorizePaidPreparation(
        x.service,
        x.id,
        randomUUID(),
        true,
        x.snapshot(),
      ),
    ]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      x.store.db
        .prepare("SELECT COUNT(*) AS n FROM solana_paid_preparation_recoveries")
        .get()!.n,
      1,
    );
    assert.equal(recoveryRecord(x.service, other.id), undefined);
    await assert.rejects(x.service.prepare(other.id));
  } finally {
    x.store.close();
  }
});
test("archived transaction digest cannot be presented as a new recovered preparation", async () => {
  const x = await paidRecoveryFixture();
  try {
    await authorizePaidPreparation(
      x.service,
      x.id,
      x.attempt,
      true,
      x.snapshot(),
    );
    await retireExpiredUnsignedSwap(x.service, x.id, true);
    await assert.rejects(
      x.service.prepare(x.id),
      /STALE_TRANSACTION_DIGEST_REUSED/,
    );
    assert.equal(x.service.row(x.id).state, "RECOVERY_REQUIRED");
    assert.equal(x.sends(), 0);
  } finally {
    x.store.close();
  }
});
test("recovered execution needs a second explicit exact authorization and consumes it once", async () => {
  const x = await paidRecoveryFixture();
  try {
    await authorizePaidPreparation(
      x.service,
      x.id,
      x.attempt,
      true,
      x.snapshot(),
    );
    await retireExpiredUnsignedSwap(x.service, x.id, true);
    x.net.latest = async () => ({
      blockhash: blockhash(key.address),
      lastValidBlockHeight: 1200n,
    });
    const p = (await x.service.prepare(x.id)) as SwapPrepared;
    await assert.rejects(
      authorizeExactRecoveredTransaction(x.service, x.id, p.digest, false),
    );
    await assert.rejects(
      authorizeExactRecoveredTransaction(x.service, x.id, x.old.digest, true),
    );
    assert.equal(
      x.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM solana_paid_recovery_exact_approvals",
        )
        .get()!.n,
      0,
    );
    await authorizeExactRecoveredTransaction(x.service, x.id, p.digest, true); // Synthetic later human approval only.
    await x.service.execute(
      x.id,
      { orderId: x.id, digest: p.digest, approved: true },
      key,
    );
    x.setReceipt(await x.effects(p));
    assert.equal((await x.service.reconcile(x.id)).state, "COMPLETED");
    assert.equal(x.sends(), 1);
    assert.equal(
      x.store.db
        .prepare("SELECT state FROM solana_paid_recovery_exact_approvals")
        .get()!.state,
      "CONSUMED",
    );
    await assert.rejects(
      x.service.execute(
        x.id,
        { orderId: x.id, digest: p.digest, approved: true },
        key,
      ),
    );
    assert.throws(() => x.service.recover(x.id, "refund"));
  } finally {
    x.store.close();
  }
});
test("separate recovered exact approval cannot carry to a fresh digest or expired quote", async () => {
  const x = await paidRecoveryFixture();
  try {
    await authorizePaidPreparation(
      x.service,
      x.id,
      x.attempt,
      true,
      x.snapshot(),
    );
    await retireExpiredUnsignedSwap(x.service, x.id, true);
    x.net.latest = async () => ({
      blockhash: blockhash(key.address),
      lastValidBlockHeight: 1200n,
    });
    const old = await x.service.prepare(x.id);
    await authorizeExactRecoveredTransaction(x.service, x.id, old.digest, true);
    const recorded = x.store.db
      .prepare("SELECT * FROM solana_paid_recovery_exact_approvals")
      .get();
    x.time(107292);
    x.service.authorize(x.id, x.snapshot());
    await assert.rejects(
      authorizeExactRecoveredTransaction(x.service, x.id, old.digest, true),
      /EXPIRED/,
    );
    await retireExpiredUnsignedSwap(x.service, x.id, true);
    x.net.latest = async () => ({
      blockhash: blockhash(recipient),
      lastValidBlockHeight: 1400n,
    });
    const fresh = await x.service.prepare(x.id);
    assert.notEqual(old.digest, fresh.digest);
    assert.throws(
      () => x.service.eligible(x.id),
      /SEPARATE_EXACT_RECOVERY_APPROVAL_REQUIRED/,
    );
    assert.deepEqual(
      x.store.db
        .prepare("SELECT * FROM solana_paid_recovery_exact_approvals")
        .get(),
      recorded,
    );
    assert.equal(x.sends(), 0);
  } finally {
    x.store.close();
  }
});
test("a fresh quote cannot silently widen slippage or rewrite the original minimum", async () => {
  const x = await paidRecoveryFixture();
  try {
    await authorizePaidPreparation(
      x.service,
      x.id,
      x.attempt,
      true,
      x.snapshot(),
    );
    await retireExpiredUnsignedSwap(x.service, x.id, true);
    const original = x.store.get(x.id)!.intent;
    x.policy.pool = async () => ({
      ...liquidity,
      reserveOut: liquidity.reserveOut * 2n,
    });
    await assert.rejects(
      x.service.prepare(x.id),
      /FRESH_QUOTE_REQUIRES_CHANGED_MINIMUM_APPROVAL/,
    );
    assert.equal(x.store.get(x.id)!.intent, original);
    assert.equal(x.sends(), 0);
  } finally {
    x.store.close();
  }
});
test("swap terms pin one devnet route, decimals, amount, slippage and minimum", () => {
  validateTerms(terms);
  for (const patch of [
    { program: GENESIS },
    { pool: CPMM },
    { inputMint: OUTPUT },
    { outputDecimals: 9 },
    { amountIn: "999999" },
    { slippageBps: 200 },
    { minimumOut: "1" },
    { programHash: "0".repeat(64) },
  ])
    assert.throws(() => validateTerms({ ...terms, ...patch } as any));
  assert.throws(() => quoteOutput({ ...liquidity, reserveIn: 0n }));
});
test("canonical swap rejects malicious route bytes, changed recipient and injected instructions", async () => {
  const x = setup();
  try {
    const p = await x.policy.prepare(x.service.intent(x.id));
    await inspectSwap(x.service.intent(x.id), p);
    const wire = Buffer.from(p.wire, "base64");
    wire[wire.length - 1] ^= 1;
    await assert.rejects(
      inspectSwap(x.service.intent(x.id), {
        ...p,
        wire: wire.toString("base64"),
        digest: digest(wire.toString("base64")),
      }),
    );
    await assert.rejects(
      inspectSwap(
        {
          ...x.service.intent(x.id),
          recipient: (await generateKeyPairSigner()).address,
        },
        p,
      ),
    );
    await assert.rejects(
      swapTransaction(
        { ...x.service.intent(x.id), network: "solana:mainnet" as any },
        terms,
        {
          blockhash: blockhash("11111111111111111111111111111111"),
          lastValidBlockHeight: 1000n,
        },
      ),
    );
  } finally {
    x.store.close();
  }
});
test("real Ed25519 synthetic swap settles only with exact token effects and rejects duplicate/refund", async () => {
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot());
    const p = (await x.service.prepare(x.id)) as SwapPrepared;
    await x.service.execute(
      x.id,
      { orderId: x.id, digest: p.digest, approved: true },
      key,
    );
    x.setReceipt(await x.effects(p));
    assert.equal((await x.service.reconcile(x.id)).state, "COMPLETED");
    assert.equal(x.service.view(x.id).deliveredAmount, expected.toString());
    await assert.rejects(
      x.service.execute(
        x.id,
        { orderId: x.id, digest: p.digest, approved: true },
        key,
      ),
    );
    assert.throws(() => x.service.recover(x.id, "refund"));
    assert.equal(x.sends(), 1);
  } finally {
    x.store.close();
  }
});
test("swap cannot authorize unconfirmed, underpaid, reused or wrong-account Zcash evidence", async () => {
  for (const [amount, conf] of [
    ["100000", 9],
    ["99999", 10],
  ] as const) {
    const x = setup();
    try {
      x.service.authorize(x.id, x.snapshot(amount, conf));
      await assert.rejects(x.service.prepare(x.id));
      assert.throws(() =>
        x.service.authorize(x.id, { ...x.snapshot(), account: "0".repeat(64) }),
      );
      assert.throws(() => x.service.authorize(x.id, x.snapshot("200000")));
    } finally {
      x.store.close();
    }
  }
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot("200000"));
    assert.equal(x.service.view(x.id).state, "RECOVERY_REQUIRED");
  } finally {
    x.store.close();
  }
});
test("slippage and simulation failures require recovery; unsigned quote expiry preserves the payment", async () => {
  for (const kind of ["slippage", "expiry", "simulation"]) {
    const x = setup();
    try {
      x.service.authorize(x.id, x.snapshot());
      if (kind === "simulation")
        x.net.simulate = async () => ({
          err: { InstructionError: [4, "synthetic"] },
        });
      if (kind === "simulation") {
        await assert.rejects(x.service.prepare(x.id));
        assert.equal(x.service.view(x.id).state, "RECOVERY_REQUIRED");
        continue;
      }
      const p = (await x.service.prepare(x.id)) as SwapPrepared;
      if (kind === "slippage")
        x.policy.pool = async () => ({ ...liquidity, reserveOut: 1n });
      else x.time(100091);
      // refresh the payment timestamp while retaining the original prepared quote
      x.service.authorize(x.id, x.snapshot());
      await assert.rejects(
        x.service.execute(
          x.id,
          { orderId: x.id, digest: p.digest, approved: true },
          key,
        ),
      );
      assert.equal(
        x.service.view(x.id).state,
        kind === "expiry"
          ? "AWAITING_SOLANA_AUTHORIZATION"
          : "RECOVERY_REQUIRED",
      );
      assert.equal(x.sends(), 0);
    } finally {
      x.store.close();
    }
  }
});
test("late exact approval cannot spend even while the reviewed economic terms remain valid", async () => {
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot());
    const review = economicReview(x.service, x.id);
    const p = (await x.service.prepare(x.id)) as SwapPrepared;
    assert.equal(p.quoteExpiresAt, 100090);
    assert.equal(p.approvalExpiresAt, 100300);
    x.time(100301);
    x.service.authorize(x.id, x.snapshot());
    checkEconomicReview(x.service, x.id, review.termsDigest);
    await assert.rejects(
      x.service.execute(
        x.id,
        { orderId: x.id, digest: p.digest, approved: true },
        key,
      ),
      /USER_APPROVAL_EXPIRED/,
    );
    assert.equal(x.service.row(x.id).claimed, 0);
    assert.equal(x.sends(), 0);
  } finally {
    x.store.close();
  }
});
test("expired blockhash retires unsigned bytes without retiring verified payment or reusing approval", async () => {
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot());
    const originalIntent = x.store.get(x.id)!.intent;
    const old = await x.service.prepare(x.id);
    x.net.valid = async () => false;
    await assert.rejects(
      x.service.execute(
        x.id,
        { orderId: x.id, digest: old.digest, approved: true },
        key,
      ),
      /BLOCKHASH_EXPIRED/,
    );
    assert.equal(x.service.row(x.id).state, "AWAITING_SOLANA_AUTHORIZATION");
    await retireExpiredUnsignedSwap(x.service, x.id, true);
    x.net.valid = async () => true;
    x.net.latest = async () => ({
      blockhash: blockhash(key.address),
      lastValidBlockHeight: 1200n,
    });
    const fresh = await x.service.prepare(x.id);
    assert.notEqual(fresh.digest, old.digest);
    assert.equal(x.store.get(x.id)!.intent, originalIntent);
    assert.equal(x.store.totals(x.id).confirmed, 100000n);
    await assert.rejects(
      x.service.execute(
        x.id,
        { orderId: x.id, digest: old.digest, approved: true },
        key,
      ),
      /EXACT_APPROVAL_REQUIRED/,
    );
    assert.equal(x.sends(), 0);
    await x.service.execute(
      x.id,
      { orderId: x.id, digest: fresh.digest, approved: true },
      key,
    );
    assert.equal(x.sends(), 1);
    assert.equal(
      x.store.db
        .prepare("SELECT state FROM solana_exact_approvals WHERE digest=?")
        .get(fresh.digest)!.state,
      "CONSUMED",
    );
  } finally {
    x.store.close();
  }
});
test("quote expiration during preflight releases only the unsigned validation claim", async () => {
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot());
    const p = await x.service.prepare(x.id);
    x.net.simulate = async () => {
      x.time(100091);
      return { err: null };
    };
    await assert.rejects(
      x.service.execute(
        x.id,
        { orderId: x.id, digest: p.digest, approved: true },
        key,
      ),
      /SWAP_QUOTE_EXPIRED/,
    );
    assert.equal(x.service.row(x.id).claimed, 0);
    assert.equal(x.service.row(x.id).state, "AWAITING_SOLANA_AUTHORIZATION");
    assert.equal(
      x.store.db.prepare("SELECT state FROM solana_exact_approvals").get()!
        .state,
      "EXPIRED",
    );
    assert.equal(x.sends(), 0);
  } finally {
    x.store.close();
  }
});
test("economic review binds recipient, mint, slippage and minimum; terms review alone never signs", () => {
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot());
    const original = x.store.get(x.id)!.intent;
    const review = economicReview(x.service, x.id);
    assert.equal(review.authorizesBroadcast, false);
    for (const patch of [
      { recipient: key.address },
      { swap: { ...terms, outputMint: WSOL } },
      { swap: { ...terms, slippageBps: 200 } },
      { swap: { ...terms, minimumOut: "1" } },
    ]) {
      x.store.db
        .prepare("UPDATE orders SET intent=? WHERE id=?")
        .run(JSON.stringify({ ...JSON.parse(original), ...patch }), x.id);
      assert.throws(() =>
        checkEconomicReview(x.service, x.id, review.termsDigest),
      );
    }
    x.store.db
      .prepare("UPDATE orders SET intent=? WHERE id=?")
      .run(original, x.id);
    x.time(101801);
    x.service.authorize(x.id, x.snapshot());
    assert.throws(
      () => checkEconomicReview(x.service, x.id, review.termsDigest),
      /ECONOMIC_REVIEW_EXPIRED/,
    );
    assert.equal(x.sends(), 0);
  } finally {
    x.store.close();
  }
});
test("simultaneous exact approvals cannot race or revoke the winning signer", async () => {
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot());
    const p = await x.service.prepare(x.id);
    let release!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    x.net.valid = async () => {
      await wait;
      return true;
    };
    const approval = {
      orderId: x.id,
      digest: p.digest,
      approved: true as const,
    };
    const winner = x.service.execute(x.id, approval, key);
    await assert.rejects(
      x.service.execute(x.id, approval, key),
      /CONCURRENT_OR_DUPLICATE_EXECUTION/,
    );
    assert.equal(x.service.row(x.id).state, "VALIDATING");
    release();
    await winner;
    assert.equal(x.sends(), 1);
    await assert.rejects(x.service.execute(x.id, approval, key));
  } finally {
    x.store.close();
  }
});
test("restart during unsigned validation fails closed and cannot reset recovery by a new scan", async () => {
  const file = join(
    mkdtempSync(join(tmpdir(), "zec-swap-recovery-")),
    "orders.sqlite",
  );
  const x = setup(file);
  x.service.authorize(x.id, x.snapshot());
  const p = await x.service.prepare(x.id);
  x.store.db
    .prepare("UPDATE solana_settlement SET state='VALIDATING' WHERE order_id=?")
    .run(x.id);
  x.store.close();
  const store = new Store(file),
    restarted = new SolanaSettlement(store, x.net, () => 100000, x.policy);
  try {
    assert.equal(restarted.row(x.id).state, "RECOVERY_REQUIRED");
    restarted.authorize(x.id, x.snapshot());
    assert.equal(restarted.row(x.id).state, "RECOVERY_REQUIRED");
    await assert.rejects(retireExpiredUnsignedSwap(restarted, x.id, true));
    await assert.rejects(
      restarted.execute(
        x.id,
        { orderId: x.id, digest: p.digest, approved: true },
        key,
      ),
    );
  } finally {
    store.close();
  }
});
test("payment attribution cannot move to another order during review recovery", () => {
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot());
    economicReview(x.service, x.id);
    const other = x.service.quote(
      {
        ...x.q,
        requestId: randomUUID(),
        account: "1".repeat(64),
        paymentAddress: "utest1_OTHER_SYNTHETIC",
      },
      terms,
    );
    const s = x.snapshot();
    s.account = "1".repeat(64);
    s.address = "utest1_OTHER_SYNTHETIC";
    s.payments = s.payments.map((p) => ({ ...p, account: s.account }));
    assert.throws(
      () => x.service.authorize(other.id, s),
      /attribution changed/,
    );
    assert.equal(x.store.totals(x.id).confirmed, 100000n);
    assert.equal(x.store.totals(other.id).confirmed, 0n);
  } finally {
    x.store.close();
  }
});
test("quote expiry and approval expiry are independent gates even with a chain-valid blockhash", async () => {
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot());
    const p = (await x.service.prepare(x.id)) as SwapPrepared;
    assert.throws(() => assertReviewCurrent(p, 100091), /SWAP_QUOTE_EXPIRED/);
    assert.throws(
      () => assertReviewCurrent({ ...p, quoteExpiresAt: 101000 }, 100301),
      /USER_APPROVAL_EXPIRED/,
    );
    assert.equal(x.sends(), 0);
  } finally {
    x.store.close();
  }
});
test("expired original paid order retains payment attribution but cannot refresh, sign or reset recovery", async () => {
  const x = setup();
  try {
    x.service.authorize(x.id, x.snapshot());
    const original = x.store.get(x.id)!.intent;
    await x.service.prepare(x.id);
    x.time(107201);
    x.service.authorize(x.id, x.snapshot());
    assert.equal(x.service.row(x.id).state, "RECOVERY_REQUIRED");
    assert.equal(x.store.totals(x.id).confirmed, 100000n);
    assert.equal(x.store.get(x.id)!.intent, original);
    assert.equal(
      x.store.db.prepare("SELECT COUNT(*) AS n FROM orders").get()!.n,
      1,
    );
    assert.throws(() => economicReview(x.service, x.id));
    await assert.rejects(retireExpiredUnsignedSwap(x.service, x.id, true));
    await assert.rejects(x.service.prepare(x.id));
    x.service.authorize(x.id, x.snapshot());
    assert.equal(x.service.row(x.id).state, "RECOVERY_REQUIRED");
    assert.equal(x.service.row(x.id).claimed, 0);
    assert.equal(x.service.row(x.id).signature, null);
    assert.equal(x.sends(), 0);
  } finally {
    x.store.close();
  }
});
test("swap lost submission response remains signature-only after restart", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "zec-swap-")), "orders.sqlite");
  const x = setup(file, {
    send: async () => {
      throw Error("synthetic lost response");
    },
  });
  x.service.authorize(x.id, x.snapshot());
  const p = (await x.service.prepare(x.id)) as SwapPrepared;
  await x.service.execute(
    x.id,
    { orderId: x.id, digest: p.digest, approved: true },
    key,
  );
  const sig = x.service.row(x.id).signature;
  x.store.close();
  const store = new Store(file),
    restarted = new SolanaSettlement(store, x.net, () => 100000, x.policy);
  try {
    assert.equal(restarted.view(x.id).state, "SUBMISSION_UNCERTAIN");
    assert.equal(restarted.row(x.id).signature, sig);
    await assert.rejects(
      restarted.execute(
        x.id,
        { orderId: x.id, digest: p.digest, approved: true },
        key,
      ),
    );
  } finally {
    store.close();
  }
});
test("finalized transaction with wrong mint, output or recipient owner cannot settle", async () => {
  for (const mutation of ["mint", "owner", "amount"]) {
    const x = setup();
    try {
      x.service.authorize(x.id, x.snapshot());
      const p = (await x.service.prepare(x.id)) as SwapPrepared;
      await x.service.execute(
        x.id,
        { orderId: x.id, digest: p.digest, approved: true },
        key,
      );
      const r = await x.effects(p);
      const out = r.meta.postTokenBalances.at(-1)!;
      if (mutation === "mint") out.mint = WSOL;
      else if (mutation === "owner") out.owner = key.address;
      else out.uiTokenAmount.amount = "1";
      x.setReceipt(r);
      assert.equal(
        (await x.service.reconcile(x.id)).state,
        "RECOVERY_REQUIRED",
      );
    } finally {
      x.store.close();
    }
  }
});
function poolFixture() {
  const a = (owner: string, n: number): Exclude<RawAccount, null> => ({
    owner,
    executable: false,
    data: Buffer.alloc(n),
  });
  const pool = a(CPMM, 637),
    config = a(CPMM, 236),
    vin = a(TOKEN, 165),
    vout = a(TOKEN, 165),
    min = a(TOKEN, 82),
    mout = a(TOKEN, 82),
    obs = a(CPMM, 8);
  const hash = (s: string) =>
    createHash("sha256").update(s).digest().subarray(0, 8);
  hash("account:PoolState").copy(pool.data);
  hash("account:AmmConfig").copy(config.data);
  hash("account:ObservationState").copy(obs.data);
  const put = (b: Buffer, n: number, k: string) =>
    Buffer.from(getAddressEncoder().encode(k as any)).copy(b, n);
  [
    CONFIG,
    AUTH,
    VAULT_IN,
    VAULT_OUT,
    AUTH,
    WSOL,
    OUTPUT,
    TOKEN,
    TOKEN,
    OBSERVATION,
  ].forEach((k, i) => put(pool.data, 8 + i * 32, k));
  pool.data[331] = 9;
  pool.data[332] = 6;
  config.data.writeBigUInt64LE(2500n, 12);
  for (const [v, mint, amount] of [
    [vin, WSOL, liquidity.reserveIn],
    [vout, OUTPUT, liquidity.reserveOut],
  ] as const) {
    put(v.data, 0, mint);
    put(v.data, 32, AUTH);
    v.data[108] = 1;
    v.data.writeBigUInt64LE(amount, 64);
  }
  min.data[44] = 9;
  mout.data[44] = 6;
  min.data[45] = mout.data[45] = 1;
  return [pool, config, vin, vout, min, mout, obs];
}
test("raw mint/pool/account decoding rejects unsupported extensions, authorities and program upgrades", () => {
  assert.deepEqual(decodePool(poolFixture()), liquidity);
  for (const mutate of [
    (a: any[]) => (a[4].owner = CPMM),
    (a: any[]) => (a[5].data[44] = 9),
    (a: any[]) => (a[5].data = Buffer.alloc(83)),
    (a: any[]) => a[5].data.writeUInt32LE(1, 46),
    (a: any[]) => (a[0].data[390] = 1),
    (a: any[]) => (a[0].data[329] = 4),
    (a: any[]) => a[2].data.writeUInt32LE(1, 72),
  ]) {
    const a = poolFixture();
    mutate(a);
    assert.throws(() => decodePool(a));
  }
  assert.throws(() => verifyProgram(null, null));
});
test("privacy projection excludes secret/history/correlation fields and scopes history by session", () => {
  const x = setup();
  try {
    const h = new ScopedHistory(x.store.db),
      first = h.handle("one", x.id),
      second = h.handle("two", "other");
    assert.notEqual(first, second);
    assert.throws(() => h.order("two", first));
    const view = swapBrowserView(
        {
          ...x.service.view(x.id),
          seed: "SENSITIVE",
          fullViewingKey: "SENSITIVE",
          wire: "SENSITIVE",
          payer: "SENSITIVE",
        },
        first,
      ),
      text = JSON.stringify(view);
    for (const denied of [
      "SENSITIVE",
      x.id,
      x.q.account,
      x.q.paymentAddress,
      x.q.profileId,
      x.q.requestId,
    ])
      assert.ok(!text.includes(denied));
    assert.equal(h.reused(recipient), false);
    h.markRecipient(recipient);
    assert.equal(h.reused(recipient), true);
    assert.throws(() => h.diagnostic("SENSITIVE", 100));
    h.diagnostic("RPC_UNAVAILABLE", 100);
    h.diagnostic("QUOTE_FAILED", 100000);
    assert.equal(
      x.store.db.prepare("SELECT COUNT(*) AS n FROM swap_diagnostics").get()!.n,
      1,
    );
  } finally {
    x.store.close();
  }
});
test("new age credentials reject wrong passwords/tampering and recover from encrypted backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "zec-age-")),
    label = `recipient-${randomUUID()}`,
    a = new EncryptedAccounts(join(root, "original"));
  const pass = "synthetic-password-for-isolated-tests-only",
    recovery = "different-synthetic-recovery-password-only";
  const address = await a.generate(label, pass);
  assert.throws(() => a.signer(label));
  await assert.rejects(a.unlock(label, pass, false));
  await assert.rejects(a.unlock(label, "incorrect-password-only", true));
  await a.unlock(label, pass, true);
  assert.equal(a.signer(label).address, address);
  a.lock();
  const backup = join(root, "backup.age");
  await a.backup(label, pass, recovery, backup);
  const restored = new EncryptedAccounts(join(root, "restored"));
  assert.equal(
    await restored.restore(label, backup, recovery, address),
    address,
  );
  await restored.unlock(label, recovery, true);
  assert.equal(restored.signer(label).address, address);
  restored.lock();
  const cipher = readFileSync(join(root, "original", `${label}.age`));
  assert.ok(!cipher.includes(Buffer.from(pass)));
  cipher[cipher.length - 1] ^= 1;
  writeFileSync(join(root, "original", `${label}.age`), cipher);
  await assert.rejects(a.unlock(label, pass, true));
});
test(
  "Windows DPAPI round-trip requires explicit unlock without plaintext key storage",
  { skip: process.platform !== "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "zec-dpapi-")),
      u = new WindowsUnlock(root),
      secret = await u.create("relayer");
    await assert.rejects(u.unlock("relayer", false));
    assert.equal(await u.unlock("relayer", true), secret);
    assert.ok(
      !readFileSync(join(root, "relayer.dpapi")).includes(Buffer.from(secret)),
    );
  },
);

test("paired swap API rejects unauthorized queries, cross-session correlation and arbitrary spending", async () => {
  const x = setup(),
    sessions = new Sessions(x.store.db);
  const user = sessions.pair(sessions.issuePairing()),
    other = sessions.pair(sessions.issuePairing());
  sessions.db.prepare("UPDATE sessions SET connected=1").run();
  const handler = swapApi(
    sessions,
    x.service,
    x.policy,
    {
      id: x.q.profileId,
      orderId: x.q.requestId,
      recipient,
      relayer: key.address,
    },
    { keyId: x.q.account, address: x.q.paymentAddress },
  );
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  const call = (
    path: string,
    body?: unknown,
    who = user,
    headers: Record<string, string> = {},
  ) =>
    new Promise<{ status: number; body: any }>((yes, no) => {
      const r = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: body ? "POST" : "GET",
          headers: {
            Host: "127.0.0.1:3210",
            Origin: "http://127.0.0.1:3210",
            Cookie: `zecone_session=${who.cookie}`,
            "Content-Type": "application/json",
            "X-ZecOne-CSRF": who.session.csrf,
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (b) => (text += b));
          res.on("end", () =>
            yes({ status: res.statusCode!, body: JSON.parse(text) }),
          );
        },
      );
      r.on("error", no);
      r.end(body ? JSON.stringify(body) : undefined);
    });
  try {
    assert.equal(
      (await call("/api/solana-swap/config", undefined, user, { Cookie: "" }))
        .status,
      401,
    );
    assert.equal(
      (
        await call("/api/solana-swap/config", undefined, user, {
          Origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("/api/solana-swap/config?address=anything")).status,
      400,
    );
    const q = await call("/api/solana-swap/quote", { recipient });
    assert.equal(q.status, 200);
    for (const secret of [
      x.id,
      x.q.account,
      x.q.profileId,
      x.q.paymentAddress,
      "paymentTxs",
      "fullViewingKey",
    ])
      assert.ok(!JSON.stringify(q.body).includes(secret));
    const second = await call("/api/solana-swap/status", undefined, other);
    assert.deepEqual(second.body, { orders: [] });
    assert.notEqual(
      (
        await call(
          "/api/solana-swap/payment-request",
          { handle: q.body.handle, reveal: true },
          other,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/api/solana-swap/payment-request", {
          handle: q.body.handle,
          reveal: true,
        })
      ).body.address,
      x.q.paymentAddress,
    );
    assert.equal(
      (await call("/api/solana-swap/quote", { recipient }, other)).status,
      403,
    );
    assert.equal(
      (await call("/api/solana-swap/execute", { instructions: ["arbitrary"] }))
        .status,
      404,
    );
    assert.equal(
      (
        await call("/api/solana-swap/quote", { recipient }, user, {
          "X-ZecOne-CSRF": "wrong",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/api/solana-swap/quote", {
          recipient: (await generateKeyPairSigner()).address,
        })
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    x.store.close();
  }
});
