// Read-only production configuration inspection. It never opens a keystore,
// signs, submits, or treats a declaration as an attestation.
import { createPublicKey } from "node:crypto";
import {
  mainnetAddress,
  relayerFromSigner,
  SOLANA_MAINNET_GENESIS,
} from "./mainnet-address.ts";

type FindingStatus = "PASS" | "BLOCKED" | "FAIL";
export type ConfigFinding = {
  code: string;
  status: FindingStatus;
  detail?: string;
};
type Network = "zcash" | "base" | "solana";
type Json = Record<string, unknown>;
const networks: Network[] = ["zcash", "base", "solana"];
const keyBytes = (value: string) =>
  createPublicKey(value)
    .export({ format: "der", type: "spki" })
    .toString("hex");
const text = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0;
const integer = (value: unknown): bigint | null =>
  typeof value === "string" && /^[1-9][0-9]{0,30}$/.test(value)
    ? BigInt(value)
    : null;
const placeholder = (value: string) => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host.endsWith(".invalid") ||
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".test") ||
      host.endsWith(".example")
    );
  } catch {
    return true;
  }
};
const status = (findings: ConfigFinding[]): FindingStatus =>
  findings.some((f) => f.status === "FAIL")
    ? "FAIL"
    : findings.some((f) => f.status === "BLOCKED")
      ? "BLOCKED"
      : "PASS";
const push = (
  findings: ConfigFinding[],
  code: string,
  state: FindingStatus,
  detail?: string,
) => findings.push({ code, status: state, ...(detail ? { detail } : {}) });

