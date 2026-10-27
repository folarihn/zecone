// Operator entry point for the existing mainnet planning, signer and executor
// boundaries. Execution is disabled unless the exact order digest, independent
// operator arm string and submitter resume string are all supplied. No command
// prints signed bytes, private keys or passphrases.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exclusiveJson } from "../services/execution/io.ts";
import {
  addressBinding,
  verifyDestinationOwnership,
  type DestinationNetwork,
} from "../services/settlement/mainnet-address.ts";
import { mainnetApprovalPackage } from "../services/settlement/mainnet-approval-package.ts";
import {
  executeMainnetTransfer,
  reconcileMainnetTransfer,
  type MainnetExecutionAuthorization,
} from "../services/settlement/mainnet-executor.ts";
import { MainnetExecutionLease } from "../services/settlement/mainnet-operator-lease.ts";
import { revokeMainnetSigner } from "../services/settlement/mainnet-signer.ts";
import {
  MainnetSubmissionJournal,
  pauseMainnetSubmissionJournal,
} from "../services/settlement/mainnet-submitter.ts";
import {
  mainnetTransferTerms,
  prepareMainnetTransfer,
  preparedDigest,
  termsDigest,
  verifyMainnetSignedBundle,
  verifiedMainnetSummary,
  type MainnetPrepared,
  type MainnetSignedBundle,
  type MainnetTransferTerms,
} from "../services/settlement/mainnet-transfer.ts";
import {
  MainnetWatchJournal,
  MainnetWatchScanner,
  observeMainnetWatch,
  type MainnetOrderBinding,
  type MainnetWatchPolicy,
} from "../services/settlement/mainnet-watch.ts";
import {
  assertMainnetQuote,
  mainnetQuoteContext,
  type MainnetQuote,
  type MainnetQuoteInput,
} from "../services/settlement/mainnet-quote.ts";
import {
  productionPrice,
  validateProductionProfile,
  type ProductionProfile,
  type SignedPrice,
} from "../services/settlement/production-safety.ts";
import {
  verifySingleOperatorPilotPrice,
  type SingleOperatorPilotPrice,
} from "../services/settlement/mainnet-pilot-pricing.ts";

type RequestFile = {
  recipient: string;
  amount: string;
  feeCap: string;
  l1DataFeeBound?: string;
  sourcePaymentCommitment: string;
  expires: number;
};
type PricingFile = {
  feeds?: { price: SignedPrice; publicKey: string }[];
  pilotPrice?: SingleOperatorPilotPrice;
  pair: "ETH/ZEC" | "SOL/ZEC";
  maximumSpreadBps?: number;
  networkFee: string;
  l1DataFee: string;
  serviceFee: string;
  ttlSeconds?: number;
};
type Plan = {
  version: 1;
  createdAt: string;
  network: DestinationNetwork;
  profile: ProductionProfile;
  terms: MainnetTransferTerms;
  termsDigest: string;
  approvalPackage: ReturnType<typeof mainnetApprovalPackage>;
  prepared?: MainnetPrepared;
};
type WatchBindingFile = MainnetOrderBinding;

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => Math.floor(Date.now() / 1000);

