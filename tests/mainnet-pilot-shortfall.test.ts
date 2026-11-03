import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizedPilotShortfall,
  pilotShortfallApprovalText,
  pilotShortfallAuthorizationTerms,
  pilotSourceValueWei,
  type PilotShortfallAuthorizationTerms,
} from "../services/settlement/mainnet-pilot-shortfall.ts";
import { PilotSessionJournal } from "../services/settlement/mainnet-pilot-session.ts";
import { checkoutOrderId } from "../services/payments/checkout-settlement.ts";

const now = 2_000_000_000;
function terms(overrides: Record<string, unknown> = {}) {
  return pilotShortfallAuthorizationTerms({
    orderId: "a".repeat(64),
    paymentCommitment: "b".repeat(64),
    recipient: "0x1111111111111111111111111111111111111111",
    actualSourceZatoshis: "800",
    quotedPayoutWei: "1000000000000",
    maximumSubsidyWei: "250000000000",
    expires: now + 3600,
    approvalDeadline: now + 300,
    now,
    ...overrides,
  });
}

test("source valuation rounds down and exact shortfall stays under the approved cap", () => {
  assert.equal(pilotSourceValueWei("10", "1", "800"), 800000000000n);
  const authorization = terms(),
    shortfall = authorizedPilotShortfall(
      authorization,
      { numerator: "10", denominator: "1" },
      "1000",
      now,
    );
  assert.deepEqual(shortfall, {
    policy: "single-use-exact-order-operator-shortfall-v1",
    authorizationDigest: authorization.termsDigest,
    requiredSourceZatoshis: "1000",
    sourceValueWei: "800000000000",
    subsidyWei: "200000000000",
    maximumSubsidyWei: "250000000000",
  });
  assert.throws(
    () =>
      authorizedPilotShortfall(
        terms({ maximumSubsidyWei: "199999999999" }),
        { numerator: "10", denominator: "1" },
        "1000",
        now,
      ),
    /NOT_AUTHORIZED/,
  );
});

test("authorization is exact-scope, append-only and consumed once at signing", () => {
  const journal = new PilotSessionJournal(
      join(mkdtempSync(join(tmpdir(), "pilot-shortfall-")), "sessions.sqlite"),
    ),
    authorization = terms(),
    expected = {
      orderId: authorization.orderId,
      paymentCommitment: authorization.paymentCommitment,
      recipient: authorization.recipient,
      actualSourceZatoshis: authorization.actualSourceZatoshis,
      quotedPayoutWei: authorization.quotedPayoutWei,
    };
  try {
    assert.throws(
      () => journal.authorizeShortfall(authorization, "wrong", now),
      /EXACT_APPROVAL/,
    );
    journal.authorizeShortfall(
      authorization,
      pilotShortfallApprovalText(authorization),
      now,
    );
    assert.equal(
      journal.shortfallAuthorization(authorization.termsDigest, expected, now)
        .termsDigest,
      authorization.termsDigest,
    );
    assert.throws(
      () =>
        journal.shortfallAuthorization(
          authorization.termsDigest,
          {
            ...expected,
            recipient: "0x2222222222222222222222222222222222222222",
          },
          now,
        ),
      /SCOPE_MISMATCH/,
    );
    assert.throws(
      () =>
        journal.authorizeShortfall(
          authorization,
          pilotShortfallApprovalText(authorization),
          now,
        ),
      /REPLAY/,
    );
    journal.consumeShortfallAuthorization(
      authorization.termsDigest,
      "session-one",
      now + 1,
    );
    assert.throws(
      () =>
        journal.shortfallAuthorization(
          authorization.termsDigest,
          expected,
          now + 1,
        ),
      /UNAVAILABLE/,
    );
    assert.throws(
      () =>
        journal.consumeShortfallAuthorization(
          authorization.termsDigest,
          "session-two",
          now + 1,
        ),
      /REPLAY/,
    );
    assert.throws(
      () =>
        journal.db
          .prepare(
            "UPDATE pilot_shortfall_authorizations SET expires=expires+1 WHERE terms_digest=?",
          )
          .run(authorization.termsDigest),
      /APPEND_ONLY/,
    );
  } finally {
    journal.close();
  }
});

