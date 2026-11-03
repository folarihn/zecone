// Review/apply an exact-order, single-use operator-funded pilot shortfall.
// This command never prices, prepares, signs or broadcasts a transaction.
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exclusiveJson } from "../services/execution/io.ts";
import { checkoutOrderId } from "../services/payments/checkout-settlement.ts";
import {
  pilotShortfallApprovalText,
  pilotShortfallAuthorizationTerms,
} from "../services/settlement/mainnet-pilot-shortfall.ts";
import { PilotSessionJournal } from "../services/settlement/mainnet-pilot-session.ts";

type Config = {
  stateDirectory: string;
  checkoutPaymentId?: string;
  watchBinding: { orderId: string; zatoshis: string };
  sourceCommitment: string;
  sourceZatoshis: string;
  quotedPayoutWei?: string;
  recipient: string;
  shortfallAuthorizationDigest?: string;
};

const json = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as T;

function argumentsMap(argv: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined)
      throw Error("INVALID_ARGUMENTS");
    values.set(argv[i].slice(2), argv[i + 1]);
  }
  return values;
}

function noExistingSettlement(c: Config, sessions: PilotSessionJournal) {
  if (
    sessions.db
      .prepare("SELECT 1 FROM pilot_consumed_sources WHERE source=?")
      .get(c.sourceCommitment)
  )
    throw Error("PILOT_SOURCE_ALREADY_CONSUMED");
  const submissions = join(c.stateDirectory, "submissions.sqlite");
  if (existsSync(submissions)) {
    const db = new DatabaseSync(submissions, { readOnly: true });
    try {
      const table = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mainnet_submissions'",
        )
        .get();
      if (
        table &&
        db
          .prepare(
            "SELECT 1 FROM mainnet_submissions WHERE source_commitment=? OR order_id=?",
          )
          .get(c.sourceCommitment, c.watchBinding.orderId)
      )
        throw Error("PILOT_SETTLEMENT_ALREADY_RESERVED");
    } finally {
      db.close();
    }
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "review" && command !== "apply")
    throw Error("USE_REVIEW_OR_APPLY");
  const args = argumentsMap(rest),
    need = (key: string) => {
      const value = args.get(key);
      if (!value)
        throw Error(`MISSING_${key.toUpperCase().replaceAll("-", "_")}`);
      return value;
    },
    configPath = resolve(need("config")),
    c = json<Config>(configPath),
    paymentId = c.checkoutPaymentId ?? "";
  if (
    !/^[A-Za-z0-9_]{1,64}$/.test(paymentId) ||
    checkoutOrderId(paymentId) !== c.watchBinding.orderId ||
    c.watchBinding.zatoshis !== c.sourceZatoshis ||
    !c.quotedPayoutWei
  )
    throw Error("EXACT_CHECKOUT_SHORTFALL_SCOPE_REQUIRED");
  const now = Math.floor(Date.now() / 1000),
    expires =
      command === "review"
        ? now + Number(args.get("window") ?? "3600")
        : Number(need("expires")),
    approvalDeadline =
      command === "review"
        ? now + Number(args.get("approval-seconds") ?? "300")
        : Number(need("approval-deadline")),
    terms = pilotShortfallAuthorizationTerms({
      orderId: c.watchBinding.orderId,
      paymentCommitment: c.sourceCommitment,
      recipient: c.recipient,
      actualSourceZatoshis: c.sourceZatoshis,
      quotedPayoutWei: c.quotedPayoutWei,
      maximumSubsidyWei: need("maximum-subsidy-wei"),
      expires,
      approvalDeadline,
      now,
    }),
    sessions = new PilotSessionJournal(
      join(c.stateDirectory, "pilot-sessions.sqlite"),
    );
  try {
    noExistingSettlement(c, sessions);
    const active = sessions.db
      .prepare(
        `SELECT 1 FROM pilot_shortfall_authorizations a
         LEFT JOIN pilot_shortfall_authorization_consumptions x ON x.terms_digest=a.terms_digest
         WHERE a.payment_commitment=? AND a.expires>? AND x.terms_digest IS NULL`,
      )
      .get(c.sourceCommitment, now);
    if (active) throw Error("ACTIVE_PILOT_SHORTFALL_AUTHORIZATION_EXISTS");
    if (command === "review") {
      console.log(
        JSON.stringify(
          {
            status: "PILOT_SHORTFALL_REVIEW",
            terms,
            requiredApproval: pilotShortfallApprovalText(terms),
            warning:
              "Operator funds at most maximumSubsidyWei; payout, payment and recipient remain exact",
            signing: false,
            broadcast: false,
          },
          null,
          1,
        ),
      );
      return;
    }
    sessions.authorizeShortfall(terms, need("approve"), now);
    exclusiveJson(resolve(need("out")), {
      ...c,
      shortfallAuthorizationDigest: terms.termsDigest,
    });
    console.log(
      JSON.stringify(
        {
          status: "PILOT_SHORTFALL_AUTHORIZED",
          terms,
          output: resolve(need("out")),
          signing: false,
          broadcast: false,
        },
        null,
        1,
      ),
    );
  } finally {
    sessions.close();
  }
}

try {
  main();
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "PILOT_SHORTFALL_OPERATION_FAILED",
      signing: false,
      broadcast: false,
    }),
  );
  process.exitCode = 1;
}
