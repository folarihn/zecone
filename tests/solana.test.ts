// Synthetic fixtures unless explicitly documented as read-only live evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  blockhash,
  getBase64EncodedWireTransaction,
  generateKeyPairSigner,
  getTransactionDecoder,
  getTransactionEncoder,
} from "@solana/kit";
import {
  Devnet,
  GENESIS,
  TOKEN,
  TOKEN2022,
  publicKey,
} from "../services/solana/network.ts";
import {
  transaction,
  inspect,
  prepare,
  validateAction,
  type Action,
  type Prepared,
  validateToken,
} from "../services/solana/transactions.ts";
import { decimal, tokenView } from "../services/solana/tokens.ts";
import { SolanaJournal } from "../services/solana/journal.ts";
import { SolanaPermissions } from "../services/solana/provider.ts";
import { corroborate } from "../services/solana/confirmation.ts";
import { exerciseSolanaDestination } from "../services/execution/solana-destination.ts";
import { signReviewed } from "../services/solana/signing.ts";
import { Accounts } from "../services/solana/accounts.ts";
import { phase7Backend } from "../services/wallet/phase7a-backend.ts";
import { Sessions } from "../services/wallet/security.ts";
const owner = (await generateKeyPairSigner()).address,
  recipient = (await generateKeyPairSigner()).address;
const disposable = [owner, recipient];
const action: Action = {
  family: "solana",
  network: "solana:devnet",
  genesis: GENESIS,
  owner,
  recipient,
  amount: "1000000",
  feeCap: "10000",
  asset: { kind: "SOL" },
};
const lifetime = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 123n,
};
const fakeNet = (overrides: any = {}) =>
  ({
    latest: async () => lifetime,
    fee: async () => 5000n,
    valid: async () => true,
    simulate: async () => ({ err: null, unitsConsumed: 150n }),
    ...overrides,
  }) as Devnet;
