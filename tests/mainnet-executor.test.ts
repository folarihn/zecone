// Disposable keys and synthetic RPC responses only. No live key, payment or broadcast.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicKey,
  generateKeyPairSync,
  sign as signMessage,
} from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem";
import {
  mainnetQuote,
  mainnetQuoteContext,
  type MainnetQuoteInput,
} from "../services/settlement/mainnet-quote.ts";
import {
  buildSingleOperatorPilotPriceStatement,
  signSingleOperatorPilotPrice,
} from "../services/settlement/mainnet-pilot-pricing.ts";
import {
  executeMainnetTransfer,
  executionAuthorizationPayload,
  reconcileMainnetTransfer,
  type MainnetExecutionAuthorization,
} from "../services/settlement/mainnet-executor.ts";
import {
  addressBinding,
  SOLANA_MAINNET_GENESIS,
} from "../services/settlement/mainnet-address.ts";
import {
  mainnetTransferTerms,
  prepareMainnetTransfer,
  preparedDigest,
  termsDigest,
  verifyMainnetSignedBundle,
  type BaseUnsigned,
  type MainnetSignedBundle,
  type SolanaUnsigned,
} from "../services/settlement/mainnet-transfer.ts";
import { MainnetSubmissionJournal } from "../services/settlement/mainnet-submitter.ts";
import type { ProductionProfile } from "../services/settlement/production-safety.ts";
import {
  MainnetWatchJournal,
  MainnetWatchScanner,
} from "../services/settlement/mainnet-watch.ts";

const now = Math.floor(Date.now() / 1000);

async function verifiedPayment() {
  const account = "9".repeat(64),
    address = `u1${"q".repeat(60)}`,
    snapshot = {
      network: "zcash-mainnet",
      watchOnly: true,
      liveChain: true,
      liveRefundsEnabled: false,
      source: "https://one.example.org",
      peerSource: "https://two.example.org",
      account,
      address,
      birthday: 10,
      tip: 110,
      scanned: 110,
      blockHash: "1".repeat(64),
      observedAt: now,
      minimumConfirmations: 20,
      anchor: "2".repeat(64),
      anchorHeight: 91,
      checkpoint: null,
      payments: [
        {
          account,
          txid: "3".repeat(64),
          pool: 3,
          index: 0,
          zatoshis: "100000",
          height: 90,
          blockHash: "4".repeat(64),
          address,
          memo: null,
          nullifier: null,
          locked: false,
          spent: false,
          isChange: false,
          confirmations: 21,
          ownershipEvidence: {
            scheme: "zcash-full-transaction-ufvk-v3",
            digest: "5".repeat(64),
            providers: 2,
            blockEvidence: {
              scheme: "zcash-header-pow-merkle-v1",
              height: 90,
              headerHash: "4".repeat(64),
              merkleRoot: "7".repeat(64),
              transactionIndex: 0,
              transactionCount: 1,
              proofOfWork: "PASS",
              readOnly: true,
            },
            chainEvidence: {
              scheme: "zcash-pow-chain-segment-v1",
              startHeight: 90,
              endHeight: 109,
              startHash: "4".repeat(64),
              endHash: "8".repeat(64),
              blockCount: 20,
              accumulatedWork: "1234abcd",
              proofOfWork: "PASS",
              continuity: "PASS",
              readOnly: true,
            },
          },
        },
      ],
    } as const,
    directory = mkdtempSync(join(tmpdir(), "zecone-mainnet-native-")),
    script = join(directory, "native-output.mjs");
  writeFileSync(
    script,
    `process.stdout.write(${JSON.stringify(JSON.stringify(snapshot))});`,
  );
  const scanner = new MainnetWatchScanner(
      directory,
      snapshot.source,
      snapshot.peerSource,
      {
        network: "zcash",
        enabled: true,
        providers: [
          { endpoint: snapshot.source, operator: "primary" },
          { endpoint: snapshot.peerSource, operator: "secondary" },
        ],
        independenceAcknowledged: true,
        confirmations: snapshot.minimumConfirmations,
      },
      process.execPath,
      [script],
      directory,
    ),
    binding = {
      orderId: "6".repeat(64),
      account,
      address,
      zatoshis: "100000",
      expires: now + 600,
    },
    native = await scanner.observe(),
    watch = new MainnetWatchJournal(":memory:", () => now),
    payment = watch.observe(binding, native),
    rescan = async (payments: (typeof snapshot.payments)[number][] = []) => {
      writeFileSync(
        script,
        `process.stdout.write(${JSON.stringify(
          JSON.stringify({ ...snapshot, payments }),
        )});`,
      );
      return scanner.observe();
    };
  return { payment, watch, binding, rescan };
}

