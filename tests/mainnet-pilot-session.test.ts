// Synthetic adapters only: no production keys, network calls or submissions.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keccak256 } from "viem";
import {
  PilotSessionJournal,
  runPilotSession,
  pilotApprovalText,
  type PilotPlan,
  type PilotSessionAdapters,
} from "../services/settlement/mainnet-pilot-session.ts";
import {
  preparedDigest,
  termsDigest,
  type MainnetSignedBundle,
} from "../services/settlement/mainnet-transfer.ts";

const source = "a".repeat(64);
function fixture() {
  let clock = 2_000_000_000,
    signs = 0,
    sends = 0,
    nonce = 0;
  const journal = new PilotSessionJournal(
    join(mkdtempSync(join(tmpdir(), "pilot-session-")), "sessions.sqlite"),
  );
  const terms: PilotPlan["terms"] = {
    version: 1,
    network: "base",
    destinationNetwork: "eip155:8453",
    relayer: "0x1111111111111111111111111111111111111111",
    recipient: "0x2222222222222222222222222222222222222222",
    amount: "1000",
    feeCap: "30000",
    l1DataFeeBound: "1000",
    maximumDestinationDebit: "31000",
    sourceNetwork: "zcash-mainnet",
    sourceZatoshis: "645937",
    sourcePaymentCommitment: source,
    destinationBinding: "b".repeat(64),
    quoteDigest: "c".repeat(64),
    profileDigest: "d".repeat(64),
    expires: clock + 60,
  };
  const plan: PilotPlan = {
    terms,
    prepared: {
      kind: "base-unsigned",
      termsDigest: termsDigest(terms),
      chainId: 8453,
      tx: {
        type: "legacy",
        chainId: 8453,
        to: terms.recipient,
        value: terms.amount,
        data: "0x",
        nonce: 0,
        gas: "21000",
        gasPrice: "1",
      },
      blockHash: "0x" + "1".repeat(64),
      blockNumber: "100",
      gasFee: "21000",
      l1DataFeeBound: "1000",
      maximumDestinationDebit: terms.maximumDestinationDebit,
      quoteDigest: "e".repeat(64),
    },
  };
  const bundle: MainnetSignedBundle = {
    version: 1,
    network: "base",
    termsDigest: termsDigest(terms),
    preparedDigest: preparedDigest(plan.prepared),
    signed: "0x01",
  };
  const adapters: PilotSessionAdapters = {
    preflight: async () => {
      if (nonce !== 0) throw Error("PILOT_NONCE_CHANGED");
    },
    prepare: async () => plan,
    validate: async () => {
      if (nonce !== 0) throw Error("PILOT_NONCE_CHANGED");
    },
    approve: async (_review, text) => text,
    sign: async () => {
      signs++;
      return bundle;
    },
    verify: async () => ({
      ...bundle,
      transactionId: keccak256("0x01"),
      signedDigest: "f".repeat(64),
      totalFee: "21001",
      broadcast: false,
    }),
    submit: async () => {
      sends++;
      return { state: "broadcast" };
    },
  };
  return {
    journal,
    plan,
    adapters,
    now: () => clock,
    advance: () => {
      clock += 60;
    },
    changeNonce: () => {
      nonce++;
    },
    counts: () => ({ signs, sends }),
  };
}

test("dry run validates real preparation gates but cannot request approvals, sign, submit or consume", async () => {
  const f = fixture();
  let approvals = 0;
  f.adapters.approve = async () => {
    approvals++;
    throw Error("NO_APPROVAL_IN_DRY_RUN");
  };
  try {
    const r = (await runPilotSession(
      f.journal,
      source,
      f.adapters,
      f.now,
      "dry",
      { dryRun: true },
    )) as { state: string; authorizationGranted: boolean };
    assert.equal(r.state, "dry-run-passed");
    assert.equal(r.authorizationGranted, false);
    assert.equal(approvals, 0);
    assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
    await runPilotSession(f.journal, source, f.adapters, f.now, "second-dry", {
      dryRun: true,
    });
  } finally {
    f.journal.close();
  }
});

test("wrong payout recipient is rejected before signing", async () => {
  const f = fixture();
  f.adapters.approve = async (_r, t) => {
    if (f.plan.prepared.kind === "base-unsigned")
      f.plan.prepared.tx.to = "0x3333333333333333333333333333333333333333";
    return t;
  };
  try {
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now),
      /MISMATCH/,
    );
    assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
  } finally {
    f.journal.close();
  }
});

