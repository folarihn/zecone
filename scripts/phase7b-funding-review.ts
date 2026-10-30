// Read original recovery metadata only. Never opens/syncs the original wallet.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
import { json } from "../services/solana/network.ts";
const exec = promisify(execFile),
  request = JSON.parse(
    readFileSync(".state/phase5-first-wallet-funding.json", "utf8"),
  ),
  config = JSON.parse(
    readFileSync(".state/phase5-refund-validation.json", "utf8"),
  );
const payer = config.roles.find((r: any) => r.role === "payer");
const source = resolve(".secrets/user/zcash"),
  saved = join(source, `request-${request.requestId}.json`);
const root = resolve(".state/phase7b", `original-review-${Date.now()}`);
mkdirSync(root, { recursive: true });
const original = JSON.parse(
  readFileSync(join(payer.watch, "watch-only.json"), "utf8"),
);
const watch = join(root, "recipient-watch");
await exec(
  resolve("target/debug/zecone-zcash-watch.exe"),
  [
    "--wallet",
    watch,
    "import",
    "--ufvk-file",
    resolve(payer.watch, "viewing-key.txt"),
    "--birthday",
    String(original.birthday),
  ],
  { windowsHide: true, timeout: 180000, maxBuffer: 1048576 },
);
let observation: any;
try {
  const s = await new WatchOnlyZcash(watch).observe();
  observation = {
    tip: s.tip,
    scanned: s.scanned,
    addressMatches: s.address === request.recipient,
    receipts: s.payments.map((p) => ({
      txid: p.txid,
      zatoshis: p.zatoshis,
      confirmations: s.tip - p.height + 1,
    })),
    source: s.source,
  };
} catch {
  observation = { status: "recipient-scan-unavailable" };
}
const report = {
  at: new Date().toISOString(),
  requestId: request.requestId,
  sourceWalletOpened: false,
  sourceWalletModified: false,
  transactionReferenceRecovered: existsSync(saved),
  observation,
  replacementAuthorized: false,
  markersMayBeCleared: false,
  reason:
    "An absent saved transaction reference and missing selected-input/raw/expiry evidence prevent safe original-wallet replacement. Recipient observations alone cannot identify the interrupted spend.",
};
writeFileSync(
  "docs/phase7b-evidence/original-wallet-review.json",
  json(report),
);
console.log(json(report));