function secp256k1Pem(publicKey: `0x${string}`) {
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex"),
      Buffer.from(publicKey.slice(2), "hex"),
    ]),
    format: "der",
    type: "spki",
  })
    .export({ format: "pem", type: "spki" })
    .toString();
}

function ed25519Pem(raw: Uint8Array) {
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(raw),
    ]),
    format: "der",
    type: "spki",
  })
    .export({ format: "pem", type: "spki" })
    .toString();
}

async function fixture(
  loseResponse = false,
  extended = false,
  priceMoved = false,
) {
  const paymentState = await verifiedPayment(),
    { payment } = paymentState,
    relayer = privateKeyToAccount(generatePrivateKey()),
    recipient = privateKeyToAccount(generatePrivateKey()),
    authority = generateKeyPairSync("ed25519"),
    profile: ProductionProfile = {
      network: "base",
      enabled: true,
      providers: [
        { endpoint: "https://first.invalid", operator: "first" },
        { endpoint: "https://second.invalid", operator: "second" },
      ],
      independenceAcknowledged: true,
      relayer: relayer.address,
      recipients: [recipient.address],
      perTransaction: "1000000",
      daily: "2000000",
      feeCap: "50000",
      confirmations: 1,
      signer: {
        identity: "disposable-offline-signer",
        publicKey: secp256k1Pem(relayer.publicKey),
        transport: "offline-bundle",
        separateDeviceValidated: !extended,
        attestationReference: "disposable-test",
      },
      executionAuthority: {
        identity: "disposable-operator",
        publicKey: authority.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
        separateDeviceValidated: !extended,
        attestationReference: "disposable-test",
      },
      ...(extended
        ? ({
            pilot: {
              enabled: true,
              isolation: "single-device-process-isolation",
              operator: "test",
              expires: now + 3600,
              riskAccepted: "disposable-test",
              quoteValiditySeconds: 300,
              marketMovementBps: 200,
            },
          } as const)
        : {}),
    },
    marketContext = extended
      ? (() => {
          const input: MainnetQuoteInput = {
            network: "base",
            profile,
            pair: "ETH/ZEC",
            destinationUnits: 1000n,
            networkFee: 49900n,
            l1DataFee: 100n,
            serviceFee: 0n,
            now,
            ttlSeconds: 300,
          };
          const statement = buildSingleOperatorPilotPriceStatement(
            profile.executionAuthority!.identity,
            mainnetQuoteContext(input),
            ["coingecko", "coinpaprika"].map((provider) => ({
              provider,
              ethUsd: "100000000000",
              zecUsd: "0.1",
              at: now,
            })),
            now,
            now + 300,
            200,
            profile,
          );
          input.pilotPrice = {
            statement,
            signature: signSingleOperatorPilotPrice(
              statement,
              authority.privateKey,
            ).signature,
            publicKey: profile.executionAuthority!.publicKey,
          };
          return { quote: mainnetQuote(input), input };
        })()
      : undefined,
    terms = mainnetTransferTerms(
      profile,
      {
        recipient: recipient.address,
        amount: "1000",
        feeCap: "50000",
        l1DataFeeBound: "100",
        sourceZatoshis: "100000",
        sourcePaymentCommitment: payment.paymentDigest!,
        destinationBinding: addressBinding("base", recipient.address),
        quoteDigest: marketContext?.quote.quoteDigest ?? "b".repeat(64),
        expires: marketContext?.quote.expires ?? now + 600,
      },
      now,
    ),
    prepared: BaseUnsigned = {
      kind: "base-unsigned",
      termsDigest: termsDigest(terms),
      chainId: 8453,
      tx: {
        type: "legacy",
        chainId: 8453,
        to: recipient.address,
        value: "1000",
        data: "0x",
        nonce: 0,
        gas: "21000",
        gasPrice: "1",
      },
      blockHash: `0x${"1".repeat(64)}`,
      blockNumber: "100",
      gasFee: "21000",
      l1DataFeeBound: "100",
      maximumDestinationDebit: terms.maximumDestinationDebit,
      quoteDigest: "c".repeat(64),
    },
    raw = await relayer.signTransaction({
      type: "legacy",
      chainId: 8453,
      to: recipient.address,
      value: 1000n,
      data: "0x",
      nonce: 0,
      gas: 21000n,
      gasPrice: 1n,
    }),
    bundle: MainnetSignedBundle = {
      version: 1,
      network: "base",
      termsDigest: termsDigest(terms),
      preparedDigest: preparedDigest(prepared),
      signed: raw,
    };
  let sends = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    if (!init?.body) {
      const eth = priceMoved ? 105000000000 : 100000000000;
      return new Response(
        JSON.stringify(
          String(_url).includes("coingecko")
            ? { ethereum: { usd: eth }, zcash: { usd: 0.1 } }
            : {
                quotes: {
                  USD: {
                    price: String(_url).includes("eth-ethereum") ? eth : 0.1,
                  },
                },
              },
        ),
      );
    }
    const request = JSON.parse(String(init?.body));
    if (request.method === "eth_call")
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }),
      );
    if (request.method === "eth_chainId")
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" }),
      );
    if (request.method === "eth_getTransactionCount")
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }),
      );
    if (request.method === "eth_getBalance")
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xf4240" }),
      );
    if (request.method === "eth_getCode")
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }),
      );
    if (request.method === "eth_estimateGas")
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x5208" }),
      );
    if (request.method === "eth_getTransactionByHash")
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
      );
    if (request.method === "eth_sendRawTransaction") {
      sends++;
      if (loseResponse) throw Error("synthetic lost response");
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: keccak256(raw) }),
      );
    }
    throw Error(`unexpected synthetic method ${request.method}`);
  };
  const verified = await verifyMainnetSignedBundle(
      profile,
      terms,
      prepared,
      bundle,
      fetcher,
      now,
    ),
    payload = executionAuthorizationPayload(
      payment.orderId,
      terms,
      prepared,
      verified,
      now + 300,
      "d".repeat(64),
    ),
    authorization: MainnetExecutionAuthorization = {
      version: 1,
      ...payload,
      signature: signMessage(
        null,
        Buffer.from(JSON.stringify(payload)),
        authority.privateKey,
      ).toString("base64"),
    };
  return {
    payment,
    watch: paymentState.watch,
    binding: paymentState.binding,
    rescan: paymentState.rescan,
    profile,
    terms,
    prepared,
    bundle,
    authorization,
    marketContext,
    fetcher,
    sends: () => sends,
  };
}

