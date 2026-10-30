// Portable, file-based signing rehearsal. Every credential and note is disposable.
// The mode is deliberately fixed to simulated isolation; there is no live switch.
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  createPublicKey,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  writeVerifiedKeystore,
  ApprovalVault,
} from "../services/signer/keystore.ts";
import {
  IsolatedSpendVault,
  IsolatedNativeRefundSigner,
} from "../services/signer/native-refund.ts";
import { IndependentRefundReviewer } from "../services/signer/refund-review.ts";
import {
  PortableRefundSession,
  exportPortableRequest,
} from "../services/signer/portable-refund.ts";
import { NativeDestinationDecoder } from "../services/settlement/native-address.ts";
import {
  approveRequest,
  digest,
  userMessage,
  type RefundRequest,
} from "../services/settlement/protocol.ts";
const writeNew = (p: string, v: unknown) =>
  writeFileSync(p, JSON.stringify(v, null, 2), { flag: "wx", mode: 0o600 });
async function prepare() {
  const id = randomUUID(),
    parent = resolve(".secrets/phase5-portable"),
    privateDir = join(parent, id),
    transfer = resolve(".state/phase5-portable", id);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(transfer, { recursive: true, mode: 0o700 });
  execFileSync(
    resolve(
      `target/debug/zecone-refund-signer${process.platform === "win32" ? ".exe" : ""}`,
    ),
    ["create-synthetic-fixture", privateDir],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const policy = JSON.parse(
      readFileSync(join(privateDir, "policy.json"), "utf8"),
    ),
    pczt = readFileSync(join(privateDir, "unsigned.pczt")),
    password = randomBytes(32);
  const signer = generateKeyPairSync("ed25519"),
    operator = generateKeyPairSync("ed25519"),
    user = privateKeyToAccount(generatePrivateKey());
  writeFileSync(join(privateDir, "development-password.bin"), password, {
    flag: "wx",
    mode: 0o600,
  });
  const key = readFileSync(join(privateDir, "isolated-key.bin")),
    approvalKey = signer.privateKey.export({ format: "der", type: "pkcs8" });
  try {
    await writeVerifiedKeystore(
      join(privateDir, "spend.keystore.json"),
      key,
      password,
      "isolated-wallet-test",
    );
    await writeVerifiedKeystore(
      join(privateDir, "approval.keystore.json"),
      approvalKey,
      password,
      "signer-approval",
    );
  } finally {
    key.fill(0);
    approvalKey.fill(0);
    password.fill(0);
  }
  unlinkSync(join(privateDir, "isolated-key.bin"));
  const now = Math.floor(Date.now() / 1000),
    r: RefundRequest = {
      version: 1,
      domain: "zecone-testnet-refund-v1",
      network: "zcash-testnet",
      id: randomUUID(),
      orderId: policy.orderId,
      intentDigest: digest({ synthetic: "portable-order" }),
      paymentDigest: digest({ synthetic: "portable-receipts" }),
      recipient: user.address,
      destination: policy.destination,
      eligibleZatoshis: policy.eligibleZatoshis,
      refundZatoshis: policy.refundZatoshis,
      feeCeilingZatoshis: policy.feeCeilingZatoshis,
      created: now,
      expires: now + 300,
    };
  const bundle = {
    request: r,
    userSignature: await user.signMessage({ message: userMessage(r) }),
    operatorApproval: approveRequest("operator", r, operator.privateKey),
  };
  const evidence = {
    authorization: {
      network: r.network,
      orderId: r.orderId,
      intentDigest: r.intentDigest,
      paymentDigest: r.paymentDigest,
      recipient: r.recipient,
      destination: r.destination,
      eligibleZatoshis: r.eligibleZatoshis,
      tip: policy.tip,
      scanned: policy.tip,
      observedAt: policy.observedAt,
      minimumConfirmations: 10,
      execution: "never-constructed",
      orderState: "recovery",
    },
    native: {
      fullViewingKey: policy.fullViewingKey,
      anchor: policy.anchor,
      tip: policy.tip,
      observedAt: policy.observedAt,
      inputs: policy.inputs,
    },
  };
  writeNew(join(privateDir, "signer-evidence.json"), evidence);
  writeFileSync(
    join(transfer, "unsigned-request.json"),
    exportPortableRequest(bundle, pczt),
    { flag: "wx", mode: 0o600 },
  );
  const config = join(privateDir, "session.json");
  writeNew(config, {
    version: 1,
    mode: "simulated-isolation",
    transfer,
    refundId: r.id,
    evidenceDigest: digest(evidence),
    operatorPublicKey: operator.publicKey.export({
      type: "spki",
      format: "pem",
    }),
    signerPublicKey: signer.publicKey.export({ type: "spki", format: "pem" }),
  });
  console.log(
    JSON.stringify({
      session: config,
      transferDirectory: transfer,
      mode: "simulated-isolation",
      syntheticNotes: true,
      reviewWithinSeconds: 120,
      liveEnabled: false,
    }),
  );
}
async function run() {
  const [action, path, approved] = process.argv.slice(2);
  if (action === "prepare-simulation") return prepare();
  if (!["review", "sign", "recover"].includes(action) || !path)
    throw Error("portable_command");
  const { dirname } = await import("node:path"),
    privateDir = dirname(resolve(path)),
    config = JSON.parse(readFileSync(path, "utf8"));
  if (config.version !== 1 || config.mode !== "simulated-isolation")
    throw Error("simulation_required");
  const evidence = JSON.parse(
    readFileSync(join(privateDir, "signer-evidence.json"), "utf8"),
  );
  if (digest(evidence) !== config.evidenceDigest)
    throw Error("signer_owned_evidence_changed");
  const db = new DatabaseSync(join(privateDir, "signer.sqlite")),
    vault = new ApprovalVault("signer"),
    spend = new IsolatedSpendVault();
  try {
    const reader = {
      liveChain: false,
      async read() {
        return evidence.authorization;
      },
      async readNative() {
        return evidence.native;
      },
      async validateShieldedDestination(s: string) {
        await new NativeDestinationDecoder().validate(s);
      },
    };
    const reviewer = new IndependentRefundReviewer(
        db,
        createPublicKey(config.operatorPublicKey),
        vault,
        reader,
      ),
      native = new IsolatedNativeRefundSigner(
        reviewer,
        reader,
        createPublicKey(config.signerPublicKey),
        spend,
      ),
      session = new PortableRefundSession(native);
    const bytes = readFileSync(join(config.transfer, "unsigned-request.json"));
    if (action === "review") {
      console.log(JSON.stringify(await session.review(bytes), null, 2));
      return;
    }
    let result;
    if (action === "recover") result = session.recover(config.refundId);
    else {
      const review = await session.review(bytes);
      if (approved !== review.approvalDigest)
        throw Error("manual_exact_digest_approval_required");
      const password = readFileSync(
        join(privateDir, "development-password.bin"),
      );
      try {
        await vault.unlock(
          JSON.parse(
            readFileSync(join(privateDir, "approval.keystore.json"), "utf8"),
          ),
          password,
          true,
          180000,
        );
        await spend.unlock(
          JSON.parse(
            readFileSync(join(privateDir, "spend.keystore.json"), "utf8"),
          ),
          password,
          true,
          180000,
        );
      } finally {
        password.fill(0);
      }
      result = await session.signAndExport(bytes, approved);
    }
    const output = join(config.transfer, "signed-transaction.json");
    if (existsSync(output)) {
      if (digest(JSON.parse(readFileSync(output, "utf8"))) !== digest(result))
        throw Error("existing_output_conflict");
    } else writeNew(output, result);
    console.log(
      JSON.stringify({
        outputFile: output,
        simulatedIsolation: true,
        syntheticNotes: true,
        separateDeviceValidated: false,
        liveEnabled: false,
        broadcast: false,
      }),
    );
  } finally {
    vault.lock();
    spend.lock();
    db.close();
  }
}
run().catch(() => {
  console.error(
    "portable_simulation_rejected_no_secrets_logged; review freshness, approval and private journal; never reset an uncertain claim",
  );
  process.exitCode = 1;
});
