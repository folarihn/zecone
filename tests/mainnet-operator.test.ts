// Disposable credentials and synthetic transactions only. No live key, network,
// signature or broadcast is used by these tests.
import assert from "node:assert/strict";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  generateBaseMainnetKey,
  generateSolanaMainnetKey,
  sealMainnetCredential,
  writeMainnetKeystore,
} from "../services/provisioning/mainnet-keystore.ts";
import {
  addressBinding,
  SOLANA_MAINNET_GENESIS,
} from "../services/settlement/mainnet-address.ts";
import { MainnetExecutionLease } from "../services/settlement/mainnet-operator-lease.ts";
import {
  MainnetOfflineSigner,
  revokeMainnetSigner,
  type MainnetSigningApproval,
} from "../services/settlement/mainnet-signer.ts";
import {
  mainnetTransferTerms,
  preparedDigest,
  termsDigest,
  type BaseUnsigned,
  type MainnetPrepared,
  type MainnetTransferTerms,
  type SolanaUnsigned,
} from "../services/settlement/mainnet-transfer.ts";
import type { ProductionProfile } from "../services/settlement/production-safety.ts";

const now = 1_800_000_000;

function baseProfile(
  key: Awaited<ReturnType<typeof generateBaseMainnetKey>>,
  recipient: string,
): ProductionProfile {
  return {
    network: "base",
    enabled: true,
    providers: [
      { endpoint: "https://one.invalid", operator: "one" },
      { endpoint: "https://two.invalid", operator: "two" },
    ],
    independenceAcknowledged: true,
    relayer: key.address,
    recipients: [recipient],
    perTransaction: "100000",
    daily: "200000",
    feeCap: "30000",
    confirmations: 1,
    signer: {
      identity: "disposable-base",
      publicKey: key.publicKey,
      transport: "offline-bundle",
      separateDeviceValidated: true,
      attestationReference: "disposable-test",
    },
  };
}

function baseTerms(
  profile: ProductionProfile,
  recipient: string,
  amount = "1000",
  feeCap = "25000",
  expires = now + 600,
): MainnetTransferTerms {
  return mainnetTransferTerms(
    profile,
    {
      recipient,
      amount,
      feeCap,
      l1DataFeeBound: "100",
      sourceZatoshis: "100000",
      sourcePaymentCommitment: randomBytes(32).toString("hex"),
      destinationBinding: addressBinding("base", recipient),
      quoteDigest: "a".repeat(64),
      expires,
    },
    now,
  );
}

function basePrepared(terms: MainnetTransferTerms): BaseUnsigned {
  return {
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
    blockHash: `0x${"1".repeat(64)}`,
    blockNumber: "100",
    gasFee: "21000",
    l1DataFeeBound: terms.l1DataFeeBound,
    maximumDestinationDebit: terms.maximumDestinationDebit,
    quoteDigest: "b".repeat(64),
  };
}

function approval(
  terms: MainnetTransferTerms,
  prepared: MainnetPrepared,
  over: Partial<MainnetSigningApproval> = {},
): MainnetSigningApproval {
  return {
    version: 1,
    termsDigest: termsDigest(terms),
    preparedDigest: preparedDigest(prepared),
    maximumDestinationDebit: terms.maximumDestinationDebit,
    expires: now + 300,
    ...over,
  };
}

async function writeCredential(
  root: string,
  secret: Buffer,
  purpose: "mainnet:base:relayer" | "mainnet:solana:relayer",
) {
  const passphrase = randomBytes(48),
    keystore = join(root, "relayer.keystore.json"),
    passFile = join(root, "passphrase");
  writeMainnetKeystore(
    keystore,
    await sealMainnetCredential(secret, passphrase, purpose),
  );
  writeFileSync(passFile, passphrase);
  return { keystore, passFile, passphrase };
}

test("single-writer lease fences a stale process and requires explicit expired recovery", () => {
  let clock = now;
  const lease = new MainnetExecutionLease(":memory:", () => clock);
  try {
    assert.equal(lease.status().state, "absent");
    assert.equal(lease.status().paused, true);
    const first = lease.acquire("worker-a", { ttlSeconds: 60 });
    assert.equal(first.fence, 1);
    assert.throws(
      () => lease.acquire("worker-b", { ttlSeconds: 60 }),
      /LEASE_HELD/,
    );
    const stale = lease.guard(first.token);
    lease.pause("operator emergency");
    assert.throws(stale, /OPERATOR_PAUSED/);
    assert.throws(() => lease.arm("WRONG"), /EXPLICIT_OPERATOR_ARM_REQUIRED/);
    lease.arm("ARM_MAINNET_EXECUTION");
    assert.equal(stale(), true);
    clock += 61;
    assert.throws(() => lease.heartbeat(first.token), /LEASE_LOST/);
    assert.throws(() => lease.acquire("worker-b"), /RECOVERY_APPROVAL/);
    const recovered = lease.acquire("worker-b", {
      recoverExpired: true,
      ttlSeconds: 60,
    });
    assert.equal(recovered.fence, 2);
    assert.equal(lease.status().recoveries, 1);
    assert.throws(stale, /LEASE_LOST/);
    lease.release(recovered.token);
    assert.equal(lease.status().state, "absent");
    assert.equal(lease.status().fence, 2);
    const next = lease.acquire("worker-c", { ttlSeconds: 60 });
    assert.equal(next.fence, 3);
  } finally {
    lease.close();
  }
});

