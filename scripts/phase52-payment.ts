// Local operator tool: ONLY fresh Wallet A can spend. Wallet B's keys are never read.
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { decrypt } from "../services/signer/keystore.ts";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
import { validatePhase52Profile } from "../services/validation/phase52-profile.ts";
import {
  reviewPhase52Payment,
  requireExactPaymentApproval,
} from "../services/validation/phase52-payment-review.ts";
import { digest } from "../services/settlement/protocol.ts";
import { exclusiveJson } from "../services/execution/io.ts";
import { DatabaseSync } from "node:sqlite";
import { Phase52TestOrder } from "../services/validation/phase52-order.ts";
const profile = validatePhase52Profile(
    JSON.parse(readFileSync(".state/phase52-profile.json", "utf8")),
  ),
  state = resolve(".state/phase52", profile.id),
  wallet = join(state, "payer-native"),
  prefix = join(wallet, `request-${profile.paymentRequestId}`),
  ready = JSON.parse(readFileSync(join(state, "ready.json"), "utf8"));
const destination = ready.addresses.find(
  (r: any) => r.role === "settlement",
).address;
function review() {
  return reviewPhase52Payment(
    profile.id,
    profile.paymentRequestId,
    destination,
    JSON.parse(readFileSync(`${prefix}.json`, "utf8")),
    readFileSync(`${prefix}.raw`),
  );
}
async function native(args: string[], seed?: Buffer): Promise<any> {
  return new Promise((yes, no) => {
    const child = spawn(
      resolve(
        `target/debug/zecone-zcash${process.platform === "win32" ? ".exe" : ""}`,
      ),
      ["--wallet", wallet, ...args],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let size = 0,
      failed = false;
    const reject = () => {
      if (failed) return;
      failed = true;
      child.kill();
      seed?.fill(0);
      chunks.forEach((b) => b.fill(0));
      no(Error("isolated_payer_native_failed_preserve_all_claims"));
    };
    const timer = setTimeout(reject, 600000);
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.stderr.resume();
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 65536) reject();
      else chunks.push(b);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      seed?.fill(0);
      if (failed) return;
      if (code !== 0) {
        reject();
        return;
      }
      try {
        yes(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject();
      } finally {
        chunks.forEach((b) => b.fill(0));
      }
    });
    child.stdin.end(seed, () => seed?.fill(0));
  });
}
async function main() {
  const action = process.argv[2];
  if (
    !["prepare", "review", "broadcast", "observe-recovery", "inspect"].includes(
      action ?? "",
    )
  )
    throw Error("unsupported_operation");
  const requestFile = join(state, "backend/payment-request.json");
  if (action === "inspect") {
    const result = await native([
      "inspect-phase52-payment",
      "--profile-id",
      profile.id,
      "--request-id",
      profile.paymentRequestId,
    ]);
    exclusiveJson(
      join(
        "docs/phase52-evidence",
        `payment-status-${new Date().toISOString().replaceAll(":", "-")}.json`,
      ),
      { at: new Date().toISOString(), profileId: profile.id, ...result },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "prepare") {
    const snap = await new WatchOnlyZcash(profile.roles[0].watch).observe();
    const value = snap.native.inputs
      .filter((i) => snap.tip - i.minedHeight + 1 >= 10)
      .reduce((n, i) => n + BigInt(i.zatoshis), 0n);
    if (value < 110000n)
      throw Error("ten_confirmation_unspent_ironwood_funding_required");
    if (!existsSync(requestFile))
      exclusiveJson(requestFile, {
        version: 1,
        profileId: profile.id,
        orderId: profile.paymentRequestId,
        paymentRequestId: profile.paymentRequestId,
        network: profile.network,
        recipient: destination,
        zatoshis: "100000",
        refundDestination: ready.addresses.find(
          (r: any) => r.role === "refund-destination",
        ).address,
        minimumConfirmations: 10,
        purpose: "controlled-preconstruction-failure-refund-test",
        executionEnabled: false,
      });
    if (!existsSync(`${prefix}.json`)) {
      if (existsSync(`${prefix}.started.json`))
        throw Error("construction_uncertain_no_retry");
      const keys = profile.roles[0].keys,
        password = readFileSync(join(keys, "development-password.bin"));
      let seed: Buffer | undefined;
      try {
        seed = await decrypt(
          JSON.parse(
            readFileSync(join(keys, "isolated-seed.keystore.json"), "utf8"),
          ),
          password,
          "isolated-wallet-test",
        );
        await native(
          [
            "prepare-phase52-payment",
            "--profile-id",
            profile.id,
            "--request-id",
            profile.paymentRequestId,
            "--birthday",
            String(ready.addresses[0].birthday),
          ],
          seed,
        );
      } finally {
        password.fill(0);
        seed?.fill(0);
      }
    }
  }
  const reviewed = review(),
    approvalDigest = digest(reviewed),
    reviewFile = join(state, "payment-review.json");
  const db = new DatabaseSync(join(state, "backend/settlement.sqlite"));
  try {
    const order = new Phase52TestOrder(db);
    order.create(JSON.parse(readFileSync(requestFile, "utf8")));
    order.prepared(profile.paymentRequestId, reviewed);
    if (action === "observe-recovery") {
      const a = await new WatchOnlyZcash(profile.roles[1].watch).observe(),
        b = await new WatchOnlyZcash(
          profile.independentSettlementWatch,
        ).observe();
      const expected = ready.addresses.find(
        (r: any) => r.role === "settlement",
      );
      order.controlledRecovery(
        profile.paymentRequestId,
        expected.viewingKeyFingerprint,
        a,
        b,
      );
      const result = {
        at: new Date().toISOString(),
        profileId: profile.id,
        order: order.view(profile.paymentRequestId),
        paymentTxid: reviewed.txid,
        controlledFailure:
          "local preconstruction fault; no EVM transaction submitted",
        independentProviderVerification: false,
        separateDeviceValidated: false,
        liveRefundsEnabled: false,
      };
      exclusiveJson(
        join(
          "docs/phase52-evidence",
          `recovery-${new Date().toISOString().replaceAll(":", "-")}.json`,
        ),
        result,
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (existsSync(reviewFile)) {
      if (
        digest(JSON.parse(readFileSync(reviewFile, "utf8"))) !== approvalDigest
      )
        throw Error("persisted_review_conflict");
    } else exclusiveJson(reviewFile, reviewed);
    if (action === "broadcast") {
      const scan = await new WatchOnlyZcash(profile.roles[0].watch).observe();
      requireExactPaymentApproval(reviewed, process.argv[3] ?? "", scan.tip);
      if (existsSync(`${prefix}.broadcast.started.json`))
        throw Error("broadcast_already_claimed_reconcile_without_retry");
      order.approve(profile.paymentRequestId, process.argv[3] ?? "");
      const approval = join(state, "operator-payment-approval.json");
      if (!existsSync(approval))
        exclusiveJson(approval, {
          approvalDigest,
          at: new Date().toISOString(),
          txid: reviewed.txid,
        });
      else if (
        JSON.parse(readFileSync(approval, "utf8")).approvalDigest !==
        approvalDigest
      )
        throw Error("operator_approval_conflict");
      const result = await native([
        "broadcast-phase52-payment",
        "--profile-id",
        profile.id,
        "--request-id",
        profile.paymentRequestId,
        "--approved-txid",
        reviewed.txid,
        "--allow-testnet-broadcast",
      ]);
      exclusiveJson(
        join(
          "docs/phase52-evidence",
          `payment-broadcast-${new Date().toISOString().replaceAll(":", "-")}.json`,
        ),
        {
          at: new Date().toISOString(),
          profileId: profile.id,
          review: reviewed,
          result,
          refundsEnabled: false,
        },
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    mkdirSync("docs/phase52-evidence", { recursive: true });
    if (!existsSync("docs/phase52-evidence/prepared-payment.json"))
      exclusiveJson("docs/phase52-evidence/prepared-payment.json", {
        at: new Date().toISOString(),
        review: reviewed,
        approvalDigest,
        broadcast: false,
      });
    console.log(
      JSON.stringify(
        {
          review: reviewed,
          approvalDigest,
          actionBroadcast: false,
          broadcastClaimPresent: existsSync(`${prefix}.broadcast.started.json`),
          previousBroadcastStatus: existsSync(`${prefix}.broadcast.json`)
            ? JSON.parse(readFileSync(`${prefix}.broadcast.json`, "utf8"))
                .status
            : null,
          recordedRawBytes: true,
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}
main().catch((error) => {
  const safeReasons=new Set(["order_scanner_disagreement","stale_or_foreign_order_scan","receipt_conflict","order_not_awaiting_payment","ten_confirmation_exact_payment_required","independent_watch_scan_failed"]);
  const reason=safeReasons.has(error?.message)?error.message:"rejected";
  console.error(
    `phase52_payment_operation_rejected:${reason}; inspect confirmations, exact approval and saved claims; never reset or automatically retry`,
  );
  process.exitCode = 1;
});
