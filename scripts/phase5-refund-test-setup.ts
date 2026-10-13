// New disposable credentials only. This is simulated isolation on one Windows account.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { writeVerifiedKeystore } from "../services/signer/keystore.ts";
const exec = promisify(execFile),
  ext = process.platform === "win32" ? ".exe" : "";
const configPath = ".state/phase5-refund-validation.json";
async function main() {
  if (!existsSync(configPath)) {
    const id = randomUUID(),
      state = resolve(".state/phase5-refund-validation", id),
      secrets = resolve(".secrets/phase5-refund-validation", id);
    mkdirSync(state, { recursive: true, mode: 0o700 });
    mkdirSync(secrets, { recursive: true, mode: 0o700 });
    const roles = [];
    for (const role of [
      "payer",
      "settlement-refund-signer",
      "refund-destination",
    ]) {
      const keys = join(secrets, role),
        watch = join(state, role);
      await exec(resolve(`target/debug/provision-watch-test${ext}`), [keys], {
        windowsHide: true,
        timeout: 30000,
      });
      const password = randomBytes(32);
      writeFileSync(join(keys, "development-password.bin"), password, {
        flag: "wx",
        mode: 0o600,
      });
      try {
        for (const name of ["isolated-key", "isolated-seed"]) {
          const raw = readFileSync(join(keys, `${name}.bin`));
          try {
            await writeVerifiedKeystore(
              join(keys, `${name}.keystore.json`),
              raw,
              password,
              "isolated-wallet-test",
            );
          } finally {
            raw.fill(0);
          }
          unlinkSync(join(keys, `${name}.bin`));
        }
      } finally {
        password.fill(0);
      }
      roles.push({ role, keys, watch });
    }
    writeFileSync(
      configPath,
      JSON.stringify({ version: 1, simulatedIsolation: true, roles }),
      { flag: "wx", mode: 0o600 },
    );
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")),
    addresses = [];
  for (const r of config.roles) {
    if (!existsSync(r.watch))
      await exec(
        resolve(`target/debug/zecone-zcash-watch${ext}`),
        [
          "--wallet",
          r.watch,
          "import",
          "--ufvk-file",
          join(r.keys, "viewing-key.txt"),
        ],
        { windowsHide: true, timeout: 180000, maxBuffer: 4096 },
      );
    const m = JSON.parse(
      readFileSync(join(r.watch, "watch-only.json"), "utf8"),
    );
    addresses.push({
      role: r.role,
      address: m.address,
      viewingKeyFingerprint: m.keyId,
      birthday: m.birthday,
    });
  }
  const report = {
    at: new Date().toISOString(),
    network: "zcash-testnet",
    simulatedIsolation: true,
    separateDeviceValidated: false,
    addresses,
    plannedPaymentZatoshis: "100000",
    plannedRefundZatoshis: "90000",
    assumedPaymentFeeZatoshis: "10000",
    assumedRefundFeeZatoshis: "10000",
    minimumPayerFundingZatoshis: "110000",
    suggestedPayerFundingZatoshis: "200000",
    feeAssumptions:
      "One mature Ironwood input, two logical actions per transaction under pinned ZIP-317. Recompute actual proposal fees after funding; extra notes/actions can increase fees. Shielded funding only; no transparent shielding budget included.",
    fundsMoved: false,
    liveRefundSigningEnabled: false,
    liveBroadcastEnabled: false,
  };
  writeFileSync(
    "docs/phase5-evidence/completion-test-wallets.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
main().catch(() => {
  console.error("isolated_setup_failed_no_secret_details_logged");
  process.exitCode = 1;
});
