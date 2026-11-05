// Push only the integrated wallet's non-secret timing/binding evidence to the
// loopback operator listener. The keystore, passphrase, signed bytes and wallet
// database never leave the operator machine.
//
// npm run operator:wallet-evidence -- --remote http://127.0.0.1:14322 \
//   --token-file <protected/operator-token.txt> --wallet-journal <spend.sqlite> \
//   --order-id <pay_...> --txid <64 hex>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { httpRemote } from "./operator-sync.ts";
import {
  assessWalletEvidence,
  readWalletJournalEvidence,
} from "../services/payments/wallet-evidence.ts";

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--"))
    throw Error(`MISSING_${name.toUpperCase().replace(/-/g, "_")}`);
  return value;
}

async function main() {
  const orderId = arg("order-id"),
    txid = arg("txid").toLowerCase();
  if (!/^pay_[a-f0-9]{26}$/.test(orderId)) throw Error("ORDER_ID_INVALID");
  if (!/^[a-f0-9]{64}$/.test(txid)) throw Error("TXID_INVALID");
  const token = readFileSync(resolve(arg("token-file")), "utf8").trim();
  if (token.length < 48) throw Error("OPERATOR_TOKEN_INVALID");
  const remote = httpRemote(arg("remote"), token),
    order = (await remote.orders()).find(
      (candidate) => candidate.id === orderId,
    );
  if (!order) throw Error("REAL_ORDER_NOT_FOUND");
  const evidence = readWalletJournalEvidence(
    resolve(arg("wallet-journal")),
    txid,
  );
  const failure = assessWalletEvidence(
    { ...order, detectedTxid: txid },
    evidence,
  );
  if (failure) throw Error(`WALLET_EVIDENCE_${failure.toUpperCase()}`);
  await remote.walletEvidence(orderId, evidence!);
  process.stdout.write(
    JSON.stringify({
      ok: true,
      orderId,
      txid,
      sessionId: evidence!.sessionId,
      broadcastAttemptAt: evidence!.broadcastAttemptAt,
    }) + "\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof Error && /^[A-Z0-9_]{1,96}$/.test(error.message)
          ? error.message
          : "WALLET_EVIDENCE_PUSH_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
});
