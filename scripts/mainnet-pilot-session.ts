// Operator-only single-device pilot. --check never opens a signing key.
// --run requires an interactive terminal and two exact, transaction-bound replies.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { privateKeyToAccount } from "viem/accounts";
import { exclusiveJson } from "../services/execution/io.ts";
import { assertExternalPath } from "../services/provisioning/mainnet-watch-backup.ts";
import {
  openMainnetCredential,
  readMainnetKeystore,
} from "../services/provisioning/mainnet-keystore.ts";
import {
  ownershipMessage,
  verifyDestinationOwnership,
} from "../services/settlement/mainnet-address.ts";
import {
  executionAuthorizationPayload,
  executeMainnetTransfer,
  type MainnetExecutionAuthorization,
} from "../services/settlement/mainnet-executor.ts";
import { MainnetExecutionLease } from "../services/settlement/mainnet-operator-lease.ts";
import {
  PilotSessionJournal,
  runPilotSession,
  type PilotPlan,
} from "../services/settlement/mainnet-pilot-session.ts";
import { readProductionRpc } from "../services/settlement/mainnet-probe.ts";
import {
  assertMainnetQuote,
  type MainnetQuote,
  type MainnetQuoteInput,
} from "../services/settlement/mainnet-quote.ts";
import { MainnetSubmissionJournal } from "../services/settlement/mainnet-submitter.ts";
import {
  prepareMainnetTransfer,
  preparedDigest,
  verifyMainnetSignedBundle,
  type MainnetSignedBundle,
  type VerifiedMainnetBundle,
} from "../services/settlement/mainnet-transfer.ts";
import {
  assertMainnetPaymentAuthorization,
  MainnetWatchJournal,
  MainnetWatchScanner,
  observeMainnetWatch,
  type MainnetOrderBinding,
  type MainnetWatchObservation,
  type MainnetWatchPolicy,
} from "../services/settlement/mainnet-watch.ts";
import {
  singleDevicePilotActive,
  pilotQuoteTtlSeconds,
  validateProductionProfile,
  type ProductionProfile,
} from "../services/settlement/production-safety.ts";