function args() {
  const [command, ...rest] = process.argv.slice(2),
    values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--") || !rest[i + 1])
      throw Error("INVALID_ARGUMENTS");
    values.set(rest[i].slice(2), rest[++i]);
  }
  return { command, values };
}
function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value || value.startsWith("--"))
    throw Error(`${key.replaceAll("-", "_").toUpperCase()}_REQUIRED`);
  return value;
}
function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
function network(value: string | undefined): DestinationNetwork {
  if (value !== "base" && value !== "solana") throw Error("NETWORK_REQUIRED");
  return value;
}
function profiles(file: string) {
  const value = readJson<ProductionProfile[]>(file);
  if (!Array.isArray(value)) throw Error("PROFILE_FILE_INVALID");
  return value;
}
function profile(file: string, net: DestinationNetwork) {
  const found = profiles(file).find((p) => p.network === net);
  if (!found) throw Error("PROFILE_NOT_FOUND");
  return found;
}
function watchPolicy(file: string) {
  const found = profiles(file).find((p) => p.network === "zcash");
  if (!found) throw Error("ZCASH_WATCH_PROFILE_NOT_FOUND");
  return found as MainnetWatchPolicy;
}
function quoteInput(
  net: DestinationNetwork,
  p: ProductionProfile,
  pricing: PricingFile,
  destinationUnits: bigint,
  at: number,
): MainnetQuoteInput {
  return {
    network: net,
    profile: p,
    pair: pricing.pair,
    ...(pricing.pilotPrice
      ? { pilotPrice: pricing.pilotPrice }
      : { feeds: pricing.feeds! }),
    destinationUnits,
    networkFee: BigInt(pricing.networkFee),
    l1DataFee: BigInt(pricing.l1DataFee),
    serviceFee: BigInt(pricing.serviceFee),
    now: at,
    ttlSeconds: pricing.ttlSeconds,
    maximumSpreadBps: pricing.maximumSpreadBps,
  };
}
function planFile(file: string): Plan {
  const plan = readJson<Plan>(file);
  if (
    !plan ||
    !plan.terms ||
    !plan.profile ||
    plan.version !== 1 ||
    plan.network !== plan.terms.network ||
    plan.network !== plan.profile.network ||
    plan.termsDigest !== termsDigest(plan.terms)
  )
    throw Error("INVALID_MAINNET_PLAN");
  return plan;
}
function assertCurrentProfile(plan: Plan, file: string) {
  const current = profile(file, plan.network),
    validated = validateProductionProfile(current);
  if (
    digest(validated) !== digest(plan.profile) ||
    plan.terms.profileDigest !== digest(validated)
  )
    throw Error("PLAN_PROFILE_CHANGED_OR_NOT_ACTIVE");
  return validated;
}
function assertPlanPrepared(plan: Plan) {
  if (!plan.prepared) throw Error("PREPARED_TRANSFER_REQUIRED");
  if (
    plan.prepared.termsDigest !== plan.termsDigest ||
    plan.prepared.maximumDestinationDebit !== plan.terms.maximumDestinationDebit
  )
    throw Error("PREPARED_TRANSFER_MISMATCH");
  return plan.prepared;
}
function journalFor(file: string, p: ProductionProfile) {
  return new MainnetSubmissionJournal(file, {
    perTransaction: p.perTransaction,
    daily: p.daily,
    confirmations: p.confirmations,
  });
}
function leaseFor(file: string | undefined) {
  return file ? new MainnetExecutionLease(resolve(file)) : null;
}