test("extended pilot executor requires the fresh market gate and rejects moved prices before sending", async () => {
  for (const priceMoved of [false, true]) {
    const f = await fixture(false, true, priceMoved),
      journal = new MainnetSubmissionJournal(
        ":memory:",
        { perTransaction: "1000000", daily: "2000000", confirmations: 1 },
        () => now,
      );
    journal.resume();
    try {
      await assert.rejects(
        executeMainnetTransfer(
          journal,
          f.payment,
          f.profile,
          f.terms,
          f.prepared,
          f.bundle,
          f.authorization,
          f.fetcher,
          now,
        ),
        /MARKET_CONTEXT_REQUIRED/,
      );
      assert.equal(f.sends(), 0);
      const execute = () =>
        executeMainnetTransfer(
          journal,
          f.payment,
          f.profile,
          f.terms,
          f.prepared,
          f.bundle,
          f.authorization,
          f.fetcher,
          now,
          () => {},
          f.marketContext,
        );
      if (priceMoved) {
        await assert.rejects(execute(), /PRICE_MOVED/);
        assert.equal(f.sends(), 0);
      } else {
        await execute();
        assert.equal(f.sends(), 1);
      }
    } finally {
      journal.close();
      f.watch.close();
    }
  }
});

test("independently authorized exact bytes persist before one Base submission", async () => {
  const f = await fixture(),
    journal = new MainnetSubmissionJournal(
      ":memory:",
      { perTransaction: "1000000", daily: "2000000", confirmations: 1 },
      () => now,
    );
  try {
    journal.resume();
    const result = await executeMainnetTransfer(
      journal,
      f.payment,
      f.profile,
      f.terms,
      f.prepared,
      f.bundle,
      f.authorization,
      f.fetcher,
      now,
    );
    assert.equal(result.state, "broadcast");
    assert.equal(result.submitted, true);
    assert.equal(f.sends(), 1);
    const state = journal.status(f.payment.orderId);
    assert.equal(state.state, "broadcast");
    assert.equal(
      journal.db
        .prepare("SELECT signed FROM mainnet_submissions WHERE order_id=?")
        .get(f.payment.orderId)?.signed,
      f.bundle.signed,
    );
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
      ),
      /NOT_CLAIMABLE/,
    );
    assert.equal(f.sends(), 1);
  } finally {
    journal.close();
    f.watch.close();
  }
});