test("isolated Base signer requires exact prepared approval and signs only the prepared transfer", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "zecone-mainnet-signer-")),
    key = await generateBaseMainnetKey(),
    recipient = privateKeyToAccount(generatePrivateKey()).address,
    profile = baseProfile(key, recipient),
    credential = await writeCredential(
      root,
      key.secret,
      "mainnet:base:relayer",
    );
  t.after(() => {
    key.secret.fill(0);
    credential.passphrase.fill(0);
  });
  await assert.rejects(
    MainnetOfflineSigner.open({
      profile,
      keystorePath: credential.keystore,
      passphrasePath: credential.passFile,
      limits: { perTransaction: "50000", daily: "80000" },
      ledgerPath: ":memory:",
      now: () => now,
    }),
    /DURABLE_SIGNER_LEDGER_REQUIRED/,
  );
  const signer = await MainnetOfflineSigner.open({
    profile,
    keystorePath: credential.keystore,
    passphrasePath: credential.passFile,
    limits: { perTransaction: "50000", daily: "80000" },
    ledgerPath: join(root, "signer-ledger.sqlite"),
    now: () => now,
  });
  try {
    assert.equal(signer.address, key.address);
    const terms = baseTerms(profile, recipient),
      prepared = basePrepared(terms);
    await assert.rejects(
      signer.sign(
        terms,
        prepared,
        approval(terms, prepared, { preparedDigest: "0".repeat(64) }),
      ),
      /EXACT_SIGNER_APPROVAL_REQUIRED/,
    );
    await assert.rejects(
      signer.sign(
        terms,
        prepared,
        approval(terms, prepared, { expires: now + 901 }),
      ),
      /EXACT_SIGNER_APPROVAL_REQUIRED/,
    );
    const bundle = await signer.sign(
      terms,
      prepared,
      approval(terms, prepared),
    );
    assert.equal(bundle.network, "base");
    assert.equal(bundle.termsDigest, termsDigest(terms));
    assert.equal(bundle.preparedDigest, preparedDigest(prepared));
    assert.match(bundle.signed, /^0x[0-9a-f]+$/);
    const { parseTransaction } = await import("viem");
    assert.equal(
      parseTransaction(bundle.signed as `0x${string}`).to?.toLowerCase(),
      recipient.toLowerCase(),
    );

    const secondTerms = baseTerms(profile, recipient, "2000", "25000"),
      secondPrepared = basePrepared(secondTerms);
    await signer.sign(
      secondTerms,
      secondPrepared,
      approval(secondTerms, secondPrepared),
    );
    const thirdTerms = baseTerms(profile, recipient, "3000", "25000"),
      thirdPrepared = basePrepared(thirdTerms);
    await assert.rejects(
      signer.sign(
        thirdTerms,
        thirdPrepared,
        approval(thirdTerms, thirdPrepared),
      ),
      /SIGNER_DAILY_LIMIT/,
    );
    const otherLedger = join(root, "other.sqlite"),
      otherDb = new DatabaseSync(otherLedger);
    otherDb.exec("CREATE TABLE unrelated(id INTEGER)");
    otherDb.close();
    await assert.rejects(
      MainnetOfflineSigner.open({
        profile,
        keystorePath: credential.keystore,
        passphrasePath: credential.passFile,
        limits: { perTransaction: "50000", daily: "80000" },
        ledgerPath: otherLedger,
        now: () => now,
      }),
      /INVALID_SIGNER_LEDGER/,
    );
    assert.throws(
      () => revokeMainnetSigner(otherLedger, "operator revoke", now),
      /INVALID_SIGNER_LEDGER/,
    );
    assert.throws(
      () =>
        revokeMainnetSigner(
          join(root, "missing-ledger.sqlite"),
          "operator revoke",
          now,
        ),
      /SIGNER_LEDGER_NOT_FOUND/,
    );
    revokeMainnetSigner(
      join(root, "signer-ledger.sqlite"),
      "operator revoke",
      now,
    );
    const fourthTerms = baseTerms(profile, recipient, "1000", "25000"),
      fourthPrepared = basePrepared(fourthTerms);
    await assert.rejects(
      signer.sign(
        fourthTerms,
        fourthPrepared,
        approval(fourthTerms, fourthPrepared),
      ),
      /SIGNER_REVOKED/,
    );
  } finally {
    signer.close();
  }
});