async function prepare(values: Map<string, string>) {
  const net = network(values.get("network")),
    profilesFile = required(values, "profiles"),
    p = profile(profilesFile, net),
    request = readJson<RequestFile>(required(values, "request")),
    pricing = readJson<PricingFile>(required(values, "pricing")),
    quoted = readJson<MainnetQuote>(required(values, "quote")),
    proof = readJson<{
      nonce: string;
      expires: number;
      signature: string;
    }>(required(values, "ownership-proof")),
    out = required(values, "out"),
    at = now(),
    requested = BigInt(request.amount),
    price = pricing.pilotPrice
      ? (() => {
          const verified = verifySingleOperatorPilotPrice(
            p,
            pricing.pilotPrice,
            mainnetQuoteContext(quoteInput(net, p, pricing, requested, at)),
            requested,
            at,
          );
          return {
            zatoshis: verified.sourceZatoshis,
            expires: verified.expires,
            confidence: verified.confidence,
          };
        })()
      : productionPrice(
          pricing.feeds!,
          pricing.pair,
          requested,
          net === "base" ? 18 : 9,
          at,
          pricing.maximumSpreadBps,
        ),
    quote = assertMainnetQuote(
      quoted,
      quoteInput(net, p, pricing, requested, at),
      at,
    ),
    ownership = await verifyDestinationOwnership({
      network: net,
      address: request.recipient,
      nonce: proof.nonce,
      expires: proof.expires,
      signature: proof.signature,
      now: at,
    });
  if (ownership.binding !== addressBinding(net, request.recipient))
    throw Error("DESTINATION_OWNERSHIP_REQUIRED");
  if (quote.sourceZatoshis !== price.zatoshis || quote.expires > price.expires)
    throw Error("QUOTE_PRICE_MISMATCH");
  const terms = mainnetTransferTerms(
    p,
    {
      recipient: request.recipient,
      amount: request.amount,
      feeCap: request.feeCap,
      l1DataFeeBound: request.l1DataFeeBound,
      sourceZatoshis: quote.sourceZatoshis,
      sourcePaymentCommitment: request.sourcePaymentCommitment,
      destinationBinding: ownership.binding,
      quoteDigest: quote.quoteDigest,
      expires: Math.min(request.expires, price.expires, quote.expires),
    },
    at,
  );
  const prepared = await prepareMainnetTransfer(p, terms, fetch, at);
  const plan: Plan = {
    version: 1,
    createdAt: new Date(at * 1000).toISOString(),
    network: net,
    profile: p,
    terms,
    termsDigest: termsDigest(terms),
    approvalPackage: mainnetApprovalPackage(
      p,
      { zatoshis: price.zatoshis, expires: price.expires },
      at,
    ),
    prepared,
  };
  exclusiveJson(resolve(out), plan);
  process.stdout.write(
    JSON.stringify({
      status: "PREPARED_AWAITING_EXACT_OFFLINE_APPROVAL",
      network: net,
      termsDigest: plan.termsDigest,
      preparedDigest: preparedDigest(prepared),
      maximumDestinationDebit: terms.maximumDestinationDebit,
      expires: terms.expires,
      plan: resolve(out),
      signing: false,
      broadcast: false,
    }) + "\n",
  );
}

async function simulate(values: Map<string, string>) {
  const file = required(values, "plan"),
    plan = planFile(file),
    p = assertCurrentProfile(plan, required(values, "profiles")),
    prepared = assertPlanPrepared(plan),
    bundleFile = values.get("bundle");
  if (!bundleFile) {
    const fresh = await prepareMainnetTransfer(p, plan.terms);
    if (preparedDigest(fresh) !== preparedDigest(prepared))
      throw Error("SIMULATION_PREPARED_STATE_CHANGED");
    process.stdout.write(
      JSON.stringify({
        status: "SIMULATION_PASSED",
        network: plan.network,
        termsDigest: plan.termsDigest,
        preparedDigest: preparedDigest(fresh),
        signing: false,
        broadcast: false,
      }) + "\n",
    );
    return;
  }
  const verified = await verifyMainnetSignedBundle(
    p,
    plan.terms,
    prepared,
    readJson<MainnetSignedBundle>(bundleFile),
  );
  process.stdout.write(JSON.stringify(verifiedMainnetSummary(verified)) + "\n");
}

