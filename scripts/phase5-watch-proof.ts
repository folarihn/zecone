// Read-only real testnet proof. Never imports, opens or modifies existing wallet credentials.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
import { writeVerifiedKeystore } from "../services/signer/keystore.ts";
const exec = promisify(execFile),
  ext = process.platform === "win32" ? ".exe" : "";
const configPath = ".state/phase5-watch-proof.json";
async function main() {
  const create = process.argv.includes("--create-isolated");
  if (create) {
    if (existsSync(configPath))
      throw Error("isolated_proof_already_exists_use_resume");
    const id = randomUUID(),
      state = resolve(".state/phase5-watch", id),
      secrets = resolve(".secrets/phase5-watch", id);
    mkdirSync(state, { recursive: true, mode: 0o700 });
    mkdirSync(secrets, { recursive: true, mode: 0o700 });
    const keys = join(secrets, "signer");
    await exec(resolve(`target/debug/provision-watch-test${ext}`), [keys], {
      windowsHide: true,
      timeout: 30000,
    });
    const password = randomBytes(32);
    // Development-only recovery password is local, never exposed to either scanner.
    writeFileSync(join(keys, "development-password.bin"), password, {
      flag: "wx",
      mode: 0o600,
    });
    try {
      for (const name of ["isolated-seed", "isolated-key"]) {
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
        // Only these newly generated plaintext staging files, after decrypt verification.
        unlinkSync(join(keys, `${name}.bin`));
      }
    } finally {
      password.fill(0);
    }
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        keys,
        backend: join(state, "backend-watch"),
        signer: join(state, "signer-watch"),
      }),
      { flag: "wx", mode: 0o600 },
    );
  }
  if (!existsSync(configPath)) throw Error("create_isolated_proof_first");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  let birthday: number | undefined;
  for (const path of [config.backend, config.signer]) {
    if (!existsSync(path)) {
      const args = [
        "--wallet",
        path,
        "import",
        "--ufvk-file",
        join(config.keys, "viewing-key.txt"),
      ];
      if (birthday !== undefined) args.push("--birthday", String(birthday));
      const { stdout } = await exec(
        resolve(`target/debug/zecone-zcash-watch${ext}`),
        args,
        { windowsHide: true, timeout: 180000, maxBuffer: 4096 },
      );
      birthday = JSON.parse(stdout).birthday;
    } else {
      birthday = JSON.parse(
        readFileSync(join(path, "watch-only.json"), "utf8"),
      ).birthday;
    }
  }
  const backend = await new WatchOnlyZcash(config.backend).observe();
  const signer = await new WatchOnlyZcash(config.signer).observe();
  if (
    backend.account !== signer.account ||
    backend.birthday !== signer.birthday
  )
    throw Error("independent_watch_identity_mismatch");
  if (
    backend.tip === signer.tip &&
    (backend.blockHash !== signer.blockHash ||
      backend.native.anchor !== signer.native.anchor)
  )
    throw Error("independent_scan_disagreement");
  const summarize = (s: typeof signer) => ({
    tip: s.tip,
    scanned: s.scanned,
    blockHash: s.blockHash,
    ironwoodAnchor: s.native.anchor,
    anchorHeight: s.native.anchorHeight,
    observedAt: s.observedAt,
    detectedPayments: s.payments.length,
    confirmedPayments: s.payments.filter((p) => s.tip - p.height + 1 >= 10)
      .length,
    unspentIronwoodInputs: s.native.inputs.length,
  });
  const report = {
    at: new Date().toISOString(),
    network: "zcash-testnet",
    source: signer.source,
    realChainRead: true,
    synthetic: false,
    receivingAddress: backend.address,
    signerLocalDiversifiedAddress: signer.address,
    viewingKeyFingerprint: signer.account,
    birthday: signer.birthday,
    backend: summarize(backend),
    independentSigner: summarize(signer),
    independentDatabases: true,
    independentInfrastructureProviders: false,
    trust:
      "Both local scanners independently fetch and decrypt the same public lightwalletd feed. No consensus-node or separate-device validation has been claimed.",
    liveRefundsEnabled: false,
    transactionSigned: false,
    broadcast: false,
  };
  writeFileSync(
    "docs/phase5-evidence/watch-only-real-chain.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
main().catch(() => {
  console.error(
    "watch_proof_failed_no_live_refund; inspect new isolated state and rerun without --create-isolated; no key data logged",
  );
  process.exitCode = 1;
});