type Config = {
  profiles: string;
  stateDirectory: string;
  watchWallet: string;
  watchBinary: string;
  authenticatedBlocks: string;
  watchBinding: MainnetOrderBinding;
  sourceCommitment: string;
  sourceEvidenceDigest: string;
  sourceZatoshis: string;
  recipient: string;
  expectedNonce: number;
  retiredTransactionIds: string[];
  networkFee: string;
  l1DataFee: string;
  authorityKeystore: string;
  authorityPublicKey: string;
  recipientKeystore: string;
  relayerKeystore: string;
  passphraseFile: string;
  signerLedger: string;
};
const now = () => Math.floor(Date.now() / 1000);
const json = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as T;
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function child(script: string, args: string[]) {
  try {
    const output = execFileSync(
      process.execPath,
      ["--experimental-transform-types", script, ...args],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
    return JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
  } catch (e) {
    // Never print subprocess argv, signed bytes, passphrases or arbitrary stderr.
    const match = String((e as { stderr?: unknown }).stderr ?? "").match(
      /"error":"([A-Z0-9_:.-]+)"/,
    );
    throw Error(match?.[1] ?? "PILOT_CHILD_FAILED");
  }
}
async function main() {
  const [mode, flag, path] = process.argv.slice(2);
  if (
    !["--check", "--dry-run", "--run"].includes(mode) ||
    flag !== "--config" ||
    !path ||
    process.argv.length !== 5
  )
    throw Error("USE_CHECK_DRY_RUN_OR_RUN_WITH_CONFIG");
  if (mode === "--run" && (!stdin.isTTY || !stdout.isTTY))
    throw Error("INTERACTIVE_OPERATOR_TERMINAL_REQUIRED");
  const c = json<Config>(path),
    profiles = json<ProductionProfile[]>(c.profiles),
    profile = profiles.find((p) => p.network === "base"),
    watchPolicy = profiles.find((p) => p.network === "zcash") as
      MainnetWatchPolicy | undefined;
  if (!profile || !watchPolicy) throw Error("BASE_AND_ZCASH_PROFILES_REQUIRED");
  validateProductionProfile(profile);
  if (!profile.enabled || !singleDevicePilotActive(profile, now()))
    throw Error("ACTIVE_BASE_PILOT_REQUIRED");
  for (const p of [c.stateDirectory, c.signerLedger])
    assertExternalPath(resolve(p));
  if (
    c.expectedNonce !== 0 ||
    c.sourceZatoshis !== "645937" ||
    c.watchBinding.zatoshis !== c.sourceZatoshis ||
    !/^[a-f0-9]{64}$/.test(c.sourceEvidenceDigest) ||
    c.watchBinding.sourceEvidenceDigest !== c.sourceEvidenceDigest ||
    profile.recipients.length !== 1 ||
    profile.recipients[0] !== c.recipient
  )
    throw Error("EXACT_FIRST_PILOT_SCOPE_REQUIRED");
  if (
    !c.retiredTransactionIds.includes(
      "0xc543d4c9346d60c131433e928b8bfae69e57bffc06301ce8211f2956e47f54cc",
    )
  )
    throw Error("EXPIRED_SIGNED_PAYOUT_HISTORY_REQUIRED");
  const submissionPath = join(c.stateDirectory, "submissions.sqlite");
  async function checkBase(prior: string[], plan?: PilotPlan) {
    if (existsSync(submissionPath)) {
      const db = new DatabaseSync(submissionPath, { readOnly: true });
      try {
        if (
          db
            .prepare(
              "SELECT 1 FROM mainnet_submissions WHERE source_commitment=?",
            )
            .get(c.sourceCommitment)
        )
          throw Error("PILOT_SETTLEMENT_ALREADY_RESERVED");
      } finally {
        db.close();
      }
    }
    // Independent reads are batched so operator review, not serial RPC latency,
    // uses most of the unchanged 60-second quote window.
    const report = await Promise.all(
      profile!.providers.map(async (provider) => {
        const [chain, balanceHex, nonces, retired] = await Promise.all([
          readProductionRpc(provider, "eth_chainId", []),
          readProductionRpc(provider, "eth_getBalance", [
            profile!.relayer,
            "latest",
          ]),
          Promise.all(
            ["finalized", "latest", "pending"].map((tag) =>
              readProductionRpc(provider, "eth_getTransactionCount", [
                profile!.relayer,
                tag,
              ]),
            ),
          ),
          Promise.all(
            [...new Set([...c.retiredTransactionIds, ...prior])].map(
              async (tx) => {
                const [transaction, receipt] = await Promise.all([
                  readProductionRpc(provider, "eth_getTransactionByHash", [tx]),
                  readProductionRpc(provider, "eth_getTransactionReceipt", [
                    tx,
                  ]),
                ]);
                return transaction !== null || receipt !== null;
              },
            ),
          ),
        ]);
        if (chain !== "0x2105") throw Error("WRONG_NETWORK");
        if (nonces.some((n) => BigInt(n) !== BigInt(c.expectedNonce)))
          throw Error("PILOT_NONCE_CHANGED");
        if (retired.some(Boolean))
          throw Error("PRIOR_PILOT_TRANSACTION_PRESENT_RECONCILE_ONLY");
        const balance = BigInt(balanceHex);
        if (plan && balance < BigInt(plan.terms.maximumDestinationDebit))
          throw Error("INSUFFICIENT_RELAYER_LIQUIDITY");
        return {
          provider: provider.operator,
          balanceWei: balance.toString(),
          nonce: c.expectedNonce,
        };
      }),
    );
    return report;
  }
  if (mode === "--check") {
    const report = await checkBase([]);
    console.log(
      JSON.stringify({
        status: watchPolicy.enabled
          ? "BASE_PREFLIGHT_PASS_NATIVE_SCAN_REQUIRED"
          : "BLOCKED",
        blocker: watchPolicy.enabled ? null : "ZCASH_WATCH_PROFILE_DISABLED",
        providers: report,
        signing: false,
        broadcast: false,
      }),
    );
    return;
  }
  if (!watchPolicy.enabled) throw Error("ZCASH_WATCH_PROFILE_DISABLED");
  const sessionId = randomBytes(16).toString("hex"),
    work = join(c.stateDirectory, "sessions", sessionId);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const sessions = new PilotSessionJournal(
      join(c.stateDirectory, "pilot-sessions.sqlite"),
    ),
    lease = new MainnetExecutionLease(join(c.stateDirectory, "lease.sqlite")),
    watch = new MainnetWatchJournal(join(c.stateDirectory, "watch.sqlite")),
    journal = new MainnetSubmissionJournal(submissionPath, {
      perTransaction: profile.perTransaction,
      daily: profile.daily,
      confirmations: profile.confirmations,
    });
  const initialLeaseControl = digest(
      lease.db
        .prepare("SELECT * FROM mainnet_operator_control WHERE id=1")
        .get(),
    ),
    initialSubmissionControl = digest(
      journal.db
        .prepare("SELECT * FROM mainnet_submitter_control WHERE id=1")
        .get(),
    );
  const assertControlsUnchanged = () => {
    if (
      digest(
        lease.db
          .prepare("SELECT * FROM mainnet_operator_control WHERE id=1")
          .get(),
      ) !== initialLeaseControl ||
      digest(
        journal.db
          .prepare("SELECT * FROM mainnet_submitter_control WHERE id=1")
          .get(),
      ) !== initialSubmissionControl
    )
      throw Error("PILOT_EMERGENCY_CONTROL_CHANGED");
  };
  let token: string | undefined,
    timer: NodeJS.Timeout | undefined,
    payment: MainnetWatchObservation | undefined,
    quote: MainnetQuote,
    price: MainnetQuoteInput["pilotPrice"],
    ownership: { nonce: string; expires: number; signature: `0x${string}` };
  const scanner = new MainnetWatchScanner(
    c.watchWallet,
    watchPolicy.providers[0].endpoint,
    watchPolicy.providers[1].endpoint,
    watchPolicy,
    c.watchBinary,
    [],
    c.authenticatedBlocks,
    c.watchBinding.address,
  );
  const quoteInput = (plan: PilotPlan): MainnetQuoteInput => ({
    network: "base",
    profile,
    pair: "ETH/ZEC",
    pilotPrice: price,
    destinationUnits: BigInt(plan.terms.amount),
    networkFee: BigInt(c.networkFee),
    l1DataFee: BigInt(c.l1DataFee),
    serviceFee: 0n,
    ttlSeconds: pilotQuoteTtlSeconds(profile),
    maximumSpreadBps: 200,
    now: now(),
  });
  const assertPayment = () => {
    if (!payment) throw Error("NATIVE_PAYMENT_REQUIRED");
    assertMainnetPaymentAuthorization(
      payment,
      {
        orderId: c.watchBinding.orderId,
        paymentDigest: c.sourceCommitment,
        zatoshis: c.sourceZatoshis,
      },
      now(),
    );
  };
  const refreshPayment = async () => {
    // Keep the existing 120-second native grant rule. A longer quote is not
    // permission to use an old scan; refresh it in the same owning process.
    if (!payment || now() - payment.observedAt > 60)
      payment = await observeMainnetWatch(watch, scanner, c.watchBinding);
    assertPayment();
  };
  try {
    token = lease.acquire(`pilot-${sessionId}`, { ttlSeconds: 300 }).token;
    timer = setInterval(() => {
      try {
        lease.heartbeat(token!);
      } catch {
        /* Financial gates still fail closed. */
      }
    }, 60_000);
    timer.unref();
    const result = await runPilotSession(
      sessions,
      c.sourceCommitment,
      {
        preflight: async (prior) => {
          await checkBase(prior);
          await refreshPayment();
        },
        prepare: async () => {
          // Slow native scan and recipient challenge precede the pilot price clock.
          const nonce = "0x" + randomBytes(32).toString("hex"),
            expires = now() + 600,
            pass = readFileSync(c.passphraseFile),
            secret = await openMainnetCredential(
              readMainnetKeystore(c.recipientKeystore),
              pass,
              "mainnet:base:recipient",
            );
          try {
            const account = privateKeyToAccount(`0x${secret.toString("hex")}`);
            ownership = {
              nonce,
              expires,
              signature: await account.signMessage({
                message: ownershipMessage("base", c.recipient, nonce, expires),
              }),
            };
          } finally {
            secret.fill(0);
            pass.fill(0);
          }
          exclusiveJson(join(work, "ownership.json"), ownership);
          const priced = child("scripts/mainnet-pilot-price.ts", [
            "--profiles",
            c.profiles,
            "--source-zatoshis",
            c.sourceZatoshis,
            "--network-fee",
            c.networkFee,
            "--l1-data-fee",
            c.l1DataFee,
            "--service-fee",
            "0",
            "--keystore",
            c.authorityKeystore,
            "--passphrase-file",
            c.passphraseFile,
            "--public-key",
            c.authorityPublicKey,
            "--out",
            join(work, "pricing.json"),
            "--confirm",
            "SIGN_PILOT_PRICE",
          ]);
          const pricing = json<{ pilotPrice: MainnetQuoteInput["pilotPrice"] }>(
            join(work, "pricing.json"),
          );
          price = pricing.pilotPrice;
          exclusiveJson(join(work, "request.json"), {
            recipient: c.recipient,
            amount: priced.destinationUnits,
            feeCap: (BigInt(c.networkFee) + BigInt(c.l1DataFee)).toString(),
            l1DataFeeBound: c.l1DataFee,
            sourcePaymentCommitment: c.sourceCommitment,
            expires: now() + 900,
          });
          child("scripts/mainnet-quote.ts", [
            "quote",
            "--profiles",
            c.profiles,
            "--pricing",
            join(work, "pricing.json"),
            "--network",
            "base",
            "--amount",
            priced.destinationUnits,
            "--out",
            join(work, "quote.json"),
          ]);
          quote = json<MainnetQuote>(join(work, "quote.json"));
          child("scripts/mainnet-operator.ts", [
            "prepare",
            "--network",
            "base",
            "--profiles",
            c.profiles,
            "--pricing",
            join(work, "pricing.json"),
            "--request",
            join(work, "request.json"),
            "--quote",
            join(work, "quote.json"),
            "--ownership-proof",
            join(work, "ownership.json"),
            "--out",
            join(work, "plan.json"),
          ]);
          child("scripts/mainnet-operator.ts", [
            "simulate",
            "--profiles",
            c.profiles,
            "--plan",
            join(work, "plan.json"),
          ]);
          return json<PilotPlan>(join(work, "plan.json"));
        },
        validate: async (plan) => {
          assertControlsUnchanged();
          await refreshPayment();
          validateProductionProfile(profile);
          if (
            digest(profiles) !== digest(json<ProductionProfile[]>(c.profiles))
          )
            throw Error("PILOT_PROFILE_CHANGED");
          assertMainnetQuote(quote, quoteInput(plan), now());
          await verifyDestinationOwnership({
            network: "base",
            address: c.recipient,
            ...ownership,
            now: now(),
          });
          await checkBase([], plan);
          const fresh = await prepareMainnetTransfer(
            profile,
            plan.terms,
            fetch,
            now(),
            plan.prepared.kind === "base-unsigned"
              ? {
                  number: plan.prepared.blockNumber,
                  hash: plan.prepared.blockHash,
                }
              : undefined,
          );
          if (preparedDigest(fresh) !== preparedDigest(plan.prepared))
            throw Error("SIMULATION_PREPARED_STATE_CHANGED");
        },
        approve: async (review, exactText) => {
          exclusiveJson(join(work, `review-${review.action}.json`), {
            ...review,
            requiredApproval: exactText,
            approvalGranted: false,
            expiresWAT: new Date(review.expires * 1000).toLocaleString(
              "en-GB",
              { timeZone: "Africa/Lagos", hour12: false },
            ),
          });
          console.log(
            JSON.stringify(
              {
                ...review,
                secondsRemaining: review.expires - now(),
                requiredApproval: exactText,
              },
              null,
              2,
            ),
          );
          const rl = createInterface({ input: stdin, output: stdout });
          try {
            return await rl.question(
              "Enter the exact approval (anything else aborts): ",
              {
                signal: AbortSignal.timeout(
                  Math.max(1, (review.expires - now()) * 1000),
                ),
              },
            );
          } finally {
            rl.close();
          }
        },
        sign: async (_plan, approval) => {
          exclusiveJson(join(work, "signing-approval.json"), approval);
          child("scripts/mainnet-offline-sign.ts", [
            "--plan",
            join(work, "plan.json"),
            "--profiles",
            c.profiles,
            "--approval",
            join(work, "signing-approval.json"),
            "--confirm",
            approval.preparedDigest,
            "--keystore",
            c.relayerKeystore,
            "--passphrase-file",
            c.passphraseFile,
            "--signer-ledger",
            c.signerLedger,
            "--out",
            join(work, "signed-bundle.json"),
            "--arm",
            "SIGN_EXACT_MAINNET_BUNDLE",
          ]);
          return json<MainnetSignedBundle>(join(work, "signed-bundle.json"));
        },
        verify: (plan, signed) =>
          verifyMainnetSignedBundle(profile, plan.terms, plan.prepared, signed),
        submit: async (plan, signed, verified: VerifiedMainnetBundle) => {
          assertControlsUnchanged();
          assertPayment();
          const expires = plan.terms.expires,
            nonce = randomBytes(32).toString("hex"),
            payload = executionAuthorizationPayload(
              c.watchBinding.orderId,
              plan.terms,
              plan.prepared,
              verified,
              expires,
              nonce,
            ),
            pass = readFileSync(c.passphraseFile),
            seed = await openMainnetCredential(
              readMainnetKeystore(c.authorityKeystore),
              pass,
              "mainnet:execution-authority",
            );
          let signature: string;
          try {
            const pem = readFileSync(c.authorityPublicKey, "utf8"),
              der = Buffer.from(
                pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""),
                "base64",
              );
            const key = createPrivateKey({
              key: {
                kty: "OKP",
                crv: "Ed25519",
                d: seed.toString("base64url"),
                x: der.subarray(-32).toString("base64url"),
              },
              format: "jwk",
            });
            signature = sign(
              null,
              Buffer.from(JSON.stringify(payload)),
              key,
            ).toString("base64");
          } finally {
            seed.fill(0);
            pass.fill(0);
          }
          const authorization: MainnetExecutionAuthorization = {
            version: 1,
            ...payload,
            signature,
          };
          exclusiveJson(
            join(work, "execution-authorization.json"),
            authorization,
          );
          if (now() >= expires)
            throw Error("PILOT_QUOTE_EXPIRED_REPREPARE_AND_REAPPROVE");
          // Reaching here requires the separate exact BROADCAST reply, never SIGN alone.
          lease.arm("ARM_MAINNET_EXECUTION");
          journal.resume();
          return executeMainnetTransfer(
            journal,
            payment!,
            profile,
            plan.terms,
            plan.prepared,
            signed,
            authorization,
            fetch,
            now(),
            lease.guard(token!),
            { quote, input: quoteInput(plan) },
          );
        },
      },
      now,
      sessionId,
      { dryRun: mode === "--dry-run" },
    );
    exclusiveJson(join(work, "result.json"), result);
    console.log(JSON.stringify(result));
  } finally {
    if (timer) clearInterval(timer);
    journal.pause("PILOT_SESSION_CLOSED");
    lease.pause("PILOT_SESSION_CLOSED");
    if (token) lease.release(token);
    sessions.close();
    watch.close();
    journal.close();
    lease.close();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      error:
        e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : "PILOT_SESSION_ABORTED",
      automaticRetry: false,
    }),
  );
  process.exitCode = 1;
});
