// Non-broadcasting verification of the persisted real delivery after process restart.
// No credential files are loaded. A poison signer and send veto guard replay probes.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { KeyPairSigner } from "@solana/kit";
import { phase7bRuntime } from "../services/solana/phase7b-runtime.ts";
import { digest } from "../services/solana/transactions.ts";
import { json, SolanaError } from "../services/solana/network.ts";

const { p, store, service } = phase7bRuntime();
const id = `0x${digest(`phase7b:${p.id}:${p.orderId}`)}`;
let sendCalls = 0;
service.network.send = async () => {
  sendCalls++;
  throw Error("Verification cannot broadcast");
};
try {
  const before = service.view(id);
  assert.equal(before.state, "COMPLETED");
  assert.equal(before.orderState, "settled");
  assert.ok(before.signature);
  const after = await service.reconcile(id);
  assert.equal(after.state, "COMPLETED");
  assert.equal(after.signature, before.signature);
  const gate = (e: unknown) =>
    e instanceof SolanaError && e.code === "PAYMENT_NOT_ELIGIBLE_OR_RECOVERY";
  assert.throws(() => service.eligible(id), gate);
  await assert.rejects(service.prepare(id), gate);
  const poisonSigner = new Proxy({} as KeyPairSigner, {
    get() {
      throw Error("Replay probe must not access a signer");
    },
  });
  await assert.rejects(
    service.execute(
      id,
      {
        orderId: id,
        digest: before.prepared!.digest,
        approved: true,
      },
      poisonSigner,
    ),
    gate,
  );
  assert.throws(
    () => service.recover(id, "VERIFICATION_REFUND_PROBE"),
    (e: unknown) =>
      e instanceof SolanaError && e.code === "COMPLETED_DELIVERY_REFUND_VETO",
  );
  const row = store.db
    .prepare(
      "SELECT claimed,receipt,signature FROM solana_settlement WHERE order_id=?",
    )
    .get(id)!;
  const counts = store.db
    .prepare(
      "SELECT event,COUNT(*) AS count FROM audit WHERE order_id=? AND event IN ('solana_signing_claimed','solana_broadcast_claimed') GROUP BY event",
    )
    .all(id);
  assert.equal(counts.length, 2);
  for (const c of counts) assert.equal(Number(c.count), 1);
  assert.equal(Number(row.claimed), 1);
  assert.equal(sendCalls, 0);
  const receipt = JSON.parse(String(row.receipt));
  // Require a fresh finalized RPC response as well as the durable receipt.
  const liveReceipt = await service.network.receipt(before.signature);
  assert.ok(liveReceipt, "Finalized receipt unavailable");
  assert.deepEqual(JSON.parse(json(liveReceipt)), receipt);
  const result = {
    at: new Date().toISOString(),
    orderId: id,
    state: after.state,
    signature: row.signature,
    commitment: "finalized",
    slot: receipt.slot,
    blockTime: receipt.blockTime,
    feeLamports: receipt.meta.fee,
    accounts: receipt.transaction.message.accountKeys,
    preBalances: receipt.meta.preBalances,
    postBalances: receipt.meta.postBalances,
    recipientDeltaLamports: (
      BigInt(receipt.meta.postBalances[1]) - BigInt(receipt.meta.preBalances[1])
    ).toString(),
    relayerDebitLamports: (
      BigInt(receipt.meta.preBalances[0]) - BigInt(receipt.meta.postBalances[0])
    ).toString(),
    currentRelayerLamports: await service.network.balance(p.relayer),
    currentRecipientLamports: await service.network.balance(p.recipient),
    auditClaims: counts,
    restartReconciliation: "passed",
    duplicatePreparation: "rejected",
    duplicateExecution: "rejected_before_signer_access",
    completedRefund: "rejected",
    broadcastCallsDuringVerification: sendCalls,
    liveRefundsEnabled: false,
  };
  writeFileSync(
    "docs/phase7b-evidence/completed-verification.json",
    json(result),
  );
  console.log(json(result));
} finally {
  store.close();
}
