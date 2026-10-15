// REAL funded-note unsigned export and effects review only. No spending-key read.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { validatePhase52Profile } from "../services/validation/phase52-profile.ts";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
import { nativeCall } from "../services/signer/native-refund.ts";
import { digest } from "../services/settlement/protocol.ts";
import { exclusiveJson } from "../services/execution/io.ts";
const exec = promisify(execFile),
  bin = resolve(
    `target/debug/zecone-zcash-watch${process.platform === "win32" ? ".exe" : ""}`,
  );
async function main() {
  const p = validatePhase52Profile(
      JSON.parse(readFileSync(".state/phase52-profile.json", "utf8")),
    ),
    state = resolve(".state/phase52", p.id),
    out = join(state, "transfer/unsigned-refund.pczt");
  if (!existsSync(out))
    await exec(
      bin,
      [
        "--wallet",
        p.roles[1].watch,
        "prepare-phase52-refund",
        "--profile-id",
        p.id,
      ],
      { windowsHide: true, timeout: 180000, maxBuffer: 16384 },
    );
  const metadata = JSON.parse(
      readFileSync(join(state, "transfer/unsigned-refund.json"), "utf8"),
    ),
    pczt = readFileSync(out);
  if (
    metadata.profileId !== p.id ||
    metadata.requestId !== p.refundRequestId ||
    metadata.orderId !== p.paymentRequestId ||
    createHash("sha256").update(pczt).digest("hex") !== metadata.pcztSha256 ||
    metadata.signed !== false
  )
    throw Error("unsigned_package_binding_conflict");
  const scan = await new WatchOnlyZcash(p.independentSettlementWatch).observe();
  if (
    scan.native.inputs.length !== 1 ||
    scan.native.inputs[0].zatoshis !== "100000"
  )
    throw Error("independent_expected_input_required");
  const { stdout } = await exec(
    bin,
    [
      "--wallet",
      resolve(".state/phase52-public-probe-unused"),
      "probe-provider",
      "--server",
      "https://testnet.zec.rocks:443",
      "--height",
      String(metadata.anchorHeight),
    ],
    { windowsHide: true, timeout: 45000, maxBuffer: 16384 },
  );
  const anchor = JSON.parse(stdout);
  if (
    anchor.height !== metadata.anchorHeight ||
    scan.tip - metadata.anchorHeight < 9 ||
    anchor.network !== "zcash-testnet"
  )
    throw Error("independent_anchor_verification_failed");
  const intent = JSON.parse(
    readFileSync(join(state, "backend/payment-request.json"), "utf8"),
  );
  const request = {
    version: 1,
    domain: "zecone-phase52-unsigned-refund-v1",
    network: "zcash-testnet",
    id: p.refundRequestId,
    sourceOrderId: p.paymentRequestId,
    orderId: "0x" + digest({ domain: "zecone-phase52-order-v1", intent }),
    paymentRequestId: p.paymentRequestId,
    originalPaymentTxid: scan.native.inputs[0].paymentKey.split(":")[0],
    destination: metadata.destination,
    refundZatoshis: "90000",
    feeCeilingZatoshis: "10000",
    eligibleZatoshis: "100000",
    expiryHeight: metadata.expiryHeight,
    pcztSha256: metadata.pcztSha256,
    commitmentsAndWitnesses: "included in the bound private PCZT",
    authorizationStatus:
      "user/operator certificates not supplied; separate-device signing gate closed",
  };
  const policy = {
    version: 1,
    network: "zcash-testnet",
    requestDigest: digest(request),
    orderId: request.orderId,
    destination: request.destination,
    refundZatoshis: "90000",
    feeCeilingZatoshis: "10000",
    eligibleZatoshis: "100000",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    fullViewingKey: scan.native.fullViewingKey,
    anchor: anchor.ironwoodAnchor,
    tip: scan.tip,
    observedAt: scan.observedAt,
    inputs: scan.native.inputs.map((i) => ({
      nullifier: i.nullifier,
      zatoshis: i.zatoshis,
      minedHeight: i.minedHeight,
    })),
  };
  const result = await nativeCall({
    operation: "review",
    pcztHex: pczt.toString("hex"),
    policy,
  });
  if (
    result.transactionSigned !== false ||
    result.liveEnabled !== false ||
    result.review.pcztDigest !== metadata.pcztSha256 ||
    result.review.requestDigest !== digest(request)
  )
    throw Error("independent_native_review_failed");
  const privateRequest = join(state, "transfer/unsigned-refund-request.json");
  if (!existsSync(privateRequest))
    exclusiveJson(privateRequest, {
      request,
      pcztFile: out,
      independentInputEvidence: policy.inputs,
      nativeReview: result.review,
    });
  const evidence = {
    at: new Date().toISOString(),
    profileId: p.id,
    sourceOrderId: p.paymentRequestId,
    originalPaymentTxid: request.originalPaymentTxid,
    network: "zcash-testnet",
    refundDestination: request.destination,
    refundZatoshis: "90000",
    feeZatoshis: result.review.feeZatoshis,
    expiryHeight: result.review.expiryHeight,
    pcztSha256: metadata.pcztSha256,
    pcztBytes: pczt.length,
    realFundedNote: true,
    independentScannerEffectsVerified: true,
    minimumInputConfirmations: Math.min(
      ...policy.inputs.map((i) => scan.tip - i.minedHeight + 1),
    ),
    witnessesOwnershipCiphertextsAndChangeVerified: true,
    signed: false,
    broadcast: false,
    authorizationComplete: false,
    separateDeviceValidated: false,
    independentProviderVerification: false,
    liveRefundsEnabled: false,
  };
  const file = join(
    "docs/phase52-evidence",
    `unsigned-refund-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  exclusiveJson(file, evidence);
  console.log(
    JSON.stringify(
      { file, privatePackage: privateRequest, ...evidence },
      null,
      2,
    ),
  );
}
main().catch(() => {
  console.error(
    "phase52_unsigned_refund_rejected_no_secret_details_logged; preserve package and claims; signing remains disabled",
  );
  process.exitCode = 1;
});