async function status(values: Map<string, string>) {
  const file = values.get("profiles") ?? "config/mainnet-profiles.example.json",
    all = profiles(file),
    journalFile = values.get("journal"),
    orderId = values.get("order"),
    leaseFile = values.get("lease"),
    lease = leaseFor(leaseFile);
  try {
    const result = all.map((candidate) => {
      let validation = "PASS";
      let issue: string | null = null;
      try {
        validateProductionProfile(candidate);
      } catch (error) {
        validation = "BLOCKED";
        issue = error instanceof Error ? error.message : "INVALID_PROFILE";
      }
      return {
        network: candidate.network,
        enabled: candidate.enabled === true,
        configured: Array.isArray(candidate.recipients)
          ? candidate.recipients.length
          : 0,
        providers: Array.isArray(candidate.providers)
          ? candidate.providers.map((p) => {
              try {
                return {
                  host: new URL(p.endpoint).hostname,
                  operator: p.operator,
                };
              } catch {
                return { host: "INVALID", operator: p.operator };
              }
            })
          : [],
        validation,
        issue,
      };
    });
    let journal: unknown = null;
    if (journalFile) {
      const selected = values.get("network"),
        p = selected ? profile(file, network(selected)) : null;
      if (!p) throw Error("NETWORK_REQUIRED_WITH_JOURNAL");
      const j = journalFor(resolve(journalFile), p);
      try {
        journal = {
          paused: j.isPaused,
          order: orderId ? j.status(orderId) : null,
        };
      } finally {
        j.close();
      }
    }
    process.stdout.write(
      JSON.stringify(
        {
          status: "LOCAL_STATUS_ONLY",
          profiles: result,
          journal,
          lease: lease ? lease.status() : null,
          executionAvailable: false,
          notes: [
            "Provider connectivity, signer attestation and chain finality are not asserted by status.",
            "Execution remains disabled unless the exact order digest and arm/resume confirmations are supplied.",
          ],
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    lease?.close();
  }
}

async function pause(values: Map<string, string>) {
  const journalFile = resolve(required(values, "journal")),
    reason = required(values, "reason"),
    leaseFile = values.get("lease");
  if (leaseFile && !existsSync(resolve(leaseFile)))
    throw Error("MAINNET_LEASE_NOT_FOUND");
  const lease = leaseFor(leaseFile);
  try {
    pauseMainnetSubmissionJournal(journalFile, reason);
    lease?.pause(reason);
    process.stdout.write(
      JSON.stringify({
        status: "PAUSED",
        journal: journalFile,
        lease: leaseFile ? resolve(leaseFile) : null,
        reason,
        signing: false,
        broadcast: false,
      }) + "\n",
    );
  } finally {
    lease?.close();
  }
}

async function execute(values: Map<string, string>) {
  const file = required(values, "plan"),
    plan = planFile(file),
    profilesFile = required(values, "profiles"),
    p = assertCurrentProfile(plan, profilesFile),
    zcashPolicy = watchPolicy(profilesFile),
    prepared = assertPlanPrepared(plan),
    confirm = required(values, "confirm"),
    leaseFile = required(values, "lease"),
    journalFile = required(values, "journal"),
    watchJournalFile = required(values, "watch-journal"),
    bindingFile = required(values, "watch-binding"),
    executionAuth = readJson<MainnetExecutionAuthorization>(
      required(values, "execution-authorization"),
    ),
    bundleFile = required(values, "bundle"),
    journal = journalFor(resolve(journalFile), p),
    lease = new MainnetExecutionLease(resolve(leaseFile)),
    watch = new MainnetWatchJournal(resolve(watchJournalFile));
  let token: string | null = null,
    timer: NodeJS.Timeout | null = null;
  try {
    if (values.has("snapshot")) throw Error("NATIVE_SNAPSHOT_HANDOFF_REQUIRED");
    if (confirm !== plan.termsDigest)
      throw Error("EXACT_ORDER_CONFIRMATION_REQUIRED");
    if (values.get("arm") !== "ARM_MAINNET_EXECUTION")
      throw Error("EXPLICIT_OPERATOR_ARM_REQUIRED");
    if (values.get("resume-submitter") !== "RESUME_MAINNET_SUBMITTER")
      throw Error("EXPLICIT_SUBMITTER_RESUME_REQUIRED");
    if (!p.enabled) throw Error("MAINNET_PROFILE_DISABLED");
    if (!zcashPolicy.enabled) throw Error("ZCASH_WATCH_PROFILE_DISABLED");
    const acquired = lease.acquire(required(values, "lease-owner"), {
      recoverExpired: values.get("recover-expired-lease") === "true",
      ttlSeconds: 300,
    });
    token = acquired.token;
    lease.arm("ARM_MAINNET_EXECUTION");
    timer = setInterval(() => {
      try {
        if (token) lease.heartbeat(token);
      } catch {
        // The next guarded financial step fails closed.
      }
    }, 60_000);
    timer.unref();
    const binding = readJson<WatchBindingFile>(resolve(bindingFile)),
      scanner = new MainnetWatchScanner(
        required(values, "watch-wallet"),
        required(values, "watch-server"),
        required(values, "watch-peer"),
        zcashPolicy,
        resolve(
          `target/debug/zecone-zcash-watch${process.platform === "win32" ? ".exe" : ""}`,
        ),
        [],
        required(values, "watch-authenticated-blocks"),
        binding.address,
      ),
      payment = await observeMainnetWatch(watch, scanner, binding);
    if (payment.orderId !== executionAuth.orderId)
      throw Error("WATCH_ORDER_AUTHORIZATION_MISMATCH");
    lease.assertOwned(token);
    const bundle = readJson<MainnetSignedBundle>(resolve(bundleFile));
    journal.resume();
    const result = await executeMainnetTransfer(
      journal,
      payment,
      p,
      plan.terms,
      prepared,
      bundle,
      executionAuth,
      fetch,
      now(),
      lease.guard(token),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    if (timer) clearInterval(timer);
    if (token) {
      journal.pause("OPERATOR_EXECUTION_BOUNDARY_CLOSED");
      lease.pause("OPERATOR_EXECUTION_BOUNDARY_CLOSED");
      try {
        lease.release(token);
      } catch {
        // An expired or fenced lease is already closed.
      }
    }
    watch.close();
    lease.close();
    journal.close();
  }
}

async function reconcile(values: Map<string, string>) {
  const plan = planFile(required(values, "plan")),
    p = assertCurrentProfile(plan, required(values, "profiles")),
    leaseFile = required(values, "lease"),
    journalFile = required(values, "journal"),
    journal = journalFor(resolve(journalFile), p),
    lease = new MainnetExecutionLease(resolve(leaseFile));
  let token: string | null = null;
  try {
    if (values.get("arm") !== "ARM_MAINNET_EXECUTION")
      throw Error("EXPLICIT_OPERATOR_ARM_REQUIRED");
    token = lease.acquire(required(values, "lease-owner"), {
      recoverExpired: values.get("recover-expired-lease") === "true",
      ttlSeconds: 300,
    }).token;
    lease.arm("ARM_MAINNET_EXECUTION");
    const result = await reconcileMainnetTransfer(
      journal,
      p,
      plan.terms,
      required(values, "order"),
      fetch,
      lease.guard(token),
    );
    process.stdout.write(
      JSON.stringify({ status: "RECONCILED", result }) + "\n",
    );
  } finally {
    if (token) {
      lease.pause("OPERATOR_RECONCILIATION_BOUNDARY_CLOSED");
      try {
        lease.release(token);
      } catch {
        // A fenced lease is already closed.
      }
    }
    lease.close();
    journal.close();
  }
}

async function revokeSigner(values: Map<string, string>) {
  const ledger = resolve(required(values, "signer-ledger")),
    reason = required(values, "reason");
  revokeMainnetSigner(ledger, reason);
  process.stdout.write(
    JSON.stringify({
      status: "SIGNER_REVOKED",
      ledger,
      reason,
      signing: false,
      broadcast: false,
    }) + "\n",
  );
}

async function main() {
  const { command, values } = args();
  if (command === "status") return status(values);
  if (command === "revoke-signer") return revokeSigner(values);
  if (command === "prepare") return prepare(values);
  if (command === "simulate") return simulate(values);
  if (command === "execute") return execute(values);
  if (command === "reconcile") return reconcile(values);
  if (command === "pause") return pause(values);
  throw Error("UNKNOWN_COMMAND");
}

void main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof Error && /^[A-Z0-9_]{1,120}$/.test(error.message)
          ? error.message
          : "INVALID_OPERATION",
      signing: false,
      broadcast: false,
    }) + "\n",
  );
  process.exitCode = 1;
});
