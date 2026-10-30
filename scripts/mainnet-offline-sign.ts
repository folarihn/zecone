// Network-free mainnet bundle signer. Run only on the separately validated
// signing device. It reads reviewed unsigned bytes and writes one signed bundle;
// it never calls an RPC, submits a transaction, or prints signed bytes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exclusiveJson } from "../services/execution/io.ts";
import {
  MainnetOfflineSigner,
  type MainnetSignerLimits,
  type MainnetSigningApproval,
} from "../services/settlement/mainnet-signer.ts";
import {
  preparedDigest,
  termsDigest,
  type MainnetPrepared,
  type MainnetTransferTerms,
} from "../services/settlement/mainnet-transfer.ts";
import {
  validateProductionProfile,
  type ProductionProfile,
} from "../services/settlement/production-safety.ts";

type Plan = {
  version: 1;
  network: "base" | "solana";
  profile: ProductionProfile;
  terms: MainnetTransferTerms;
  termsDigest: string;
  prepared?: MainnetPrepared;
};

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function argumentsMap() {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (!key.startsWith("--") || !process.argv[i + 1])
      throw Error("INVALID_ARGUMENTS");
    values.set(key.slice(2), process.argv[++i]);
  }
  return values;
}

function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value || value.startsWith("--"))
    throw Error(`${key.replaceAll("-", "_").toUpperCase()}_REQUIRED`);
  return value;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(file), "utf8")) as T;
}

async function main() {
  const values = argumentsMap(),
    plan = readJson<Plan>(required(values, "plan")),
    profiles = readJson<ProductionProfile[]>(required(values, "profiles")),
    current = profiles.find((profile) => profile.network === plan.network),
    approval = readJson<MainnetSigningApproval>(required(values, "approval")),
    output = resolve(required(values, "out"));
  if (values.get("arm") !== "SIGN_EXACT_MAINNET_BUNDLE")
    throw Error("EXPLICIT_OFFLINE_SIGNER_ARM_REQUIRED");
  if (!plan || plan.version !== 1 || !plan.prepared || !current)
    throw Error("INVALID_MAINNET_SIGNING_PLAN");
  const profile = validateProductionProfile(current);
  if (profile.network !== "base" && profile.network !== "solana")
    throw Error("DESTINATION_SIGNER_PROFILE_REQUIRED");
  if (!profile.enabled) throw Error("MAINNET_PROFILE_DISABLED");
  if (
    digest(profile) !== digest(plan.profile) ||
    plan.terms.profileDigest !== digest(profile) ||
    plan.termsDigest !== termsDigest(plan.terms) ||
    plan.prepared.termsDigest !== plan.termsDigest ||
    approval.termsDigest !== plan.termsDigest ||
    approval.preparedDigest !== preparedDigest(plan.prepared) ||
    required(values, "confirm") !== approval.preparedDigest
  )
    throw Error("EXACT_OFFLINE_SIGNING_REVIEW_REQUIRED");

  const signer = await MainnetOfflineSigner.open({
    profile,
    keystorePath: resolve(required(values, "keystore")),
    passphrasePath: resolve(required(values, "passphrase-file")),
    limits: {
      perTransaction: profile.perTransaction,
      daily: profile.daily,
    } as MainnetSignerLimits,
    ledgerPath: resolve(required(values, "signer-ledger")),
  });
  try {
    const bundle = await signer.sign(plan.terms, plan.prepared, approval);
    exclusiveJson(output, bundle);
    process.stdout.write(
      JSON.stringify({
        status: "SIGNED_BUNDLE_WRITTEN",
        network: bundle.network,
        termsDigest: bundle.termsDigest,
        preparedDigest: bundle.preparedDigest,
        output,
        signedBytesPrinted: false,
        broadcast: false,
      }) + "\n",
    );
  } finally {
    signer.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  process.stderr.write(
    JSON.stringify({
      error: /^[A-Z0-9_]{1,96}$/.test(message)
        ? message
        : "OFFLINE_SIGNING_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
});