test("pilot runs two exact approvals consecutively and consumes a source once", async () => {
  const f = fixture(),
    actions: string[] = [];
  f.adapters.approve = async (review, text) => {
    actions.push(review.action);
    assert.equal(review.amount, "1000");
    assert.equal(review.maximumDestinationDebit, "31000");
    assert.equal(review.sourceCommitment, source);
    assert.equal(text, pilotApprovalText(review));
    if (review.action === "BROADCAST")
      assert.equal(review.transactionId, keccak256("0x01"));
    return text;
  };
  try {
    await runPilotSession(f.journal, source, f.adapters, f.now, "first");
    assert.deepEqual(actions, ["SIGN", "BROADCAST"]);
    assert.deepEqual(f.counts(), { signs: 1, sends: 1 });
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now, "second"),
      /ALREADY_CONSUMED/,
    );
  } finally {
    f.journal.close();
  }
});

test("expiry while awaiting signing approval never signs", async () => {
  const f = fixture();
  f.adapters.approve = async (_r, t) => {
    f.advance();
    return t;
  };
  try {
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now),
      /EXPIRED/,
    );
    assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
  } finally {
    f.journal.close();
  }
});

test("expiry during signing retains the signed identity and prevents broadcast", async () => {
  const f = fixture(),
    sign = f.adapters.sign;
  f.adapters.sign = async (p, a) => {
    const b = await sign(p, a);
    f.advance();
    return b;
  };
  try {
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now),
      /EXPIRED/,
    );
    assert.deepEqual(f.counts(), { signs: 1, sends: 0 });
    assert.deepEqual(f.journal.priorTransactions(source), [keccak256("0x01")]);
  } finally {
    f.journal.close();
  }
});

test("expiry before separate broadcast approval aborts with no submission", async () => {
  const f = fixture();
  f.adapters.approve = async (r, t) => {
    if (r.action === "BROADCAST") f.advance();
    return t;
  };
  try {
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now),
      /EXPIRED/,
    );
    assert.deepEqual(f.counts(), { signs: 1, sends: 0 });
  } finally {
    f.journal.close();
  }
});

test("SIGN approval cannot be replayed as BROADCAST approval", async () => {
  const f = fixture();
  let signingText = "";
  f.adapters.approve = async (r, t) => {
    if (r.action === "SIGN") signingText = t;
    return signingText;
  };
  try {
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now),
      /EXACT_APPROVAL/,
    );
    assert.deepEqual(f.counts(), { signs: 1, sends: 0 });
  } finally {
    f.journal.close();
  }
});

test("approval from another session cannot sign a new quote", async () => {
  const f = fixture();
  f.adapters.approve = async (r) =>
    pilotApprovalText({ ...r, sessionId: "old-session" });
  try {
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now),
      /EXACT_APPROVAL/,
    );
    assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
  } finally {
    f.journal.close();
  }
});

test("nonce changes after either approval fail closed", async () => {
  for (const phase of ["SIGN", "BROADCAST"]) {
    const f = fixture();
    f.adapters.approve = async (r, t) => {
      if (r.action === phase) f.changeNonce();
      return t;
    };
    try {
      await assert.rejects(
        runPilotSession(f.journal, source, f.adapters, f.now),
        /NONCE_CHANGED/,
      );
      assert.equal(f.counts().sends, 0);
      assert.equal(f.counts().signs, phase === "SIGN" ? 0 : 1);
    } finally {
      f.journal.close();
    }
  }
});

test("unknown submission outcome permanently consumes the source", async () => {
  const f = fixture();
  f.adapters.submit = async () => {
    throw Error("UNCERTAIN");
  };
  try {
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now, "first"),
      /UNCERTAIN/,
    );
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now, "second"),
      /ALREADY_CONSUMED/,
    );
  } finally {
    f.journal.close();
  }
});

test("signer uncertainty blocks an automatic replacement session", async () => {
  const f = fixture();
  f.adapters.sign = async () => {
    throw Error("SIGNER_IO_FAILED");
  };
  try {
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now, "first"),
      /SIGNER_IO_FAILED/,
    );
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now, "second"),
      /UNIQUE/,
    );
  } finally {
    f.journal.close();
  }
});

test("changed approved recipient and debit are rejected before signing", async () => {
  const f = fixture();
  f.adapters.approve = async (_r, t) => {
    f.plan.terms.amount = "1001";
    return t;
  };
  try {
    await assert.rejects(
      runPilotSession(f.journal, source, f.adapters, f.now),
      /MISMATCH|STATE_CHANGED/,
    );
    assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
  } finally {
    f.journal.close();
  }
});