function inspectProviders(p: Json, findings: ConfigFinding[]) {
  const providers = p.providers;
  if (!Array.isArray(providers) || providers.length !== 2) {
    push(findings, "TWO_INDEPENDENT_PROVIDERS_REQUIRED", "BLOCKED");
    return;
  }
  const hosts = new Set<string>(),
    operators = new Set<string>();
  for (const [index, value] of providers.entries()) {
    const provider = value as Json;
    if (
      !provider ||
      typeof provider !== "object" ||
      !text(provider.endpoint) ||
      !text(provider.operator)
    ) {
      push(findings, "INVALID_PROVIDER", "FAIL", `provider-${index + 1}`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(provider.endpoint as string);
    } catch {
      push(findings, "INVALID_PROVIDER", "FAIL", `provider-${index + 1}`);
      continue;
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      placeholder(url.href)
    )
      push(
        findings,
        "PLACEHOLDER_OR_INSECURE_PROVIDER",
        "BLOCKED",
        `provider-${index + 1}`,
      );
    const operator = String(provider.operator).trim().toLowerCase(),
      host = url.hostname.toLowerCase();
    if (hosts.has(host) || operators.has(operator))
      push(findings, "PROVIDER_INDEPENDENCE_REQUIRED", "FAIL");
    hosts.add(host);
    operators.add(operator);
  }
  if (p.independenceAcknowledged !== true)
    push(findings, "PROVIDER_INDEPENDENCE_NOT_ACKNOWLEDGED", "BLOCKED");
}

function inspectLimits(p: Json, network: Network, findings: ConfigFinding[]) {
  const per = integer(p.perTransaction),
    daily = integer(p.daily),
    fee = integer(p.feeCap);
  if (per === null || daily === null || fee === null)
    push(findings, "INVALID_FINANCIAL_LIMIT", "FAIL");
  else if (per > daily || fee >= per)
    push(findings, "INVALID_FINANCIAL_LIMIT", "FAIL");
  if (
    !Number.isSafeInteger(p.confirmations) ||
    (p.confirmations as number) < (network === "zcash" ? 20 : 1)
  )
    push(findings, "CONFIRMATION_POLICY", "FAIL");
}

function pilotActive(p: Json): boolean {
  const pilot = p.pilot as Json | undefined;
  return (
    !!pilot &&
    pilot.enabled === true &&
    pilot.isolation === "single-device-process-isolation" &&
    text(pilot.operator) &&
    text(pilot.riskAccepted) &&
    Number.isSafeInteger(pilot.expires) &&
    (pilot.expires as number) > Math.floor(Date.now() / 1000)
  );
}

function inspectPilot(p: Json, findings: ConfigFinding[]) {
  if (p.pilot === undefined) return;
  if (!pilotActive(p))
    push(findings, "SINGLE_DEVICE_PILOT_INVALID_OR_EXPIRED", "BLOCKED");
  else
    push(
      findings,
      "SINGLE_DEVICE_PILOT_ACTIVE",
      "PASS",
      `expires=${String((p.pilot as Json).expires)}`,
    );
}

function inspectSigner(
  p: Json,
  network: "base" | "solana",
  relayer: string | null,
  findings: ConfigFinding[],
) {
  const signer = p.signer as Json | undefined,
    pilot = pilotActive(p);
  if (
    !signer ||
    signer.transport !== "offline-bundle" ||
    (pilot
      ? signer.separateDeviceValidated !== false
      : signer.separateDeviceValidated !== true) ||
    !text(signer.identity) ||
    !text(signer.attestationReference) ||
    !text(signer.publicKey)
  ) {
    push(findings, "SEPARATE_DEVICE_SIGNER_REQUIRED", "BLOCKED");
    return;
  }
  try {
    const key = createPublicKey(signer.publicKey as string),
      jwk = key.export({ format: "jwk" }) as JsonWebKey,
      valid =
        network === "base"
          ? key.asymmetricKeyType === "ec" && jwk.crv === "secp256k1"
          : key.asymmetricKeyType === "ed25519";
    if (!valid)
      push(
        findings,
        network === "base"
          ? "SECP256K1_SIGNER_REQUIRED"
          : "ED25519_SIGNER_REQUIRED",
        "FAIL",
      );
    else if (
      relayer &&
      relayerFromSigner(network, signer.publicKey as string) !== relayer
    )
      push(findings, "SIGNER_RELAYER_MISMATCH", "FAIL");
  } catch {
    push(findings, "INVALID_SIGNER_PUBLIC_KEY", "FAIL");
  }
}

function inspectExecutionAuthority(
  p: Json,
  signer: Json | undefined,
  findings: ConfigFinding[],
) {
  const authority = p.executionAuthority as Json | undefined,
    pilot = pilotActive(p);
  if (
    !authority ||
    (pilot
      ? authority.separateDeviceValidated !== false
      : authority.separateDeviceValidated !== true) ||
    !text(authority.identity) ||
    !text(authority.attestationReference) ||
    !text(authority.publicKey)
  ) {
    push(findings, "INDEPENDENT_EXECUTION_AUTHORITY_REQUIRED", "BLOCKED");
    return;
  }
  try {
    const key = createPublicKey(authority.publicKey as string);
    if (key.asymmetricKeyType !== "ed25519") {
      push(findings, "ED25519_EXECUTION_AUTHORITY_REQUIRED", "FAIL");
      return;
    }
    if (
      signer &&
      text(signer.publicKey) &&
      keyBytes(authority.publicKey as string) ===
        keyBytes(signer.publicKey as string)
    )
      push(findings, "EXECUTION_AUTHORITY_MUST_BE_INDEPENDENT", "FAIL");
  } catch {
    push(findings, "INVALID_EXECUTION_AUTHORITY_KEY", "FAIL");
  }
}

function inspectPriceAuthorities(p: Json, findings: ConfigFinding[]) {
  if (pilotActive(p)) {
    push(
      findings,
      "SINGLE_OPERATOR_PILOT_PRICING",
      "PASS",
      "one-operator-two-market-data-providers",
    );
    return;
  }
  const pins = p.priceAuthorities;
  if (!Array.isArray(pins) || pins.length !== 2) {
    push(findings, "TWO_AUTHORIZED_PRICE_AUTHORITIES_REQUIRED", "BLOCKED");
    return;
  }
  const keys = new Set<string>(),
    operators = new Set<string>();
  for (const [index, value] of pins.entries()) {
    const pin = value as Json;
    if (!pin || !text(pin.operator) || !text(pin.publicKey)) {
      push(
        findings,
        "INVALID_PRICE_AUTHORITY",
        "FAIL",
        `authority-${index + 1}`,
      );
      continue;
    }
    try {
      const key = createPublicKey(pin.publicKey as string);
      if (key.asymmetricKeyType !== "ed25519")
        push(findings, "ED25519_PRICE_AUTHORITY_REQUIRED", "FAIL");
      keys.add(keyBytes(pin.publicKey as string));
    } catch {
      push(findings, "INVALID_PRICE_AUTHORITY_KEY", "FAIL");
    }
    operators.add(String(pin.operator).trim().toLowerCase());
  }
  if (keys.size !== 2 || operators.size !== 2)
    push(findings, "INDEPENDENT_PRICE_AUTHORITIES_REQUIRED", "FAIL");
}

function inspectProfile(value: unknown) {
  const findings: ConfigFinding[] = [],
    p = value as Json;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    push(findings, "INVALID_PRODUCTION_PROFILE", "FAIL");
    return { network: "unknown", status: "FAIL", findings };
  }
  if (!networks.includes(p.network as Network)) {
    push(findings, "INVALID_PRODUCTION_NETWORK", "FAIL");
    return { network: "unknown", status: "FAIL", findings };
  }
  const network = p.network as Network;
  if (p.enabled !== true) push(findings, "PROFILE_DISABLED", "BLOCKED");
  inspectProviders(p, findings);
  inspectLimits(p, network, findings);
  if (network === "zcash") {
    if (Array.isArray(p.recipients) && p.recipients.length)
      push(findings, "SOURCE_ONLY_PROFILE_HAS_DESTINATION", "FAIL");
    return { network, status: status(findings), findings };
  }
  const recipients = p.recipients;
  let recipient: string | null = null;
  if (!Array.isArray(recipients) || recipients.length !== 1) {
    push(findings, "EXACT_AUTHORIZED_RECIPIENT_REQUIRED", "BLOCKED");
  } else {
    try {
      recipient = mainnetAddress(network, recipients[0]);
    } catch {
      push(findings, "INVALID_RECIPIENT_ADDRESS", "FAIL");
    }
  }
  let relayer: string | null = null;
  if (!text(p.relayer)) push(findings, "DEDICATED_RELAYER_REQUIRED", "BLOCKED");
  else {
    try {
      relayer = mainnetAddress(network, p.relayer);
      if (recipient && relayer === recipient)
        push(findings, "SELF_TRANSFER", "FAIL");
    } catch {
      push(findings, "INVALID_RELAYER_ADDRESS", "FAIL");
    }
  }
  inspectPilot(p, findings);
  inspectSigner(p, network, relayer, findings);
  inspectExecutionAuthority(p, p.signer as Json | undefined, findings);
  inspectPriceAuthorities(p, findings);
  return { network, status: status(findings), findings };
}

