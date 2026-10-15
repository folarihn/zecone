// Only newly generated Phase 5.2 credentials are decrypted, for an in-memory leak check.
import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { decrypt } from "../services/signer/keystore.ts";
import { validatePhase52Profile } from "../services/validation/phase52-profile.ts";
const values: Buffer[] = [];
async function main() {
  const p = validatePhase52Profile(
      JSON.parse(readFileSync(".state/phase52-profile.json", "utf8")),
    ),
    watchChecks = [];
  for (const r of p.roles) {
    for (const name of readdirSync(r.keys))
      if (lstatSync(join(r.keys, name)).isSymbolicLink())
        throw Error("linked_new_credential_file");
    const password = readFileSync(join(r.keys, "development-password.bin"));
    values.push(
      password,
      Buffer.from(password.toString("hex")),
      Buffer.from(password.toString("base64")),
    );
    for (const name of ["isolated-seed", "isolated-key"]) {
      if (existsSync(join(r.keys, `${name}.bin`)))
        throw Error("plaintext_staging_remains");
      const secret = await decrypt(
        JSON.parse(readFileSync(join(r.keys, `${name}.keystore.json`), "utf8")),
        password,
        "isolated-wallet-test",
      );
      values.push(
        secret,
        Buffer.from(secret.toString("hex")),
        Buffer.from(secret.toString("base64")),
      );
    }
    values.push(readFileSync(join(r.keys, "viewing-key.txt")));
  }
  for (const [role, path] of [
    ...p.roles.map((r) => [r.role, r.watch]),
    ["settlement-independent", p.independentSettlementWatch],
  ]) {
    const files = readdirSync(path);
    if (files.some((n) => /seed|password|keystore|isolated-key/.test(n)))
      throw Error("spending_secret_in_watch_directory");
    watchChecks.push({ role, filesContainOnlyWatchState: true });
  }
  const files = [
    ...new Set([
      ...execFileSync("git", ["diff", "--name-only", "fec8341"], {
        encoding: "utf8",
      })
        .trim()
        .split(/\r?\n/),
      ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
        encoding: "utf8",
      })
        .trim()
        .split(/\r?\n/),
    ]),
  ].filter((f) => f && existsSync(f));
  const exposed = files.filter((f) => {
    const bytes = readFileSync(f);
    return values.some((v) => bytes.includes(v));
  });
  const backend = JSON.parse(
    readFileSync(join(p.roles[1].watch, "../config.json"), "utf8"),
  );
  if (p.roles.some((r) => JSON.stringify(backend).includes(r.keys)))
    throw Error("key_path_in_backend_config");
  const report = {
    at: new Date().toISOString(),
    profileId: p.id,
    newSecretPatternsChecked: values.length,
    publishableFilesChecked: files.length,
    exposedFiles: exposed,
    watchChecks,
    backendConfigurationContainsSpendingKeyPaths: false,
    plaintextSeedFilesRetained: false,
    simulatedIsolation: true,
    separateDeviceValidated: false,
    scope:
      "New profile seed/spending-key/password encodings and UFVKs compared in memory. Same OS user can access encrypted test credentials and development passwords; this is not physical isolation.",
  };
  writeFileSync(
    "docs/phase52-evidence/credential-boundary-audit.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  if (exposed.length) process.exitCode = 1;
}
main()
  .catch(() => {
    console.error(
      "phase52_credential_boundary_audit_failed_no_secret_details_logged",
    );
    process.exitCode = 1;
  })
  .finally(() => values.forEach((v) => v.fill(0)));
