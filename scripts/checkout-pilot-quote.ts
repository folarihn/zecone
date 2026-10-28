// Operator-only creation of one exact signed checkout quote. This signs pricing
// evidence, not a transaction, and never submits or broadcasts funds.
import { createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCheckoutPilotQuoteStatement,
  signCheckoutPilotQuote,
} from "../services/payments/pilot-quote.ts";
import { fetchPilotMarketObservations } from "../services/settlement/mainnet-pilot-market.ts";
import {
  openMainnetCredential,
  readMainnetKeystore,
} from "../services/provisioning/mainnet-keystore.ts";
import {
  pilotQuoteTtlSeconds,
  singleDevicePilotActive,
  type ProductionProfile,
} from "../services/settlement/production-safety.ts";

function args() {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    if (!flag.startsWith("--") || !process.argv[i + 1]) throw Error("INVALID_ARGUMENTS");
    values.set(flag.slice(2), process.argv[i + 1]);
  }
  return values;
}
function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value || value.startsWith("--")) throw Error(`${key.replaceAll("-", "_").toUpperCase()}_REQUIRED`);
  return value;
}
function profileFor(file: string): ProductionProfile {
  const profiles = JSON.parse(readFileSync(file, "utf8")) as ProductionProfile[];
  const profile = profiles.find((p) => p.network === "base");
  if (!profile) throw Error("BASE_PROFILE_NOT_FOUND");
  return profile;
}
function rawPublicKey(pem: string) {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  return der.subarray(der.length - 32).toString("base64url");
}

async function main() {
  const values = args();
  if (values.get("confirm") !== "SIGN_CHECKOUT_PILOT_QUOTE")
    throw Error("CHECKOUT_PILOT_QUOTE_CONFIRMATION_REQUIRED");
  const profile = profileFor(resolve(required(values, "profiles")));
  const now = Math.floor(Date.now() / 1000);
  if (!singleDevicePilotActive(profile, now)) throw Error("ACTIVE_SINGLE_DEVICE_PILOT_REQUIRED");
  const ttl = pilotQuoteTtlSeconds(profile, now);
  const observations = await fetchPilotMarketObservations();
  const statement = buildCheckoutPilotQuoteStatement({
    authority: profile.executionAuthority?.identity ?? "",
    recipient: required(values, "recipient"),
    amountUsd: required(values, "amount-usd"),
    observations,
    createdAt: now,
    expiresAt: Math.min(now + ttl, profile.pilot!.expires),
    ttlSeconds: ttl,
    maximumSpreadBps: 200,
  });
  const passphrase = readFileSync(resolve(required(values, "passphrase-file")));
  let seed: Buffer | undefined;
  try {
    seed = await openMainnetCredential(
      readMainnetKeystore(resolve(required(values, "keystore"))),
      passphrase,
      "mainnet:execution-authority",
    );
    const publicPem = readFileSync(resolve(required(values, "public-key")), "utf8").trim();
    const privateKey = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x: rawPublicKey(publicPem) },
      format: "jwk",
    });
    const envelope = signCheckoutPilotQuote(statement, privateKey);
    const out = resolve(required(values, "out"));
    writeFileSync(out, JSON.stringify(envelope, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify({
      status: "CHECKOUT_PILOT_QUOTE_SIGNED",
      amountUsd: statement.amountUsd,
      recipient: statement.recipient,
      providers: statement.observations.map((o) => o.provider),
      createdAt: statement.createdAt,
      expiresAt: statement.expiresAt,
      out,
      transactionSigned: false,
      broadcast: false,
    }) + "\n");
  } finally {
    seed?.fill(0);
    passphrase.fill(0);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "CHECKOUT_PILOT_QUOTE_FAILED"}\n`);
  process.exitCode = 1;
});
