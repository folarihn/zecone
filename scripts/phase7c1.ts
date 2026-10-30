// Phase 7C.1 has no signing or broadcast command. Rehearsal uses a consistent DB backup.
import { backup, DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../services/execution/store.ts";
import {
  SolanaSettlement,
  SolanaSettlementNetwork,
} from "../services/solana/settlement.ts";
import { CpmmPolicy } from "../services/solana/cpmm.ts";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
import {
  reviewUnsignedRpcRecovery,
  recoveryRecord,
} from "../services/solana/paid-recovery.ts";
import {
  economicReview,
  checkEconomicReview,
} from "../services/solana/swap-approval.ts";
import { json } from "../services/solana/network.ts";
const command = process.argv[2];
if (!["rehearsal", "terms", "ready"].includes(command))
  throw Error(
    "Use rehearsal, terms, or ready <terms-digest>; all are unsigned",
  );
const profile = JSON.parse(readFileSync(".state/phase7c/profile.json", "utf8"));
const root = resolve(".state/phase7c", profile.id);
const id = "0xb656c980c5f010466cbdb18ce8dd005da19be2708ab1235c34892f6a3ef4e26a";
const original = new DatabaseSync(join(root, "settlement.sqlite"), {
  readOnly: true,
});
const before = original
  .prepare("SELECT * FROM solana_settlement WHERE order_id=?")
  .get(id)!;
if (
  !before ||
  before.claimed ||
  before.signature ||
  before.wire ||
  before.receipt
)
  throw Error("Prior execution must be reconciled");
let file = join(root, "settlement.sqlite");
if (command === "rehearsal") {
  const dir = join(root, "rpc-rehearsals");
  mkdirSync(dir, { recursive: true });
  file = join(dir, `${Date.now()}.sqlite`);
  await backup(original, file);
}
original.close();
const store = new Store(file),
  network = new SolanaSettlementNetwork(),
  policy = new CpmmPolicy(network.net),
  service = new SolanaSettlement(store, network, undefined, policy);
network.send = async () => {
  throw Error("PHASE7C1_BROADCAST_DISABLED");
};
service.execute = async () => {
  throw Error("PHASE7C1_SIGNING_DISABLED");
};
try {
  const snapshot = await new WatchOnlyZcash(
    join(root, "settlement-watch"),
  ).observe();
  if (
    command === "rehearsal" ||
    (command === "terms" && process.argv.includes("--review-unsigned-rpc"))
  )
    await reviewUnsignedRpcRecovery(
      service,
      id,
      String(recoveryRecord(service, id)!.attempt_id),
      true,
      snapshot,
    );
  else service.authorize(id, snapshot);
  if (command === "terms") {
    console.log(
      json({
        ...economicReview(service, id),
        obtainedBlockhash: false,
        signing: false,
        broadcast: false,
      }),
    );
  } else {
    const terms =
      command === "rehearsal"
        ? economicReview(service, id)
        : { termsDigest: process.argv[3] };
    checkEconomicReview(service, id, terms.termsDigest);
    const prepared = await service.prepare(id);
    const raw = {
      at: new Date().toISOString(),
      orderId: id,
      prepared,
      originalPaymentRetained: true,
      signing: false,
      broadcast: false,
      rehearsalOnly: command === "rehearsal",
      diagnostics: network.net.diagnostics,
      blockhashRemainingAtSimulation: (prepared as any)
        .blockhashRemainingAtSimulation,
    };
    writeFileSync(
      join(root, `rpc-prepared-${Date.now()}.private.json`),
      json(raw),
      { flag: "wx", mode: 0o600 },
    );
    const report = {
      at: raw.at,
      rehearsalOnly: raw.rehearsalOnly,
      originalDurableState: before.state,
      originalPaymentRetained: true,
      originalRecipientAndLimitsRetained: true,
      simulation: prepared.simulation,
      estimatedFee: prepared.fee,
      signing: false,
      broadcast: false,
      keysLoaded: false,
      blockhashRemainingAtSimulation: (prepared as any)
        .blockhashRemainingAtSimulation,
      liveRefundsEnabled: false,
      diagnostics: network.net.diagnostics,
    };
    writeFileSync("docs/phase7c-evidence/rpc-rehearsal.json", json(report));
    console.log(
      json(
        command === "rehearsal"
          ? report
          : {
              ...report,
              digest: prepared.digest,
              lifetime: prepared.lifetime,
              quoteExpiresAt: (prepared as any).quoteExpiresAt,
              approvalExpiresAt: (prepared as any).approvalExpiresAt,
            },
      ),
    );
  }
} finally {
  store.close();
}