function inspectReadOnly(value: unknown) {
  const findings: ConfigFinding[] = [],
    read = value as Json;
  if (!read || typeof read !== "object" || Array.isArray(read)) {
    push(findings, "READ_ONLY_CONFIGURATION_REQUIRED", "BLOCKED");
    return { status: "BLOCKED", findings };
  }
  if (read.mode !== "READ_ONLY")
    push(findings, "READ_ONLY_MODE_REQUIRED", "FAIL");
  for (const key of [
    "paymentsEnabled",
    "signingEnabled",
    "broadcastEnabled",
    "refundsEnabled",
  ])
    if (read[key] !== false)
      push(findings, "SPENDING_SWITCH_MUST_BE_DISABLED", "FAIL", key);
  const nets = read.networks as Json | undefined;
  if (!nets || typeof nets !== "object") {
    push(findings, "READ_ONLY_NETWORKS_REQUIRED", "BLOCKED");
    return { status: status(findings), findings };
  }
  const zcash = nets.zcash as Json | undefined;
  if (zcash?.network !== "mainnet")
    push(findings, "ZCASH_MAINNET_REQUIRED", "FAIL");
  if (!text(zcash?.lightwalletd) || !text(zcash?.independentNode)) {
    push(findings, "READ_ONLY_ZCASH_PROVIDERS_REQUIRED", "BLOCKED");
  } else {
    try {
      const lightwalletd = new URL(zcash!.lightwalletd as string),
        independent = new URL(zcash!.independentNode as string);
      for (const endpoint of [lightwalletd, independent])
        if (
          endpoint.protocol !== "https:" ||
          endpoint.username ||
          endpoint.password ||
          placeholder(endpoint.href)
        )
          push(findings, "READ_ONLY_PLACEHOLDER_PROVIDER", "BLOCKED", "zcash");
      if (lightwalletd.hostname === independent.hostname)
        push(
          findings,
          "READ_ONLY_PROVIDER_INDEPENDENCE_REQUIRED",
          "FAIL",
          "zcash",
        );
    } catch {
      push(findings, "READ_ONLY_INVALID_PROVIDER", "FAIL", "zcash");
    }
  }
  if ((nets.base as Json | undefined)?.chainId !== 8453)
    push(findings, "BASE_CHAIN_ID_REQUIRED", "FAIL");
  if ((nets.solana as Json | undefined)?.genesisHash !== SOLANA_MAINNET_GENESIS)
    push(findings, "SOLANA_GENESIS_REQUIRED", "FAIL");
  for (const network of ["base", "solana"] as const) {
    const n = nets[network] as Json | undefined,
      primary = n?.productionPrimary,
      secondary = n?.productionSecondary;
    if (!text(primary) || !text(secondary)) {
      push(
        findings,
        "READ_ONLY_PRODUCTION_PROVIDERS_REQUIRED",
        "BLOCKED",
        network,
      );
      continue;
    }
    try {
      const first = new URL(primary as string),
        second = new URL(secondary as string);
      for (const endpoint of [first, second])
        if (
          endpoint.protocol !== "https:" ||
          endpoint.username ||
          endpoint.password ||
          placeholder(endpoint.href)
        )
          push(findings, "READ_ONLY_PLACEHOLDER_PROVIDER", "BLOCKED", network);
      if (first.hostname === second.hostname)
        push(
          findings,
          "READ_ONLY_PROVIDER_INDEPENDENCE_REQUIRED",
          "FAIL",
          network,
        );
    } catch {
      push(findings, "READ_ONLY_INVALID_PROVIDER", "FAIL", network);
    }
  }
  if (!read.productionKeyReferences)
    push(findings, "PRODUCTION_KEY_REFERENCES_REQUIRED", "BLOCKED");
  if (!read.executionLimits)
    push(findings, "EXECUTION_LIMITS_REQUIRED", "BLOCKED");
  return { status: status(findings), findings };
}

export function inspectMainnetConfiguration(input: {
  profiles: unknown;
  readOnly?: unknown;
}) {
  const values = Array.isArray(input.profiles) ? input.profiles : [];
  const profiles = networks.map((network) => {
      const matches = values.filter(
        (p) => p && typeof p === "object" && (p as Json).network === network,
      );
      if (matches.length !== 1)
        return {
          network,
          status: "FAIL" as const,
          findings: [
            {
              code: "EXACTLY_ONE_PROFILE_PER_NETWORK_REQUIRED",
              status: "FAIL" as const,
              detail: `${matches.length}`,
            },
          ],
        };
      return inspectProfile(matches[0]);
    }),
    extra = values.filter(
      (p) =>
        !p ||
        typeof p !== "object" ||
        !networks.includes((p as Json).network as Network),
    ).length,
    readOnly = inspectReadOnly(input.readOnly);
  return {
    version: 1 as const,
    mode: "READ_ONLY_CONFIGURATION_CHECK" as const,
    executionAvailable: false as const,
    configurationReady:
      extra === 0 &&
      profiles.every((p) => p.status === "PASS") &&
      readOnly.status === "PASS",
    profiles,
    extraProfiles: extra,
    readOnly,
  };
}
