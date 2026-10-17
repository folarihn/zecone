// Read-only journal and independent RPC inspection. No runtime constructor, keys or broadcast.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { address, blockhash } from "@solana/kit";
import { Devnet, json } from "../services/solana/network.ts";
import { ata } from "../services/solana/transactions.ts";
import { OUTPUT } from "../services/solana/cpmm.ts";
const p = JSON.parse(readFileSync(".state/phase7c/profile.json", "utf8"));
const root = join(".state/phase7c", p.id);
const db = new DatabaseSync(join(root, "settlement.sqlite"), {
  readOnly: true,
});
try {
  const orders = db.prepare("SELECT * FROM orders").all();
  if (orders.length !== 1) throw Error("Expected original single order");
  const o = orders[0],
    id = String(o.id),
    intent = JSON.parse(String(o.intent));
  const r = db
    .prepare("SELECT * FROM solana_settlement WHERE order_id=?")
    .get(id)!;
  const prepared = r.prepared ? JSON.parse(String(r.prepared)) : null;
  const events = db
    .prepare("SELECT event,at,detail FROM audit WHERE order_id=? ORDER BY seq")
    .all(id);
  const payments = db
    .prepare("SELECT * FROM payments WHERE order_id=?")
    .all(id);
  const net = new Devnet();
  const outputAccount = await ata(intent.recipient, OUTPUT);
  const histories: Record<string, unknown> = {};
  // Query signer AND recipient token account: a token receipt need not touch its owner address.
  for (const [label, key] of [
    ["relayer", intent.relayer],
    ["recipientTokenAccount", outputAccount],
  ]) {
    const rows = await net.read((s) =>
      net.rpc
        .getSignaturesForAddress(address(key), {
          commitment: "confirmed",
          limit: 1000,
        })
        .send({ abortSignal: s }),
    );
    if (
      rows.length === 1000 &&
      (!rows.at(-1)?.blockTime ||
        Number(rows.at(-1)!.blockTime) >= Number(o.created))
    )
      throw Error("History pagination required; fail closed");
    const recent = rows.filter(
      (t) => t.blockTime === null || Number(t.blockTime) >= Number(o.created),
    );
    histories[label] = recent;
  }
  const signatures = new Set<string>();
  for (const e of events) {
    const v = JSON.parse(String(e.detail));
    if (v.signature) signatures.add(v.signature);
  }
  if (r.signature) signatures.add(String(r.signature));
  const statuses = [];
  for (const sig of signatures)
    statuses.push({ signature: sig, status: await net.status(sig) });
  const token = await net.account(outputAccount);
  const health = await net.health();
  const claims = events.filter((e) =>
    /signing_claimed|broadcast_claimed/.test(String(e.event)),
  ).length;
  const noLocalSubmission =
    !r.claimed && !r.signature && !r.wire && claims === 0;
  const noObservedDelivery =
    (histories.recipientTokenAccount as unknown[]).length === 0 &&
    token === null;
  const report = {
    at: new Date().toISOString(),
    order: id,
    payment: payments,
    authorization: db
      .prepare("SELECT * FROM solana_authorizations WHERE order_id=?")
      .get(id),
    intent,
    state: r.state,
    claims,
    noLocalSubmission,
    noObservedDelivery,
    histories,
    statuses,
    health,
    outputAccount,
    outputAccountExists: token !== null,
    preparedDigest: prepared?.digest,
    approvalExpiresAt: prepared?.expiresAt,
    oldBlockhashValid: prepared
      ? await net.valid(blockhash(prepared.lifetime.blockhash))
      : null,
    signature: r.signature,
    signedWireExists: !!r.wire,
    events,
  };
  writeFileSync(
    join(root, `recovery-audit-${Date.now()}.private.json`),
    json(report),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    json({
      at: report.at,
      state: r.state,
      claims,
      noLocalSubmission,
      noObservedDelivery,
      knownSignatureCount: signatures.size,
      relayerHistorySinceOrder: (histories.relayer as unknown[]).length,
      recipientAtaHistorySinceOrder: (
        histories.recipientTokenAccount as unknown[]
      ).length,
      oldBlockhashValid: report.oldBlockhashValid,
      signedWireExists: !!r.wire,
      paymentCount: payments.length,
      confirmed: payments.every((v) => v.confirmed === 1 && v.active === 1),
      orderExpiresAt: intent.expiry,
    }),
  );
  if (
    !noLocalSubmission ||
    !noObservedDelivery ||
    signatures.size ||
    (histories.relayer as unknown[]).length
  )
    throw Error(
      "Possible prior submission: reconcile original signatures before any refresh",
    );
} finally {
  db.close();
}