test("single-writer guard stops before journal preparation and again before sending", async () => {
  const f = await fixture(),
    journal = new MainnetSubmissionJournal(
      ":memory:",
      { perTransaction: "1000000", daily: "2000000", confirmations: 1 },
      () => now,
    );
  try {
    journal.resume();
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
        () => {
          throw Error("MAINNET_OPERATOR_PAUSED");
        },
      ),
      /MAINNET_OPERATOR_PAUSED/,
    );
    assert.equal(f.sends(), 0);
    assert.throws(() => journal.status(f.payment.orderId), /UNKNOWN/);
    let guards = 0;
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
        () => {
          guards++;
          if (guards === 3) throw Error("MAINNET_EXECUTION_LEASE_LOST");
        },
      ),
      /MAINNET_EXECUTION_LEASE_LOST/,
    );
    assert.equal(guards, 3);
    assert.equal(f.sends(), 0);
    assert.equal(journal.status(f.payment.orderId).state, "uncertain");
  } finally {
    journal.close();
    f.watch.close();
  }
});

test("expiry after the durable claim still prevents the sole network send", async (t) => {
  const f = await fixture(),
    journal = new MainnetSubmissionJournal(
      ":memory:",
      { perTransaction: "1000000", daily: "2000000", confirmations: 1 },
      () => now,
    );
  let guards = 0;
  try {
    journal.resume();
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
        () => {
          if (++guards === 3)
            t.mock.method(Date, "now", () => f.terms.expires * 1000);
        },
      ),
      /MAINNET_APPROVAL_EXPIRED/,
    );
    assert.equal(f.sends(), 0);
    assert.equal(journal.status(f.payment.orderId).state, "uncertain");
  } finally {
    journal.close();
    f.watch.close();
  }
});

test("lost broadcast response is uncertain and can never submit a replacement", async () => {
  const f = await fixture(true),
    journal = new MainnetSubmissionJournal(
      ":memory:",
      { perTransaction: "1000000", daily: "2000000", confirmations: 1 },
      () => now,
    );
  try {
    journal.resume();
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
      ),
      /lost response/,
    );
    assert.equal(journal.status(f.payment.orderId).state, "uncertain");
    assert.equal(f.sends(), 1);
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
      ),
      /NOT_CLAIMABLE/,
    );
    assert.equal(f.sends(), 1);
  } finally {
    journal.close();
    f.watch.close();
  }
});

test("claimed submission without broadcast proof reconciles to uncertain without resend", async () => {
  const f = await fixture(),
    journal = new MainnetSubmissionJournal(
      ":memory:",
      { perTransaction: "1000000", daily: "2000000", confirmations: 1 },
      () => now,
    ),
    missingReceipt: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "eth_chainId")
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" }),
        );
      if (
        request.method === "eth_getTransactionReceipt" ||
        request.method === "eth_getTransactionByHash" ||
        request.method === "eth_getBlockByNumber"
      )
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
        );
      throw Error(`unexpected synthetic method ${request.method}`);
    };
  try {
    journal.resume();
    const verified = await verifyMainnetSignedBundle(
      f.profile,
      f.terms,
      f.prepared,
      f.bundle,
      f.fetcher,
      now,
    );
    journal.prepare(f.terms, verified, f.payment.orderId);
    journal.claim(f.payment.orderId);
    const state = await reconcileMainnetTransfer(
      journal,
      f.profile,
      f.terms,
      f.payment.orderId,
      missingReceipt,
    );
    assert.equal(state.state, "uncertain");
    assert.equal(f.sends(), 0);
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
      ),
      /NOT_CLAIMABLE/,
    );
    assert.equal(f.sends(), 0);
  } finally {
    journal.close();
    f.watch.close();
  }
});

