// Operator-only renewal of an expired, unsettled checkout order binding
// (services/settlement/mainnet-binding-renewal.ts). Never signs, broadcasts,
// quotes or opens a key; the existing payout session still needs its own exact
// SIGN and BROADCAST approvals.
//
//   review --config <session.json> --payments-db <db> --spend-journal <db> [--window 3600] [--approval-seconds 300] [--supervisor-log <log>]
//          Re-verifies the exact bound payment from one fresh watcher scan, checks
//          every renewal condition, then fixes an absolute new expiry and a short
//          approval deadline and prints the exact approval. Writes nothing.
//   apply  ... --expires <unix> --approval-deadline <unix> --approve "<exact approval>" --out <new-session.json>
//          Before the deadline only: repeats every check, appends one renewal
//          with exactly the approved expiry and writes a session config whose
//          binding differs only in `expires`. A missed deadline needs a new review.
//
// --supervisor-log waits (at most 300 s) for the operator supervisor to finish a
// cycle and confirms no watcher process runs before the single scan.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { exclusiveJson } from "../services/execution/io.ts";
import { checkoutOrderId } from "../services/payments/checkout-settlement.ts";
import {
  assertBindingRenewalFacts,
  bindingRenewalApprovalText,
  bindingRenewalTerms,
  proposeBindingRenewalSchedule,
  readBindingRenewalFacts,
  renewMainnetOrderBinding,
  reverifyBoundPayment,
} from "../services/settlement/mainnet-binding-renewal.ts";
import {
  MainnetWatchJournal,
  pilotSessionWatchScanner,
  type MainnetOrderBinding,
  type MainnetWatchPolicy,
} from "../services/settlement/mainnet-watch.ts";

type SessionConfig = {
  profiles: string;
  stateDirectory: string;
  watchWallet: string;
  watchBinary: string;
  authenticatedBlocks: string;
  candidateBlocks?: string;
  watchBinding: MainnetOrderBinding;
  sourceCommitment: string;
  checkoutPaymentId?: string;
};

const json = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function args(argv: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined)
      throw Error("INVALID_ARGUMENTS");
    values.set(argv[i].slice(2), argv[i + 1]);
  }
  return values;
}

async function afterSupervisorCycle(log: string) {
  const start = statSync(log).size;
  const deadline = Date.now() + 300_000;
  while (!/"event":"CYCLE"/.test(readFileSync(log, "utf8").slice(start))) {
    if (Date.now() > deadline) throw Error("NO_SUPERVISOR_CYCLE_WITHIN_300S");
    await sleep(1000);
  }
  const rows = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'],
    { encoding: "utf8", windowsHide: true, maxBuffer: 16 << 20 },
  );
  if (rows.split(/\r?\n/).some((l) => /zecone-zcash-watch|mainnet-watch-worker\.ts|operator-sync\.ts/.test(l)))
    throw Error("WATCH_PROFILE_BUSY");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "review" && command !== "apply") throw Error("USE_REVIEW_OR_APPLY");
  const a = args(rest);
  const need = (k: string) => a.get(k) ?? (() => { throw Error(`MISSING_${k.toUpperCase().replace(/-/g, "_")}`); })();
  const c = json<SessionConfig>(resolve(need("config")));
  const original = c.watchBinding;
  const paymentId = c.checkoutPaymentId ?? "";
  if (!/^[A-Za-z0-9_]{1,64}$/.test(paymentId) || checkoutOrderId(paymentId) !== original.orderId)
    throw Error("RENEWAL_CHECKOUT_ORDER_REQUIRED");
  const windowSeconds = Number(a.get("window") ?? "3600");
  const approvalSeconds = Number(a.get("approval-seconds") ?? "300");
  const policy = json<{ network: string }[]>(c.profiles).find((p) => p.network === "zcash") as
    | MainnetWatchPolicy
    | undefined;
  if (!policy) throw Error("ZCASH_WATCH_PROFILE_REQUIRED");
  const journal = new MainnetWatchJournal(join(c.stateDirectory, "watch.sqlite"));
  try {
    // apply: the exact approved schedule, refused at once if already past due.
    const approved =
      command === "apply"
        ? { newExpires: Number(need("expires")), approvalDeadline: Number(need("approval-deadline")) }
        : null;
    if (approved) bindingRenewalTerms(journal, original, c.sourceCommitment, approved);
    const facts = readBindingRenewalFacts(
      {
        payments: resolve(need("payments-db")),
        spendJournal: resolve(need("spend-journal")),
        submissions: join(c.stateDirectory, "submissions.sqlite"),
        pilotSessions: join(c.stateDirectory, "pilot-sessions.sqlite"),
      },
      { paymentId, txid: original.payment!.txid, orderId: original.orderId, paymentCommitment: c.sourceCommitment },
    );
    const log = a.get("supervisor-log");
    if (log) await afterSupervisorCycle(resolve(log));
    const scanner = pilotSessionWatchScanner({ ...c, receivingAddress: original.address }, policy);
    const snapshot = await scanner.observe(journal.checkpointHeight());
    if (!approved) {
      assertBindingRenewalFacts(facts);
      // The schedule starts only after the fresh verification has completed.
      const schedule = proposeBindingRenewalSchedule(journal, windowSeconds, approvalSeconds);
      const evidence = reverifyBoundPayment(journal, { ...original, expires: schedule.newExpires }, c.sourceCommitment, snapshot);
      const now = journal.now();
      const terms = bindingRenewalTerms(journal, original, c.sourceCommitment, schedule);
      const activeRenewal = !!journal.db
        .prepare("SELECT 1 FROM mainnet_watch_binding_renewals WHERE order_id=? AND expires>?")
        .get(original.orderId, now);
      const iso = (t: number) => new Date(t * 1000).toISOString();
      console.log(JSON.stringify({
        status: "RENEWAL_REVIEW",
        eligible: original.expires <= now && !activeRenewal,
        originalExpired: original.expires <= now,
        activeRenewal,
        reviewedAt: iso(now),
        newExpires: terms.newExpires,
        newExpiresUTC: iso(terms.newExpires),
        approvalDeadline: terms.approvalDeadline,
        approvalDeadlineUTC: iso(terms.approvalDeadline),
        terms,
        facts,
        evidence,
        requiredApproval: bindingRenewalApprovalText(terms),
        signing: false,
        broadcast: false,
      }, null, 1));
      return;
    }
    const renewal = renewMainnetOrderBinding(journal, {
      original,
      paymentCommitment: c.sourceCommitment,
      schedule: approved,
      approval: need("approve"),
      snapshot,
      facts,
    });
    exclusiveJson(resolve(need("out")), { ...c, watchBinding: renewal.renewedBinding });
    console.log(JSON.stringify({ status: "RENEWED", ...renewal, signing: false, broadcast: false }, null, 1));
  } finally {
    journal.close();
  }
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({
    error: e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : "BINDING_RENEWAL_FAILED",
  }));
  process.exitCode = 1;
});
