// Fresh disposable tools only. No legacy profile import, send or refund-sign operation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import {
  reservePhase52Profile,
  validatePhase52Profile,
  phase52BackendConfiguration,
  verifySettlementWatchIdentity,
  type Phase52Profile,
} from "../services/validation/phase52-profile.ts";
import { writeVerifiedKeystore } from "../services/signer/keystore.ts";
import {
  WatchOnlyZcash,
  type WatchSnapshot,
} from "../services/signer/watch-evidence.ts";
import { verifyProviderAgreement } from "../services/signer/chain-agreement.ts";
import { exclusiveJson } from "../services/execution/io.ts";
import { DatabaseSync } from "node:sqlite";
const exec = promisify(execFile),
  ext = process.platform === "win32" ? ".exe" : "",
  out = "docs/phase52-evidence";
const bin = (name: string) => resolve(`target/debug/${name}${ext}`);
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const root = (p: Phase52Profile) => resolve(".state/phase52", p.id);
function profile() {
  return validatePhase52Profile(
    JSON.parse(readFileSync(".state/phase52-profile.json", "utf8")),
  );
}
async function invoke(name: string, args: string[], timeout = 180000) {
  const r = await exec(bin(name), args, {
    windowsHide: true,
    timeout,
    maxBuffer: 16777216,
  });
  return JSON.parse(r.stdout);
}
async function importWatch(path: string, keys: string, birthday?: number) {
  if (existsSync(path)) {
    const m = JSON.parse(readFileSync(join(path, "watch-only.json"), "utf8"));
    const key = readFileSync(join(keys, "viewing-key.txt"), "utf8").trim();
    if (
      m.network !== "zcash-testnet" ||
      m.keyId !== hash(Buffer.from(key)) ||
      (birthday !== undefined && m.birthday !== birthday) ||
      readFileSync(join(path, "viewing-key.txt"), "utf8").trim() !== key
    )
      throw Error("existing_new_watch_identity_conflict");
    return m;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await invoke("zecone-zcash-watch", [
    "--wallet",
    path,
    "import",
    "--ufvk-file",
    join(keys, "viewing-key.txt"),
    ...(birthday === undefined ? [] : ["--birthday", String(birthday)]),
  ]);
  return JSON.parse(readFileSync(join(path, "watch-only.json"), "utf8"));
}
async function create(resumeId?: string) {
  const p = resumeId ? profile() : reservePhase52Profile(),
    addresses = [];
  if (resumeId && resumeId !== p.id)
    throw Error("exact_new_profile_id_required");
  if (existsSync(join(root(p), "ready.json")))
    throw Error("profile_already_ready_no_reprovisioning");
  let independentSettlementAddress: string | undefined;
  for (const role of p.roles) {
    if (!existsSync(role.keys)) {
      await invoke("provision-watch-test", [role.keys], 30000);
      const password = randomBytes(32);
      writeFileSync(join(role.keys, "development-password.bin"), password, {
        flag: "wx",
        mode: 0o600,
      });
      try {
        for (const name of ["isolated-seed", "isolated-key"]) {
          const file = join(role.keys, `${name}.bin`),
            bytes = readFileSync(file);
          try {
            await writeVerifiedKeystore(
              join(role.keys, `${name}.keystore.json`),
              bytes,
              password,
              "isolated-wallet-test",
            );
          } finally {
            bytes.fill(0);
          }
          unlinkSync(file); // Only this new staging file, after verified encryption.
        }
      } finally {
        password.fill(0);
      }
    } else {
      if (
        !resumeId ||
        readdirSync(role.keys).sort().join(",") !==
          [
            "development-password.bin",
            "isolated-key.keystore.json",
            "isolated-seed.keystore.json",
            "viewing-key.txt",
          ]
            .sort()
            .join(",")
      )
        throw Error("partial_new_key_directory_requires_manual_review");
    }
    const m = await importWatch(role.watch, role.keys);
    const validation = await invoke(
      "zecone-zcash",
      [
        "--wallet",
        resolve(".state/phase52-validation-unused"),
        "validate-address",
        "--address",
        m.address,
      ],
      30000,
    );
    if (
      validation.network !== "zcash-testnet" ||
      validation.shielded !== true ||
      validation.valid !== true ||
      validation.receivers?.orchard !== true ||
      validation.receivers?.transparent !== false ||
      validation.receivers?.sapling !== false
    )
      throw Error("native_address_validation_failed");
    if (
      m.keyId !==
      hash(
        Buffer.from(
          readFileSync(join(role.keys, "viewing-key.txt"), "utf8").trim(),
        ),
      )
    )
      throw Error("viewing_key_identity_mismatch");
    addresses.push({
      role: role.role,
      address: m.address,
      viewingKeyFingerprint: m.keyId,
      birthday: m.birthday,
      addressValidation: validation,
    });
    if (role.role === "settlement") {
      const independent = await importWatch(
        p.independentSettlementWatch,
        role.keys,
        m.birthday,
      );
      verifySettlementWatchIdentity(m, independent);
      independentSettlementAddress = independent.address;
    }
  }
  if (
    new Set(addresses.map((a) => a.viewingKeyFingerprint)).size !== 3 ||
    new Set(addresses.map((a) => a.address)).size !== 3
  )
    throw Error("roles_not_independent");
  exclusiveJson(
    join(root(p), "backend/config.json"),
    phase52BackendConfiguration(p),
  );
  const ready = {
    version: 1,
    profileId: p.id,
    network: "zcash-testnet",
    simulatedIsolation: true,
    separateDeviceValidated: false,
    addresses,
    independentSettlementAddress,
    requestedFundingZatoshis: "200000",
    plannedPaymentZatoshis: "100000",
    plannedRefundZatoshis: "90000",
    assumedPaymentFeeZatoshis: "10000",
    assumedRefundFeeZatoshis: "10000",
    estimatedMinimumFundingZatoshis: "110000",
    feeAssumptions:
      "One mature Ironwood input and two logical actions per payment/refund under pinned ZIP-317; fees and expiry must be recalculated from actual funded-note proposals before approval. No transparent shielding budget.",
    keysGeneratedFromFreshOsRandomness: true,
    oldSeedsImported: false,
    oldWalletInputsSelected: false,
    existingFilesOverwritten: false,
    liveRefundsEnabled: false,
    broadcast: false,
  };
  exclusiveJson(join(root(p), "ready.json"), ready);
  mkdirSync(out, { recursive: true });
  exclusiveJson(join(out, "fresh-wallets.json"), ready);
  console.log(
    JSON.stringify(
      {
        profileFile: ".state/phase52-profile.json",
        publicWalletsFile: join(out, "fresh-wallets.json"),
        ...ready,
      },
      null,
      2,
    ),
  );
}
async function snapshot(path: string) {
  for (let n = 0; n < 3; n++)
    try {
      return await new WatchOnlyZcash(path).observe();
    } catch {
      if (n === 2) throw Error("read_only_scan_failed");
    }
  throw Error("scan_failed");
}
async function status() {
  const p = profile(),
    ready = JSON.parse(readFileSync(join(root(p), "ready.json"), "utf8"));
  const scans = [];
  for (const [role, path] of [
    ...p.roles.map((r) => [r.role, r.watch]),
    ["settlement-independent", p.independentSettlementWatch],
  ]) {
    try {
      const s = await snapshot(path);
      const expected = ready.addresses.find(
        (a: any) =>
          a.role === (role === "settlement-independent" ? "settlement" : role),
      );
      if (
        s.address !==
          (role === "settlement-independent"
            ? ready.independentSettlementAddress
            : expected.address) ||
        s.account !== expected.viewingKeyFingerprint
      )
        throw Error("profile_account_mismatch");
      const files = readdirSync(path);
      if (files.some((n) => /seed|keystore|password|isolated-key/.test(n)))
        throw Error("watch_directory_contains_secret_file");
      scans.push({
        role,
        status: "scanned",
        network: s.network,
        source: s.source,
        tip: s.tip,
        scanned: s.scanned,
        blockHash: s.blockHash,
        observedAt: s.observedAt,
        address: s.address,
        watchOnly: s.watchOnly,
        payments: s.payments.map((v) => ({
          txid: v.txid,
          zatoshis: v.zatoshis,
          height: v.height,
          confirmations: s.tip - v.height + 1,
        })),
        confirmedReceivedZatoshis: s.payments
          .filter((v) => s.tip - v.height + 1 >= 10)
          .reduce((n, v) => n + BigInt(v.zatoshis), 0n)
          .toString(),
      });
    } catch {
      scans.push({ role, status: "unavailable-no-settlement-evidence" });
    }
  }
  const a = scans.find(
      (s) => s.role === "settlement" && s.status === "scanned",
    ),
    b = scans.find(
      (s) => s.role === "settlement-independent" && s.status === "scanned",
    );
  const agreement =
    !!a &&
    !!b &&
    a.tip === b.tip &&
    a.blockHash === b.blockHash &&
    JSON.stringify(a.payments) === JSON.stringify(b.payments);
  const payer = scans.find((s) => s.role === "payer");
  const paymentPrefix = join(
    root(p),
    "payer-native",
    `request-${p.paymentRequestId}`,
  );
  const broadcastRecord = existsSync(`${paymentPrefix}.broadcast.json`)
    ? JSON.parse(readFileSync(`${paymentPrefix}.broadcast.json`, "utf8"))
    : null;
  let lifecycleState: string | null = null,
    executionVeto = false;
  const orderFile = join(root(p), "backend/settlement.sqlite");
  if (existsSync(orderFile)) {
    const db = new DatabaseSync(orderFile, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT state FROM settlement_lifecycle WHERE id=?")
        .get(p.paymentRequestId);
      lifecycleState = row ? String(row.state) : null;
      executionVeto = !!db
        .prepare("SELECT id FROM phase52_execution_veto WHERE id=?")
        .get(p.paymentRequestId);
    } finally {
      db.close();
    }
  }
  const report = {
    at: new Date().toISOString(),
    profileId: p.id,
    network: p.network,
    scans,
    sameProviderSettlementScannerAgreement: agreement,
    independentProviderVerification: false,
    payerHasRequestedConfirmedFunds:
      BigInt(payer?.confirmedReceivedZatoshis ?? "0") >= 200000n,
    minimumConfirmations: 10,
    realPaymentOrderCreated: existsSync(
      join(root(p), "backend/settlement.sqlite"),
    ),
    controlledExecutionFailureTriggered:
      lifecycleState === "RECOVERY_REQUIRED" && executionVeto,
    lifecycleState,
    executionPermanentlyBlocked: executionVeto,
    paymentBroadcast: broadcastRecord?.status === "broadcast-not-confirmed",
    paymentTransactionId: broadcastRecord?.txid ?? null,
    refundSigned: false,
    refundBroadcast: false,
    liveRefundsEnabled: false,
    separateDeviceValidated: false,
    note: "Receipt totals are observations, not a native spendable balance or fee quote. No transaction construction or broadcast is performed.",
  };
  mkdirSync(out, { recursive: true });
  const file = join(
    out,
    `scan-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  exclusiveJson(file, report);
  console.log(JSON.stringify({ file, ...report }, null, 2));
  if (scans.some((s) => s.status !== "scanned")) process.exitCode = 1;
}
async function providers() {
  const p = profile(),
    s = await snapshot(p.roles[0].watch),
    height = s.tip - 10;
  const urls = [
    "https://testnet.zec.rocks:443",
    "https://lightwalletd.testnet.electriccoin.co:9067",
    "https://lwd.testnet.zec.pro:443",
  ];
  const outcomes = await Promise.all(
    urls.map(async (source) => {
      try {
        return {
          source,
          status: "verified",
          evidence: await invoke(
            "zecone-zcash-watch",
            [
              "--wallet",
              resolve(".state/phase52-probe-unused"),
              "probe-provider",
              "--server",
              source,
              "--height",
              String(height),
            ],
            45000,
          ),
        };
      } catch {
        return {
          source,
          status: "unavailable-or-rejected",
          evidence: undefined,
        };
      }
    }),
  );
  const agreements = [];
  for (let i = 0; i < outcomes.length; i++)
    for (let j = i + 1; j < outcomes.length; j++) {
      const a = outcomes[i].evidence,
        b = outcomes[j].evidence;
      if (a && b)
        try {
          agreements.push(
            verifyProviderAgreement(a, b, Math.floor(Date.now() / 1000)),
          );
        } catch {}
    }
  const report = {
    at: new Date().toISOString(),
    profileId: p.id,
    height,
    outcomes,
    agreements,
    independentProviderAgreement: agreements.length > 0,
    fullConsensusValidation: false,
    walletScannersUseSameProvider: true,
    relevantPaymentInclusion: "not-tested-no-payment-broadcast",
    liveRefundsEnabled: false,
  };
  mkdirSync(out, { recursive: true });
  const file = join(
    out,
    `providers-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  exclusiveJson(file, report);
  console.log(JSON.stringify({ file, ...report }, null, 2));
}
async function main() {
  const action = process.argv[2];
  if (action === "create") await create();
  else if (action === "complete-new-profile") {
    if (!process.argv[3]) throw Error("exact_new_profile_id_required");
    await create(process.argv[3]);
  } else if (action === "status") await status();
  else if (action === "providers") await providers();
  else throw Error("allowed_commands_create_status_providers_only");
}
main().catch(() => {
  console.error(
    "phase52_profile_operation_failed_no_secret_details_logged; preserve partial profile and journals; no automatic reprovisioning",
  );
  process.exitCode = 1;
});