test("isolated Solana signer signs exactly the prepared message without a network call", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "zecone-mainnet-signer-")),
    key = await generateSolanaMainnetKey(),
    recipient = (await generateSolanaMainnetKey()).address,
    profile: ProductionProfile = {
      network: "solana",
      enabled: true,
      providers: [
        { endpoint: "https://one.invalid", operator: "one" },
        { endpoint: "https://two.invalid", operator: "two" },
      ],
      independenceAcknowledged: true,
      relayer: key.address,
      recipients: [recipient],
      perTransaction: "1010000",
      daily: "1010000",
      feeCap: "10000",
      confirmations: 1,
      signer: {
        identity: "disposable-solana",
        publicKey: key.publicKey,
        transport: "offline-bundle",
        separateDeviceValidated: true,
        attestationReference: "disposable-test",
      },
    },
    credential = await writeCredential(
      root,
      key.secret,
      "mainnet:solana:relayer",
    ),
    terms = mainnetTransferTerms(
      profile,
      {
        recipient,
        amount: "1000000",
        feeCap: "5000",
        sourceZatoshis: "100000",
        sourcePaymentCommitment: "d".repeat(64),
        destinationBinding: addressBinding("solana", recipient),
        expires: now + 600,
      },
      now,
    ),
    lifetime = {
      blockhash: blockhash("11111111111111111111111111111112"),
      lastValidBlockHeight: 200n,
    },
    message = pipe(
      createTransactionMessage({ version: "legacy" }),
      (m) => setTransactionMessageFeePayer(key.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getTransferSolInstruction({
              source: createNoopSigner(key.address),
              destination: recipient,
              amount: 1_000_000n,
            }),
          ],
          m,
        ),
    ),
    compiled = compileTransaction(message),
    unsignedWire = getBase64EncodedWireTransaction(compiled),
    prepared: SolanaUnsigned = {
      kind: "solana-unsigned",
      termsDigest: termsDigest(terms),
      genesis: SOLANA_MAINNET_GENESIS,
      unsignedWire,
      messageBase64: Buffer.from(compiled.messageBytes).toString("base64"),
      blockhash: lifetime.blockhash,
      lastValidBlockHeight: "200",
      slot: 100,
      fee: "5000",
      maximumDestinationDebit: terms.maximumDestinationDebit,
      quoteDigest: "e".repeat(64),
    };
  t.after(() => {
    key.secret.fill(0);
    credential.passphrase.fill(0);
  });
  const signer = await MainnetOfflineSigner.open({
    profile,
    keystorePath: credential.keystore,
    passphrasePath: credential.passFile,
    limits: { perTransaction: "1010000", daily: "1010000" },
    ledgerPath: join(root, "signer-ledger.sqlite"),
    now: () => now,
  });
  try {
    const bundle = await signer.sign(
        terms,
        prepared,
        approval(terms, prepared),
      ),
      decoded = getTransactionDecoder().decode(
        Buffer.from(bundle.signed, "base64"),
      ),
      signature = (decoded.signatures as Record<string, Uint8Array>)[
        key.address
      ];
    assert.ok(signature);
    assert.equal(signature.length, 64);
    assert.deepEqual(
      Buffer.from(decoded.messageBytes),
      Buffer.from(compiled.messageBytes),
    );
    const publicKey = createPublicKey(key.publicKey).export({
        format: "jwk",
      }) as JsonWebKey,
      raw = Buffer.from(publicKey.x!, "base64url");
    assert.equal(
      verify(
        null,
        Buffer.from(compiled.messageBytes),
        createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
          format: "jwk",
        }),
        Buffer.from(signature),
      ),
      true,
    );
    const tampered = compileTransaction(
        pipe(
          createTransactionMessage({ version: "legacy" }),
          (m) => setTransactionMessageFeePayer(key.address, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
          (m) =>
            appendTransactionMessageInstructions(
              [
                getTransferSolInstruction({
                  source: createNoopSigner(key.address),
                  destination: recipient,
                  amount: 999_999n,
                }),
              ],
              m,
            ),
        ),
      ),
      tamperedPrepared: SolanaUnsigned = {
        ...prepared,
        unsignedWire: getBase64EncodedWireTransaction(tampered),
        messageBase64: Buffer.from(tampered.messageBytes).toString("base64"),
      };
    await assert.rejects(
      signer.sign(terms, tamperedPrepared, approval(terms, tamperedPrepared)),
      /PREPARED_TRANSFER_POLICY_MISMATCH/,
    );
  } finally {
    signer.close();
  }
});
