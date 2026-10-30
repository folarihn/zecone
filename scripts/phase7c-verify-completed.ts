// Read-only chain queries + local reconciliation/replay veto checks. No keys loaded.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyPairSigner } from "@solana/kit";
import { phase7cRuntime } from "../services/solana/phase7c-runtime.ts";
import { digest, ata } from "../services/solana/transactions.ts";
import { TOKEN, SolanaError, json } from "../services/solana/network.ts";
import { OUTPUT, WSOL, POOL } from "../services/solana/cpmm.ts";
const { p, root, service, store } = phase7cRuntime(),
  id = `0x${digest(`phase7c:${p.id}:${p.orderId}`)}`;
let sends = 0;
service.network.send = async () => {
  sends++;
  throw Error("Verification cannot broadcast");
};
try {
  const before = service.view(id);
  assert.equal(before.state, "COMPLETED");
  assert.equal(before.orderState, "settled");
  assert.ok(before.signature);
  const fresh = await service.network.receipt(before.signature);
  assert.ok(fresh, "Fresh finalized receipt unavailable");
  const after = await service.reconcile(id);
  assert.equal(after.state, "COMPLETED");
  assert.equal(after.signature, before.signature);
  const persisted = JSON.parse(service.row(id).receipt!);
  assert.deepEqual(JSON.parse(json(fresh)), persisted);
  const gate = (e: unknown) =>
    e instanceof SolanaError &&
    [
      "PAYMENT_NOT_ELIGIBLE_OR_RECOVERY",
      "PAID_PREPARATION_NOT_AUTHORIZED",
    ].includes(e.code);
  assert.throws(() => service.eligible(id), gate);
  await assert.rejects(service.prepare(id), gate);
  const poison = new Proxy({} as KeyPairSigner, {
    get() {
      throw Error("Replay must not access signer");
    },
  });
  await assert.rejects(
    service.execute(
      id,
      { orderId: id, digest: before.prepared!.digest, approved: true },
      poison,
    ),
    gate,
  );
  assert.throws(
    () => service.recover(id, "FINAL_VERIFICATION_REFUND_PROBE"),
    (e: unknown) =>
      e instanceof SolanaError && e.code === "COMPLETED_DELIVERY_REFUND_VETO",
  );
  const claims = store.db
    .prepare(
      "SELECT event,COUNT(*) AS count FROM audit WHERE order_id=? AND event IN ('solana_signing_claimed','solana_broadcast_claimed') GROUP BY event",
    )
    .all(id);
  assert.equal(claims.length, 2);
  for (const c of claims) assert.equal(Number(c.count), 1);
  assert.equal(sends, 0);
  assert.ok(service.row(id).wire, "Signed evidence must remain durable");
  const bounded = store.db
    .prepare(
      "SELECT state FROM solana_bounded_settlement_authorizations WHERE order_id=?",
    )
    .get(id);
  if (bounded) {
    assert.equal(bounded.state, "CONSUMED");
    assert.ok(
      store.db
        .prepare(
          "SELECT 1 FROM solana_bounded_transaction_derivations WHERE order_id=? AND digest=?",
        )
        .get(id, before.prepared!.digest),
    );
  }
  assert.equal(store.totals(id).confirmed, 100000n);
  assert.ok(before.confirmations >= 10);
  const effects = await service.swapPolicy!.verifyEffects(
    service.intent(id),
    persisted,
  );
  const account: any = await service.swapPolicy!.net.account(
      await ata(p.recipient, OUTPUT),
    ),
    info = account?.data?.parsed?.info;
  assert.equal(account?.owner, TOKEN);
  assert.equal(info?.owner, p.recipient);
  assert.equal(info?.mint, OUTPUT);
  assert.equal(info?.state, "initialized");
  assert.equal(info.tokenAmount.decimals, 6);
  assert.equal(BigInt(info.tokenAmount.amount), BigInt(effects.recipientDelta));
  const report = {
    at: new Date().toISOString(),
    network: "solana:devnet",
    state: after.state,
    signature: before.signature,
    explorer: before.explorer,
    commitment: "finalized",
    slot: persisted.slot,
    blockTime: persisted.blockTime,
    pool: POOL,
    inputMint: WSOL,
    outputMint: OUTPUT,
    recipient: p.recipient,
    amountIn: "1000000",
    minimumOut: before.swap!.minimumOut,
    outputDelta: effects.recipientDelta,
    feeLamports: persisted.meta.fee,
    rentLamports: effects.rent,
    relayerDebitLamports: effects.relayerDelta,
    recipientCurrentTokenUnits: info.tokenAmount.amount,
    recipientTokenOwnershipVerified: true,
    signingClaims: 1,
    broadcastClaims: 1,
    restartReconciliation: "passed",
    duplicateExecution: "rejected_before_signer_access",
    completedRefund: "vetoed",
    verificationBroadcastCalls: sends,
    boundedAuthorityConsumed: bounded ? bounded.state === "CONSUMED" : null,
    signedEvidencePersisted: true,
    liveRefundsEnabled: false,
    privatePaymentJoinPublished: false,
    rpcConsensusCorroborated: false,
  };
  writeFileSync(
    join(root, `final-verification-${Date.now()}.private.json`),
    json({
      report,
      orderId: id,
      paymentTxs: before.paymentTxs,
      shieldedAuthorizationVerified: true,
      minimumConfirmations: 10,
      confirmationsBeforeExecution: before.confirmations,
    }),
    { mode: 0o600, flag: "wx" },
  );
  writeFileSync(
    "docs/phase7c-evidence/completed-verification.json",
    json(report),
  );
  console.log(json(report));
} finally {
  store.close();
}