test("changed or expired operator authorization reaches neither journal nor network", async () => {
  const f = await fixture(),
    journal = new MainnetSubmissionJournal(
      ":memory:",
      { perTransaction: "1000000", daily: "2000000", confirmations: 1 },
      () => now,
    );
  try {
    journal.resume();
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        { ...f.authorization, maximumDestinationDebit: "999999" },
        f.fetcher,
        now,
      ),
      /INVALID_EXECUTION_AUTHORIZATION/,
    );
    assert.equal(f.sends(), 0);
    assert.throws(() => journal.status(f.payment.orderId), /UNKNOWN/);
  } finally {
    journal.close();
    f.watch.close();
  }
});

test("serialized or copied payment observations cannot authorize mainnet execution", async () => {
  const f = await fixture(),
    journal = new MainnetSubmissionJournal(
      ":memory:",
      { perTransaction: "1000000", daily: "2000000", confirmations: 1 },
      () => now,
    );
  try {
    journal.resume();
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        structuredClone(f.payment),
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
      ),
      /VERIFIED_MAINNET_PAYMENT_AUTHORIZATION_REQUIRED/,
    );
    assert.equal(f.sends(), 0);
    assert.throws(() => journal.status(f.payment.orderId), /UNKNOWN/);
    f.watch.close();
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
      ),
      /VERIFIED_MAINNET_PAYMENT_AUTHORIZATION_REQUIRED/,
    );
  } finally {
    journal.close();
  }
});