test("missed approval deadline and changed approved schedule are rejected", () => {
  const authorization = terms(),
    journal = new PilotSessionJournal(
      join(
        mkdtempSync(join(tmpdir(), "pilot-shortfall-expiry-")),
        "sessions.sqlite",
      ),
    );
  try {
    assert.throws(
      () =>
        journal.authorizeShortfall(
          authorization,
          pilotShortfallApprovalText(authorization),
          authorization.approvalDeadline,
        ),
      /APPROVAL_EXPIRED/,
    );
    const changed = { ...authorization, expires: authorization.expires + 1 };
    assert.throws(
      () =>
        journal.authorizeShortfall(
          changed,
          pilotShortfallApprovalText(authorization),
          now,
        ),
      /AUTHORIZATION_INVALID/,
    );
  } finally {
    journal.close();
  }
});

test("operator CLI reviews then appends the exact grant without preparing or executing", () => {
  const root = mkdtempSync(join(tmpdir(), "pilot-shortfall-cli-")),
    state = join(root, "state"),
    config = join(root, "session.json"),
    output = join(root, "authorized.json"),
    paymentId = "pay_shortfall_test",
    body = {
      stateDirectory: state,
      checkoutPaymentId: paymentId,
      watchBinding: {
        orderId: checkoutOrderId(paymentId),
        zatoshis: "800",
      },
      sourceCommitment: "b".repeat(64),
      sourceZatoshis: "800",
      quotedPayoutWei: "1000000000000",
      recipient: "0x1111111111111111111111111111111111111111",
    },
    run = (args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--experimental-transform-types",
          join(process.cwd(), "scripts/mainnet-pilot-shortfall.ts"),
          ...args,
        ],
        { encoding: "utf8", windowsHide: true },
      );
  writeFileSync(config, JSON.stringify(body));
  const review = run([
    "review",
    "--config",
    config,
    "--maximum-subsidy-wei",
    "250000000000",
    "--window",
    "3600",
    "--approval-seconds",
    "300",
  ]);
  assert.equal(review.status, 0, review.stderr);
  const reviewed = JSON.parse(review.stdout) as {
    terms: PilotShortfallAuthorizationTerms;
    requiredApproval: string;
    signing: boolean;
    broadcast: boolean;
  };
  assert.equal(reviewed.signing, false);
  assert.equal(reviewed.broadcast, false);
  const apply = run([
    "apply",
    "--config",
    config,
    "--maximum-subsidy-wei",
    reviewed.terms.maximumSubsidyWei,
    "--expires",
    reviewed.terms.expires.toString(),
    "--approval-deadline",
    reviewed.terms.approvalDeadline.toString(),
    "--approve",
    reviewed.requiredApproval,
    "--out",
    output,
  ]);
  assert.equal(apply.status, 0, apply.stderr);
  const saved = JSON.parse(readFileSync(output, "utf8")) as {
    shortfallAuthorizationDigest: string;
  };
  assert.equal(saved.shortfallAuthorizationDigest, reviewed.terms.termsDigest);
  const journal = new PilotSessionJournal(join(state, "pilot-sessions.sqlite"));
  try {
    assert.equal(
      journal.shortfallAuthorization(reviewed.terms.termsDigest, {
        orderId: body.watchBinding.orderId,
        paymentCommitment: body.sourceCommitment,
        recipient: body.recipient,
        actualSourceZatoshis: body.sourceZatoshis,
        quotedPayoutWei: body.quotedPayoutWei,
      }).termsDigest,
      reviewed.terms.termsDigest,
    );
  } finally {
    journal.close();
  }
});
