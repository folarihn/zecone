import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  inspectMainnetConfiguration,
  type ConfigFinding,
} from "../services/settlement/mainnet-config-validation.ts";
import { relayerFromSigner } from "../services/settlement/mainnet-address.ts";

const pem = (type: "ed25519" | "secp256k1") =>
  String(
    (type === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("ec", { namedCurve: "secp256k1" })
    ).publicKey.export({ format: "pem", type: "spki" }),
  );
const solanaAccount = () => {
  const publicKey = pem("ed25519");
  return { publicKey, address: relayerFromSigner("solana", publicKey) };
};
const codes = (findings: ConfigFinding[]) => findings.map((f) => f.code);
const provider = (name: string) => ({
  endpoint: `https://${name}.provider.net`,
  operator: name,
});
const solanaProfile = () => {
  const signer = solanaAccount(),
    recipient = solanaAccount(),
    authority = pem("ed25519"),
    a = pem("ed25519"),
    b = pem("ed25519");
  return {
    network: "solana",
    enabled: true,
    providers: [provider("rpc-a"), provider("rpc-b")],
    independenceAcknowledged: true,
    relayer: signer.address,
    recipients: [recipient.address],
    perTransaction: "1010000",
    daily: "2020000",
    feeCap: "10000",
    confirmations: 1,
    signer: {
      identity: "offline-signer",
      publicKey: signer.publicKey,
      transport: "offline-bundle",
      separateDeviceValidated: true,
      attestationReference: "attestation-1",
    },
    executionAuthority: {
      identity: "execution-authority",
      publicKey: authority,
      separateDeviceValidated: true,
      attestationReference: "attestation-2",
    },
    priceAuthorities: [
      { operator: "price-a", publicKey: a },
      { operator: "price-b", publicKey: b },
    ],
  };
};
const readOnly = () => ({
  mode: "READ_ONLY",
  paymentsEnabled: false,
  signingEnabled: false,
  broadcastEnabled: false,
  refundsEnabled: false,
  networks: {
    zcash: {
      network: "mainnet",
      lightwalletd: "https://zcash-a.provider.net",
      independentNode: "https://zcash-b.provider.net",
    },
    base: {
      chainId: 8453,
      productionPrimary: "https://base-a.provider.net",
      productionSecondary: "https://base-b.provider.net",
    },
    solana: {
      genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      productionPrimary: "https://sol-a.provider.net",
      productionSecondary: "https://sol-b.provider.net",
    },
  },
  productionKeyReferences: { signer: "external-reference-only" },
  executionLimits: { perTransaction: "1010000" },
});
const blockedProfiles = () => [
  {
    network: "zcash",
    enabled: false,
    providers: [],
    independenceAcknowledged: false,
    recipients: [],
    perTransaction: "100000",
    daily: "100000",
    feeCap: "10000",
    confirmations: 20,
  },
  {
    network: "base",
    enabled: false,
    providers: [],
    independenceAcknowledged: false,
    recipients: [],
    perTransaction: "100000000000000",
    daily: "100000000000000",
    feeCap: "10000000000000",
    confirmations: 1,
  },
];

test("disabled production template stays blocked and read-only config cannot activate it", () => {
  const report = inspectMainnetConfiguration({
    profiles: JSON.parse(
      readFileSync("config/mainnet-profiles.production.example.json", "utf8"),
    ),
    readOnly: JSON.parse(
      readFileSync("config/mainnet-readonly.example.json", "utf8"),
    ),
  });
  assert.equal(report.configurationReady, false);
  assert.equal(report.executionAvailable, false);
  assert.equal(report.profiles.length, 3);
  assert.ok(report.profiles.every((p) => p.status === "BLOCKED"));
  assert.ok(
    report.profiles.every((p) =>
      codes(p.findings).includes("PROFILE_DISABLED"),
    ),
  );
  assert.ok(
    report.profiles.every((p) =>
      codes(p.findings).includes("PLACEHOLDER_OR_INSECURE_PROVIDER"),
    ),
  );
  assert.ok(
    codes(report.readOnly.findings).includes(
      "READ_ONLY_PRODUCTION_PROVIDERS_REQUIRED",
    ),
  );
});

test("a complete destination profile passes inspection without making execution available", () => {
  const report = inspectMainnetConfiguration({
    profiles: [...blockedProfiles(), solanaProfile()],
    readOnly: readOnly(),
  });
  assert.equal(
    report.profiles.find((p) => p.network === "solana")?.status,
    "PASS",
  );
  assert.equal(report.readOnly.status, "PASS");
  assert.equal(report.configurationReady, false);
  assert.equal(report.executionAvailable, false);
});

test("address, signer binding and price-authority errors fail closed", () => {
  const p = solanaProfile();
  p.recipients = ["11111111111111111111111111111111"];
  p.signer.publicKey = solanaAccount().publicKey;
  p.priceAuthorities[1] = {
    operator: "price-a",
    publicKey: p.priceAuthorities[0].publicKey,
  };
  const report = inspectMainnetConfiguration({
    profiles: [...blockedProfiles(), p],
    readOnly: readOnly(),
  });
  const findings = codes(
    report.profiles.find((x) => x.network === "solana")!.findings,
  );
  assert.ok(findings.includes("INVALID_RECIPIENT_ADDRESS"));
  assert.ok(findings.includes("SIGNER_RELAYER_MISMATCH"));
  assert.ok(findings.includes("INDEPENDENT_PRICE_AUTHORITIES_REQUIRED"));
  assert.equal(report.configurationReady, false);
});

test("read-only spending switches and duplicate profiles fail validation", () => {
  const read = readOnly();
  read.signingEnabled = true;
  const report = inspectMainnetConfiguration({
    profiles: [...blockedProfiles(), solanaProfile(), solanaProfile()],
    readOnly: read,
  });
  assert.equal(report.extraProfiles, 0);
  assert.ok(
    codes(report.readOnly.findings).includes(
      "SPENDING_SWITCH_MUST_BE_DISABLED",
    ),
  );
  assert.equal(report.readOnly.status, "FAIL");
  assert.equal(report.configurationReady, false);
});