const prepared = () => prepare(fakeNet(), action, disposable);
test("RPC outage retries are bounded, concurrent reads are refused, and abort signals reach transport", async () => {
  let calls = 0;
  const rpc: any = {
    getGenesisHash: () => ({
      send: async ({ abortSignal }: any) => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        if (abortSignal.aborted) throw Error("timeout");
        return GENESIS;
      },
    }),
  };
  const net = new Devnet(rpc, 5);
  const first = net.read(async () => true);
  await assert.rejects(
    net.read(async () => true),
    /RPC_BUSY/,
  );
  await assert.rejects(first, /RPC_UNAVAILABLE/);
  assert.equal(calls, 3);
});
test("confidential Token-2022 balances are unavailable, never a fabricated zero", async () => {
  const row = {
    pubkey: recipient,
    account: {
      owner: TOKEN2022,
      data: {
        parsed: {
          info: {
            owner,
            mint: owner,
            state: "initialized",
            tokenAmount: { amount: "0", decimals: 6 },
            extensions: [{ extension: "confidentialTransferAccount" }],
          },
        },
      },
    },
  };
  const result = await tokenView(row, owner, TOKEN2022);
  assert.equal(result.balance, null);
  assert.equal(result.encrypted, true);
  assert.equal(result.transferSupported, false);
});
test("isolated Ed25519 signing requires exact approval and persists signed bytes without submission", async () => {
  const key = await generateKeyPairSigner();
  const a = { ...action, owner: key.address };
  const allowed = [key.address, recipient];
  const p = await prepare(fakeNet(), a, allowed),
    j = new SolanaJournal(new DatabaseSync(":memory:"));
  j.save("sign", p);
  const locked = new Accounts();
  await assert.rejects(
    signReviewed(j, fakeNet(), locked, "sign", p.digest, true, allowed),
    /WALLET_LOCKED/,
  );
  const ephemeral = { signer: () => key } as unknown as Accounts;
  await assert.rejects(
    signReviewed(j, fakeNet(), ephemeral, "sign", p.digest, false, allowed),
    /APPROVAL_REQUIRED/,
  );
  const result = await signReviewed(
    j,
    fakeNet(),
    ephemeral,
    "sign",
    p.digest,
    true,
    allowed,
  );
  assert.equal(j.get("sign")?.signature, result.signature);
  assert.equal(j.get("sign")?.state, "SIGNED_NOT_SUBMITTED");
  assert.equal(
    j.db.prepare("SELECT wire FROM solana_signed WHERE id=?").get("sign")?.wire,
    result.wire,
  );
  await assert.rejects(
    signReviewed(j, fakeNet(), ephemeral, "sign", p.digest, true, allowed),
    /DUPLICATE/,
  );
  assert.throws(() => j.submit());
  j.db.close();
});
test("manual EVM backend uses a disposable ownership challenge and disables all settlement entrypoints", async () => {
  const sessions = new Sessions(new DatabaseSync(":memory:"));
  const { session } = sessions.pair(sessions.issuePairing());
  const backend = phase7Backend(sessions),
    challenge = backend.challenge(session);
  assert.match(challenge.message, /disposable account ownership/);
  await assert.rejects(backend.connect(session, challenge.id, false));
  assert.equal(
    (await backend.connect(session, challenge.id, true)).connected,
    true,
  );
  await assert.rejects(backend.connect(session, challenge.id, true));
  for (const operation of [
    "create",
    "quote",
    "pay",
    "recheck",
    "paymentRequest",
    "refresh",
  ] as const)
    assert.throws(() => backend[operation](), /Disabled/);
  assert.equal(backend.dashboard().zcash, null);
  sessions.db.close();
});
test("devnet identity rejects a mainnet or truncated genesis before any account query", async () => {
  for (const genesis of ["mainnet", GENESIS.slice(0, 32)]) {
    const rpc: any = { getGenesisHash: () => ({ send: async () => genesis }) };
    await assert.rejects(new Devnet(rpc).balance(owner), /WRONG_NETWORK/);
  }
});
test("public key and destination allowlist reject invalid/mismatched accounts and caps", () => {
  assert.throws(() => publicKey("0x1234"), /INVALID_PUBLIC_KEY/);
  assert.throws(() =>
    validateAction({ ...action, recipient: owner }, disposable),
  );
  assert.throws(() =>
    validateAction({ ...action, network: "mainnet" as any }, disposable),
  );
  assert.throws(() =>
    validateAction({ ...action, amount: "10000001" }, disposable),
  );
  assert.throws(() =>
    validateAction({ ...action, feeCap: "100001" }, disposable),
  );
});
test("token amounts retain integer precision and reject invalid decimals/mints", () => {
  assert.equal(decimal("18446744073709551615", 9), "18446744073.709551615");
  assert.equal(decimal("1", 0), "1");
  assert.throws(() => decimal("1", 256));
  assert.throws(() => decimal("1", -1));
  assert.throws(() => decimal("1.1", 9));
  assert.throws(() =>
    validateAction(
      { ...action, asset: { kind: "SPL", mint: "invalid", decimals: 9 } },
      disposable,
    ),
  );
});
test("Token-2022 extensions and frozen accounts are displayed but never transferable", async () => {
  const row = {
    pubkey: recipient,
    account: {
      owner: TOKEN2022,
      data: {
        parsed: {
          info: {
            owner,
            mint: owner,
            state: "initialized",
            tokenAmount: { amount: "25", decimals: 2 },
            extensions: [{ extension: "transferHook" }],
          },
        },
      },
    },
  };
  const v = await tokenView(row, owner, TOKEN2022);
  assert.equal(v.balance, "0.25");
  assert.equal(v.transferSupported, false);
  assert.deepEqual(v.extensions, ["transferHook"]);
  await assert.rejects(tokenView(row, recipient, TOKEN2022));
});
test("canonical SOL decoding rejects byte edits, extra programs/metas and fee-payer substitution", async () => {
  const p = await prepared();
  await inspect(p.wire, action, lifetime, disposable);
  const bytes = Buffer.from(p.wire, "base64");
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(
    inspect(bytes.toString("base64"), action, lifetime, disposable),
    /UNSUPPORTED_TRANSACTION/,
  );
  await assert.rejects(
    inspect(
      p.wire,
      { ...action, owner: recipient, recipient: owner },
      lifetime,
      disposable,
    ),
    /UNSUPPORTED_TRANSACTION/,
  );
  await assert.rejects(inspect(p.wire + "AA", action, lifetime, disposable));
  const decoded = getTransactionDecoder().decode(Buffer.from(p.wire, "base64"));
  for (const edit of ["writable-program", "unknown-program"] as const) {
    const messageBytes = new Uint8Array(decoded.messageBytes);
    if (edit === "writable-program") messageBytes[2] = 0;
    else messageBytes[4 + 2 * 32] = 1;
    const malicious = Buffer.from(
      getTransactionEncoder().encode({ ...decoded, messageBytes } as any),
    ).toString("base64");
    await assert.rejects(inspect(malicious, action, lifetime, disposable));
  }
});
test("canonical SPL transfer uses checked decimals and bounded owner ATAs", async () => {
  const spl: Action = {
    ...action,
    asset: { kind: "SPL", mint: owner, decimals: 6 },
  };
  const wire = getBase64EncodedWireTransaction(
    await transaction(spl, lifetime),
  );
  await inspect(wire, spl, lifetime, disposable);
  await assert.rejects(
    inspect(
      wire,
      { ...spl, asset: { kind: "SPL", mint: owner, decimals: 9 } },
      lifetime,
      disposable,
    ),
  );
});
test("SPL preflight refuses missing/Token-2022/freezeable mints", async () => {
  const spl: Action = {
    ...action,
    asset: { kind: "SPL", mint: owner, decimals: 6 },
  };
  for (const mint of [
    null,
    { owner: TOKEN2022 },
    {
      owner: TOKEN,
      data: {
        parsed: {
          type: "mint",
          info: {
            isInitialized: true,
            decimals: 6,
            freezeAuthority: recipient,
          },
        },
      },
    },
  ])
    await assert.rejects(
      validateToken(fakeNet({ account: async () => mint }), spl),
      /UNSUPPORTED_MINT/,
    );
});
test("simulation failure cannot become approval-ready; expired blockhash and high fees fail", async () => {
  const failed = await prepare(
    fakeNet({ simulate: async () => ({ err: "InsufficientFunds" }) }),
    action,
    disposable,
  );
  assert.equal(failed.state, "SIMULATION_FAILED");
  await assert.rejects(
    prepare(fakeNet({ valid: async () => false }), action, disposable),
    /BLOCKHASH_EXPIRED/,
  );
  await assert.rejects(
    prepare(fakeNet({ fee: async () => 20000n }), action, disposable),
    /FEE_UNAVAILABLE/,
  );
});
test("durable idempotency, duplicate signature and submission protections", async () => {
  const j = new SolanaJournal(new DatabaseSync(":memory:")),
    p = await prepared();
  j.save("one", p);
  assert.equal(j.save("one", p).id, "one");
  assert.throws(
    () => j.save("one", { ...p, action: { ...action, amount: "2" } }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () => j.claimSigning("one", p.digest, false),
    /APPROVAL_REQUIRED/,
  );
  j.claimSigning("one", p.digest, true);
  assert.throws(() => j.claimSigning("one", p.digest, true), /DUPLICATE/);
  j.recordSignature("one", "synthetic-signature", "synthetic-wire");
  j.save("two", p);
  j.claimSigning("two", p.digest, true);
  assert.throws(() =>
    j.recordSignature("two", "synthetic-signature", "synthetic-wire"),
  );
  assert.equal(j.get("two")?.state, "SIGNING");
  assert.throws(() => j.submit(), /LIVE_BROADCAST_DISABLED/);
  j.db.close();
});
test("restart recovery preserves ambiguous signing; recovery and execution exclude each other", async () => {
  mkdirSync(".state/phase7a/tests", { recursive: true });
  const file = `.state/phase7a/tests/${randomUUID()}.sqlite`;
  let j = new SolanaJournal(new DatabaseSync(file));
  const p = await prepared();
  j.save("one", p);
  j.claimSigning("one", p.digest, true);
  j.db.close();
  j = new SolanaJournal(new DatabaseSync(file));
  assert.equal(j.get("one")?.state, "MANUAL_REVIEW");
  assert.throws(() => j.claimSigning("one", p.digest, true));
  j.save("two", p);
  j.recovery("two");
  assert.throws(() => j.claimSigning("two", p.digest, true));
  assert.throws(() => j.recovery("one"));
  j.db.close();
});
test("origin permissions, session binding, rejection, replay and revoke are enforced", () => {
  const p = new SolanaPermissions(new DatabaseSync(":memory:"), disposable);
  assert.throws(
    () => p.request("https://evil.example", "s", "signTransaction"),
    /UNAUTHORIZED_ORIGIN/,
  );
  const r = p.request("https://good.example", "s", "connect");
  assert.throws(() => p.approve(r.id, "other", owner, true));
  assert.equal(p.approve(r.id, "s", owner, true).address, owner);
  assert.equal(p.account("https://evil.example"), null);
  assert.throws(() => p.approve(r.id, "s", owner, true));
  const sign = p.request("https://good.example", "s", "signMessage");
  assert.throws(
    () => p.approve(sign.id, "s", owner, true),
    /BROWSER_SIGNING_DISABLED/,
  );
  p.revoke("https://good.example");
  assert.equal(p.account("https://good.example"), null);
  p.db.close();
});
test("RPC finalization requires agreement; outages/processed are not settled", async () => {
  assert.equal(
    await corroborate(
      { status: async () => "FINALIZED" },
      { status: async () => "CONFIRMED" },
      "fixture",
    ),
    "RPC_DISAGREEMENT",
  );
  assert.equal(
    await corroborate(
      {
        status: async () => {
          throw Error();
        },
      },
      { status: async () => "FINALIZED" },
      "fixture",
    ),
    "RPC_UNAVAILABLE",
  );
  assert.equal(
    await corroborate(
      { status: async () => "PROCESSED" },
      { status: async () => "PROCESSED" },
      "fixture",
    ),
    "PROCESSED",
  );
});
test("synthetic verified ZEC authorizes only a nonbroadcast Solana simulation; historical/replayed payments rejected", async () => {
  const j = new SolanaJournal(new DatabaseSync(":memory:"));
  const input = {
    fixture: true as const,
    paymentId: "synthetic:payment",
    verifiedConfirmations: 10,
    quote: {
      family: "solana" as const,
      network: "solana:devnet" as const,
      action,
      orderId: "fixture-one",
      expires: Date.now() + 10000,
      paymentZatoshis: "100000",
      liveExecution: false as const,
    },
  };
  const p = await exerciseSolanaDestination(input, fakeNet(), j, disposable);
  assert.equal(p.state, "AWAITING_EXPLICIT_APPROVAL");
  await assert.rejects(
    exerciseSolanaDestination(
      { ...input, paymentId: "historical-tx" },
      fakeNet(),
      j,
      disposable,
    ),
    /LIVE_SETTLEMENT_DISABLED/,
  );
  await assert.rejects(
    exerciseSolanaDestination(
      { ...input, verifiedConfirmations: 0 },
      fakeNet(),
      j,
      disposable,
    ),
  );
  await assert.rejects(
    exerciseSolanaDestination(
      { ...input, quote: { ...input.quote, orderId: "fixture-two" } },
      fakeNet(),
      j,
      disposable,
    ),
    /PAYMENT_REPLAY/,
  );
  j.recovery("fixture-one");
  await assert.rejects(
    exerciseSolanaDestination(input, fakeNet(), j, disposable),
    /EXECUTION_RECOVERY_CONFLICT/,
  );
  j.db.close();
});
test("Wallet Standard discovery is separate, devnet-only and has no send capability", async () => {
  let wallet: any;
  const events = new Map<string, Function>();
  const w: any = {
    addEventListener: (n: string, f: Function) => events.set(n, f),
    dispatchEvent: (e: any) => e.detail({ register: (v: any) => (wallet = v) }),
  };
  w.top = w;
  runInNewContext(readFileSync("extension/solana.js", "utf8"), {
    window: w,
    CustomEvent: class {
      detail: any;
      constructor(n: string, v: any) {
        this.detail = v.detail;
      }
    },
    crypto: { randomUUID },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Uint8Array,
  });
  assert.equal(wallet.name, "ZecOne");
  assert.deepEqual(Array.from(wallet.chains), ["solana:devnet"]);
  assert.equal(wallet.features["solana:signAndSendTransaction"], undefined);
  assert.equal(w.ethereum, undefined);
  assert.equal(
    (await wallet.features["standard:connect"].connect({ silent: true }))
      .accounts.length,
    0,
  );
  await assert.rejects(
    wallet.features["solana:signMessage"].signMessage({
      account: {},
      message: new Uint8Array([1]),
    }),
    { code: 4100 },
  );
});