test("independently authorized Solana bytes simulate again and submit once", async () => {
  const paymentState = await verifiedPayment(),
    { payment } = paymentState,
    relayer = await generateKeyPairSigner(),
    recipient = await generateKeyPairSigner(),
    rawPublicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", relayer.keyPair.publicKey),
    ),
    authority = generateKeyPairSync("ed25519"),
    profile: ProductionProfile = {
      network: "solana",
      enabled: true,
      providers: [
        { endpoint: "https://first.invalid", operator: "first" },
        { endpoint: "https://second.invalid", operator: "second" },
      ],
      independenceAcknowledged: true,
      relayer: relayer.address,
      recipients: [recipient.address],
      perTransaction: "1010000",
      daily: "2020000",
      feeCap: "10000",
      confirmations: 1,
      signer: {
        identity: "disposable-offline-solana",
        publicKey: ed25519Pem(rawPublicKey),
        transport: "offline-bundle",
        separateDeviceValidated: true,
        attestationReference: "disposable-test",
      },
      executionAuthority: {
        identity: "disposable-operator",
        publicKey: authority.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
        separateDeviceValidated: true,
        attestationReference: "disposable-test",
      },
    },
    terms = mainnetTransferTerms(
      profile,
      {
        recipient: recipient.address,
        amount: "1000000",
        feeCap: "5000",
        sourceZatoshis: "100000",
        sourcePaymentCommitment: payment.paymentDigest!,
        destinationBinding: addressBinding("solana", recipient.address),
        quoteDigest: "b".repeat(64),
        expires: now + 600,
      },
      now,
    );
  let sends = 0;
  const fetcher: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      let result: unknown;
      switch (request.method) {
        case "getGenesisHash":
          result = SOLANA_MAINNET_GENESIS;
          break;
        case "getSlot":
          result = 100;
          break;
        case "getBlock":
          result = {
            blockhash: "11111111111111111111111111111112",
            blockTime: now,
          };
          break;
        case "getAccountInfo":
          result = { context: { slot: 100 }, value: null };
          break;
        case "getBalance":
          result = { context: { slot: 100 }, value: 10000000 };
          break;
        case "getLatestBlockhash":
          result = {
            value: {
              blockhash: "11111111111111111111111111111111",
              lastValidBlockHeight: 200,
            },
          };
          break;
        case "isBlockhashValid":
          result = { value: true };
          break;
        case "getBlockHeight":
          result = 150;
          break;
        case "simulateTransaction":
          result = { value: { err: null } };
          break;
        case "getFeeForMessage":
          result = { value: 5000 };
          break;
        case "getSignatureStatuses":
          result = { value: [null] };
          break;
        case "sendTransaction":
          sends++;
          result = transactionId;
          break;
        default:
          throw Error(`unexpected synthetic method ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    },
    prepared = (await prepareMainnetTransfer(
      profile,
      terms,
      fetcher,
      now,
    )) as SolanaUnsigned,
    unsigned = getTransactionDecoder().decode(
      Buffer.from(prepared.unsignedWire, "base64"),
    ),
    [signatures] = await relayer.signTransactions([unsigned as any]),
    signedWire = getBase64EncodedWireTransaction({
      ...unsigned,
      signatures,
    } as any),
    bundle: MainnetSignedBundle = {
      version: 1,
      network: "solana",
      termsDigest: termsDigest(terms),
      preparedDigest: preparedDigest(prepared),
      signed: signedWire,
    },
    verified = await verifyMainnetSignedBundle(
      profile,
      terms,
      prepared,
      bundle,
      fetcher,
      now,
    ),
    transactionId = verified.transactionId,
    payload = executionAuthorizationPayload(
      payment.orderId,
      terms,
      prepared,
      verified,
      now + 300,
      "e".repeat(64),
    ),
    authorization: MainnetExecutionAuthorization = {
      version: 1,
      ...payload,
      signature: signMessage(
        null,
        Buffer.from(JSON.stringify(payload)),
        authority.privateKey,
      ).toString("base64"),
    },
    journal = new MainnetSubmissionJournal(
      ":memory:",
      { perTransaction: "1010000", daily: "2020000", confirmations: 1 },
      () => now,
    );
  try {
    journal.resume();
    const result = await executeMainnetTransfer(
      journal,
      payment,
      profile,
      terms,
      prepared,
      bundle,
      authorization,
      fetcher,
      now,
    );
    assert.equal(result.transactionId, transactionId);
    assert.equal(result.state, "broadcast");
    assert.equal(sends, 1);
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        payment,
        profile,
        terms,
        prepared,
        bundle,
        authorization,
        fetcher,
        now,
      ),
      /NOT_CLAIMABLE/,
    );
    assert.equal(sends, 1);
  } finally {
    journal.close();
    paymentState.watch.close();
  }
});
test("rescan invalidates an unused payment observation before execution", async () => {
  const f = await fixture(),
    journal = new MainnetSubmissionJournal(
      ":memory:",
      { perTransaction: "1000000", daily: "2000000", confirmations: 1 },
      () => now,
    );
  try {
    journal.resume();
    f.watch.observe(f.binding, await f.rescan([]));
    await assert.rejects(
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
      ),
      /VERIFIED_MAINNET_PAYMENT_AUTHORIZATION_REQUIRED/,
    );
    assert.equal(f.sends(), 0);
    assert.throws(() => journal.status(f.payment.orderId), /UNKNOWN/);
  } finally {
    journal.close();
    f.watch.close();
  }
});

test("concurrent execution attempts consume one grant only once", async () => {
  const f = await fixture(),
    journal = new MainnetSubmissionJournal(
      ":memory:",
      { perTransaction: "1000000", daily: "2000000", confirmations: 1 },
      () => now,
    );
  try {
    journal.resume();
    const results = await Promise.allSettled([
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
      ),
      executeMainnetTransfer(
        journal,
        f.payment,
        f.profile,
        f.terms,
        f.prepared,
        f.bundle,
        f.authorization,
        f.fetcher,
        now,
      ),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(f.sends(), 1);
    assert.equal(journal.status(f.payment.orderId).state, "broadcast");
  } finally {
    journal.close();
    f.watch.close();
  }
});
