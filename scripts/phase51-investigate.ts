// Forensic reads only. Existing source DB/credentials/markers are never written.
import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
import { assessTransferRecovery } from "../services/settlement/transfer-recovery.ts";
const exec = promisify(execFile),
  out = "docs/phase51-evidence",
  source = ".secrets/user/zcash";
const sha = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
const metadata = (p: string) => {
  const s = statSync(p);
  return {
    bytes: s.size,
    created: s.birthtime.toISOString(),
    modified: s.mtime.toISOString(),
    sha256: sha(p),
  };
};
async function main() {
  mkdirSync(out, { recursive: true });
  const request = JSON.parse(
    readFileSync(".state/phase5-first-wallet-funding.json", "utf8"),
  );
  const config = JSON.parse(
      readFileSync(".state/phase5-refund-validation.json", "utf8"),
    ),
    payer = config.roles.find((r: any) => r.role === "payer");
  if (
    !payer ||
    request.network !== "zcash-testnet" ||
    !/^([a-z0-9-]{36})$/.test(request.requestId)
  )
    throw Error("private_config_invalid");
  const marker = join(source, `request-${request.requestId}.started.json`),
    saved = join(source, `request-${request.requestId}.json`),
    lock = join(source, "process.lock");
  const sourceDb = join(source, "wallet.sqlite"),
    before = {
      database: sha(sourceDb),
      marker: existsSync(marker) ? sha(marker) : null,
      lock: existsSync(lock) ? sha(lock) : null,
    };
  const started = existsSync(marker)
    ? JSON.parse(readFileSync(marker, "utf8"))
    : null;
  const binding =
    !!started &&
    ["account", "recipient", "zatoshis"].every(
      (k) => started[k] === request[k],
    );
  const validate = await exec(
    resolve("target/debug/zecone-zcash.exe"),
    [
      "--wallet",
      resolve(".state/offline-validation-unused"),
      "validate-address",
      "--address",
      request.recipient,
    ],
    { windowsHide: true, maxBuffer: 4096, timeout: 30000 },
  );
  const addressValidation = JSON.parse(validate.stdout);
  const db = new DatabaseSync(sourceDb, { readOnly: true });
  const txs = db
    .prepare(
      "SELECT txid,created,mined_height,expiry_height,fee,target_height,confirmed_unmined_at_height,length(raw) rawBytes FROM transactions ORDER BY id_tx",
    )
    .all() as any[];
  const history = txs.map((t) => ({
    ...t,
    txid: Buffer.from(t.txid).reverse().toString("hex"),
  }));
  const matches = db
    .prepare(
      "SELECT t.txid,t.mined_height,t.expiry_height,length(t.raw) rawBytes FROM sent_notes s JOIN transactions t ON t.id_tx=s.transaction_id WHERE s.to_address=? AND s.value=?",
    )
    .all(request.recipient, Number(request.zatoshis)) as any[];
  const noteState = ["sapling", "orchard", "ironwood"].map((pool) => ({
    pool,
    unspentInStoredDatabase: db
      .prepare(
        `SELECT count(*) count,coalesce(sum(n.value),0) zatoshis FROM ${pool}_received_notes n LEFT JOIN ${pool}_received_note_spends s ON s.${pool}_received_note_id=n.id WHERE s.transaction_id IS NULL`,
      )
      .get(),
    spendLinks: db
      .prepare(`SELECT count(*) count FROM ${pool}_received_note_spends`)
      .get(),
  }));
  const scan = db.prepare("SELECT max(height) height FROM blocks").get();
  const lockedInputs = db
    .prepare(
      "SELECT count(*) count FROM ironwood_received_notes WHERE lock_owner IS NOT NULL OR lock_expiry_height IS NOT NULL",
    )
    .get();
  db.close();
  let lockProcess = "not-recorded";
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) lockProcess = "invalid-pid";
    else
      try {
        process.kill(pid, 0);
        lockProcess = "pid-exists-owner-not-verified";
      } catch (e: any) {
        lockProcess = e.code === "ESRCH" ? "pid-absent" : "owner-unverifiable";
      }
  }
  const scans = [];
  for (const role of ["payer", "settlement-refund-signer"]) {
    const r = config.roles.find((r: any) => r.role === role);
    if (!r) throw Error("missing_disposable_role");
    try {
      const s = await new WatchOnlyZcash(r.watch).observe();
      scans.push({
        role,
        status: "scanned",
        tip: s.tip,
        scanned: s.scanned,
        blockHash: s.blockHash,
        observedAt: s.observedAt,
        address: s.address,
        addressMatchesFundingRequest:
          role === "payer" ? s.address === request.recipient : null,
        payments: s.payments.map((p) => ({
          txid: p.txid,
          zatoshis: p.zatoshis,
          height: p.height,
          confirmations: s.tip - p.height + 1,
        })),
        totalReceivedZatoshis: s.payments
          .reduce((n, p) => n + BigInt(p.zatoshis), 0n)
          .toString(),
        source: s.source,
      });
    } catch {
      scans.push({ role, status: "unavailable-no-settlement-evidence" });
    }
  }
  const payerScan = scans.find(
    (s) => s.role === "payer" && s.status === "scanned",
  );
  const after = {
    database: sha(sourceDb),
    marker: existsSync(marker) ? sha(marker) : null,
    lock: existsSync(lock) ? sha(lock) : null,
  };
  const sourceUnchanged = JSON.stringify(before) === JSON.stringify(after);
  if (!sourceUnchanged)
    throw Error("source_changed_during_read_only_investigation");
  const savedRecord = existsSync(saved)
    ? JSON.parse(readFileSync(saved, "utf8"))
    : null;
  const exact =
    payerScan?.payments?.filter((p) => p.zatoshis === request.zatoshis) ?? [];
  const candidate = matches.length === 1 ? matches[0] : null;
  const assessment = payerScan
    ? assessTransferRecovery(
        {
          network: request.network,
          requestBindingMatches:
            binding && payerScan.addressMatchesFundingRequest === true,
          constructionMarker: existsSync(marker),
          savedTxid: savedRecord?.txid ?? null,
          rawTransactionPersisted: !!candidate?.rawBytes,
          expiryHeight: candidate?.expiry_height ?? null,
          tip: payerScan.tip!,
          scanned: payerScan.scanned!,
          observedAt: payerScan.observedAt!,
          sourceMatches: matches.length,
          matchingReceipt:
            exact.length === 1
              ? {
                  txid: exact[0].txid,
                  height: exact[0].height,
                  exactDestinationAndAmount: true,
                }
              : null,
          providerStatus: "unknown",
        },
        Math.floor(Date.now() / 1000),
      )
    : {
        status: "recipient-scan-unavailable",
        replacementAuthorized: false,
        broadcastAuthorized: false,
        markersMayBeCleared: false,
      };
  const report = {
    at: new Date().toISOString(),
    checkpoint: "6975598",
    network: "zcash-testnet",
    requestId: request.requestId,
    requestedZatoshis: request.zatoshis,
    feeCapZatoshis: request.maxFeeZatoshis,
    recipient: request.recipient,
    addressValidation,
    constructionMarker: existsSync(marker) ? metadata(marker) : null,
    markerBindingMatches: binding,
    savedTransactionReferencePresent: existsSync(saved),
    lockProcess,
    sourceDatabase: {
      readOnly: true,
      unchangedDuringInvestigation: sourceUnchanged,
      scan,
      transactions: history,
      matchingOutgoingRecords: matches.length,
      lockedIronwoodInputs: lockedInputs,
      noteState,
      spendability:
        "stored-state-only-not-a-fresh-native-balance-or-input-selection",
    },
    recipientScans: scans,
    assessment,
    expiryHeightForInterruptedRequest: candidate?.expiry_height ?? null,
    provingLogAvailable: false,
    broadcastRecordForRequestAvailable: !!savedRecord,
    artifactNames: readdirSync(source).filter((n) =>
      n.includes(request.requestId),
    ),
    caveat:
      "Construction marker predates create_proposed_transactions; persisted reference precedes broadcast in source. No transaction identity/expiry/input selection survived for this request. Missing records alone are not proof of non-broadcast or expiry.",
    originalMarkersChanged: false,
    replacementPrepared: false,
    replacementBroadcast: false,
    liveRefundsEnabled: false,
    separateDeviceValidated: false,
  };
  const name = `investigation-${new Date().toISOString().replaceAll(":", "-")}.json`;
  writeFileSync(join(out, name), JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify(
      {
        report: join(out, name),
        assessment,
        scans: scans.map((s) => ({
          role: s.role,
          status: s.status,
          tip: s.tip,
          receipts: s.payments?.length,
        })),
        sourceUnchanged,
      },
      null,
      2,
    ),
  );
}
main().catch(() => {
  console.error(
    "phase51_read_only_investigation_failed_no_secret_details_logged",
  );
  process.exitCode = 1;
});
