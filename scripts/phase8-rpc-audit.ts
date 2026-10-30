// Fixed, read-only historical destination evidence. No wallet/key loader.
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  EvidenceReader,
  verificationConfig,
} from "../services/execution/rpc-confidence.ts";
import { DEVNET } from "../services/solana/network.ts";
import { solanaReceiptEvidence } from "../services/solana/receipt-confidence.ts";
import { EvmAdapter } from "../services/evm/adapter.ts";
const reports: any[] = [];
for (const phase of ["phase7b", "phase7c"]) {
  const profile = JSON.parse(
    readFileSync(`.state/${phase}/profile.json`, "utf8"),
  );
  const db = new DatabaseSync(
    `.state/${phase}/${profile.id}/settlement.sqlite`,
    { readOnly: true },
  );
  const row = db
    .prepare("SELECT signature,state FROM solana_settlement")
    .get()!;
  db.close();
  if (row.state !== "COMPLETED" || typeof row.signature !== "string")
    throw Error("COMPLETED_EVIDENCE_REQUIRED");
  const config = verificationConfig("ZECONE_SOLANA_RPC", DEVNET);
  const result = await solanaReceiptEvidence(
    new EvidenceReader(config),
    row.signature,
  );
  reports.push({
    source: phase,
    network: "solana-devnet",
    secondaryConfigured: !!config.secondary,
    confidence: result.confidence,
    evidenceAvailable: !!result.evidence,
  });
}
for (const [id, file] of [
  [84532, "docs/phase3-evidence/live-verification.json"],
  [11155111, "docs/phase4a-evidence/11155111/live-verification.json"],
  [46630, "docs/phase4a-evidence/46630/live-verification.json"],
] as const) {
  const historical = JSON.parse(readFileSync(file, "utf8"));
  const adapter = new EvmAdapter(id);
  const result = await adapter.receiptEvidence(
    id === 84532 ? historical.base.hash : historical.destinationTx,
  );
  reports.push({
    network: id,
    secondaryConfigured: !!process.env[`ZECONE_EVM_${id}_RPC_SECONDARY`],
    confidence: result.confidence,
    evidenceAvailable: !!result.evidence,
  });
}
const report = {
  at: new Date().toISOString(),
  readOnly: true,
  signingCalls: 0,
  broadcastCalls: 0,
  reports,
};
writeFileSync(
  "docs/phase8c-evidence/live-confidence.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
