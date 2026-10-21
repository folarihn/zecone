import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  signBytes,
} from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ProductionProfile } from "../services/settlement/production-safety.ts";
import {
  BASE_MAINNET_CHAIN_ID,
  SOLANA_MAINNET_GENESIS,
  addressBinding,
  ownershipMessage,
  verifyDestinationOwnership,
} from "../services/settlement/mainnet-address.ts";
import {
  mainnetTransferTerms,
  prepareMainnetTransfer,
  preparedDigest,
  verifyMainnetSignedBundle,
  type MainnetSignedBundle,
  type MainnetTransferRequest,
  type SolanaUnsigned,
} from "../services/settlement/mainnet-transfer.ts";

const now = 2_000_000_000;
const baseAccount = privateKeyToAccount(generatePrivateKey());
const baseRecipientAccount = privateKeyToAccount(generatePrivateKey());
const baseRecipient = baseRecipientAccount.address;

function secp256k1Pem(publicKey: `0x${string}`) {
  const bytes = Buffer.from(publicKey.slice(2), "hex");
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex"),
      bytes,
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

function baseProfile(): ProductionProfile {
  return {
    network: "base",
    enabled: true,
    providers: [
      { endpoint: "https://first.invalid", operator: "first" },
      { endpoint: "https://second.invalid", operator: "second" },
    ],
    independenceAcknowledged: true,
    relayer: baseAccount.address,
    recipients: [baseRecipient],
    perTransaction: "1000000000000000000",
    daily: "1000000000000000000",
    feeCap: "100000000000000",
    confirmations: 1,
    signer: {
      identity: "offline-base",
      publicKey: secp256k1Pem(baseAccount.publicKey),
      transport: "offline-bundle",
      separateDeviceValidated: true,
      attestationReference: "synthetic-attestation",
    },
  };
}

function request(overrides: Partial<MainnetTransferRequest> = {}) {
  return {
    recipient: baseRecipient,
    amount: "1000",
    feeCap: "100000000000000",
    l1DataFeeBound: "1000",
    sourceZatoshis: "100000",
    sourcePaymentCommitment: "a".repeat(64),
    destinationBinding: addressBinding("base", baseRecipient),
    expires: now + 600,
    ...overrides,
  };
}

function baseRpc() {
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)),
      method = request.method;
    methods.push(method);
    const result =
      method === "eth_chainId"
        ? "0x2105"
        : method === "eth_getBlockByNumber"
          ? {
              hash: `0x${"1".repeat(64)}`,
              number: "0x64",
              timestamp: `0x${now.toString(16)}`,
            }
          : method === "eth_getCode"
            ? "0x"
            : method === "eth_getTransactionCount"
              ? "0x0"
              : method === "eth_getBalance"
                ? `0x${(10n ** 18n).toString(16)}`
                : method === "eth_estimateGas"
                  ? "0x5208"
                  : method === "eth_gasPrice"
                    ? "0x3b9aca00"
                    : method === "eth_call"
                      ? "0x1"
                      : null;
    assert.notEqual(result, null, `unexpected method ${method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  return { fetcher, methods };
}

test("mainnet destination ownership is proven with the supplied public address only", async () => {
  const nonce = `0x${"b".repeat(64)}`,
    expires = now + 300,
    message = ownershipMessage("base", baseRecipient, nonce, expires),
    signature = await baseRecipientAccount.signMessage({ message });
  const base = await verifyDestinationOwnership({
    network: "base",
    address: baseRecipient,
    nonce,
    expires,
    signature,
    now,
  });
  assert.equal(base.verified, true);
  assert.match(base.binding, /^[a-f0-9]{64}$/);
  await assert.rejects(
    verifyDestinationOwnership({
      network: "base",
      address: baseAccount.address,
      nonce,
      expires,
      signature,
      now,
    }),
    /OWNERSHIP/,
  );

  const solana = await generateKeyPairSigner(),
    solanaNonce = `0x${"c".repeat(64)}`,
    solanaMessage = ownershipMessage(
      "solana",
      solana.address,
      solanaNonce,
      expires,
    ),
    solanaSignature = await signBytes(
      solana.keyPair.privateKey,
      new TextEncoder().encode(solanaMessage),
    ),
    proof = await verifyDestinationOwnership({
      network: "solana",
      address: solana.address,
      nonce: solanaNonce,
      expires,
      signature: getBase58Decoder().decode(solanaSignature),
      now,
    });
  assert.equal(proof.verified, true);
  await assert.rejects(
    verifyDestinationOwnership({
      network: "solana",
      address: solana.address,
      nonce: solanaNonce,
      expires,
      signature: getBase58Decoder().decode(solanaSignature),
      now: expires,
    }),
    /EXPIRED/,
  );
});

test("mainnet terms bind signer, relayer, recipient, source payment and limits", () => {
  const profile = baseProfile(),
    terms = mainnetTransferTerms(profile, request(), now);
  assert.equal(terms.relayer, baseAccount.address);
  assert.equal(terms.recipient, baseRecipient);
  assert.equal(terms.maximumDestinationDebit, "100000000001000");
  assert.equal(terms.destinationNetwork, "eip155:8453");
  assert.throws(
    () =>
      mainnetTransferTerms(
        {
          ...profile,
          relayer: privateKeyToAccount(generatePrivateKey()).address,
        },
        request(),
        now,
      ),
    /SIGNER_RELAYER_MISMATCH/,
  );
  assert.throws(
    () =>
      mainnetTransferTerms(
        profile,
        request({ recipient: baseAccount.address }),
        now,
      ),
    /RECIPIENT_NOT_AUTHORIZED/,
  );
  assert.throws(
    () =>
      mainnetTransferTerms(
        profile,
        request({ amount: "1000000000000000000" }),
        now,
      ),
    /PER_TRANSACTION/,
  );
  assert.throws(
    () =>
      mainnetTransferTerms(
        profile,
        request({ destinationBinding: "0".repeat(64) }),
        now,
      ),
    /OWNERSHIP/,
  );
  assert.throws(
    () =>
      mainnetTransferTerms(
        profile,
        request({ sourcePaymentCommitment: "short" }),
        now,
      ),
    /COMMITMENT/,
  );
  assert.throws(
    () => mainnetTransferTerms({ ...profile, enabled: false }, request(), now),
    /DISABLED/,
  );
  assert.throws(
    () =>
      mainnetTransferTerms(
        {
          ...profile,
          signer: {
            ...profile.signer!,
            publicKey: generateKeyPairSync("ed25519").publicKey.export({
              format: "pem",
              type: "spki",
            }) as string,
          },
        },
        request(),
        now,
      ),
    /SECP256K1/,
  );
});

test("Base preparation and offline signature verification are exact and read-only", async () => {
  const profile = baseProfile(),
    terms = mainnetTransferTerms(profile, request(), now),
    { fetcher, methods } = baseRpc(),
    prepared = await prepareMainnetTransfer(profile, terms, fetcher, now);
  assert.equal(prepared.kind, "base-unsigned");
  if (prepared.kind !== "base-unsigned") throw Error();
  assert.equal(prepared.tx.chainId, BASE_MAINNET_CHAIN_ID);
  assert.equal(prepared.tx.to, baseRecipient);
  assert.equal(prepared.gasFee, "21000000000000");
  const raw = await baseAccount.signTransaction({
    type: "legacy",
    chainId: BASE_MAINNET_CHAIN_ID,
    to: prepared.tx.to as `0x${string}`,
    value: BigInt(prepared.tx.value),
    data: "0x",
    nonce: prepared.tx.nonce,
    gas: BigInt(prepared.tx.gas),
    gasPrice: BigInt(prepared.tx.gasPrice),
  });
  const bundle: MainnetSignedBundle = {
    version: 1,
    network: "base",
    termsDigest: prepared.termsDigest,
    preparedDigest: preparedDigest(prepared),
    signed: raw,
  };
  const verified = await verifyMainnetSignedBundle(
    profile,
    terms,
    prepared,
    bundle,
    fetcher,
    now,
  );
  assert.match(verified.transactionId, /^0x[a-f0-9]{64}$/);
  assert.equal(verified.totalFee, "21000000000001");
  assert.equal(verified.broadcast, false);
  assert.ok(
    methods.every(
      (m) =>
        !["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign"].includes(
          m,
        ),
    ),
  );
  const other = privateKeyToAccount(generatePrivateKey()),
    wrong = await other.signTransaction({
      type: "legacy",
      chainId: BASE_MAINNET_CHAIN_ID,
      to: prepared.tx.to as `0x${string}`,
      value: BigInt(prepared.tx.value),
      data: "0x",
      nonce: prepared.tx.nonce,
      gas: BigInt(prepared.tx.gas),
      gasPrice: BigInt(prepared.tx.gasPrice),
    });
  await assert.rejects(
    verifyMainnetSignedBundle(
      profile,
      terms,
      prepared,
      { ...bundle, signed: wrong },
      fetcher,
      now,
    ),
    /SIGNER_MISMATCH/,
  );
});

async function solanaFixture() {
  const relayer = await generateKeyPairSigner(),
    recipient = await generateKeyPairSigner(),
    raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", relayer.keyPair.publicKey),
    ),
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
      daily: "1010000",
      feeCap: "10000",
      confirmations: 1,
      signer: {
        identity: "offline-solana",
        publicKey: ed25519Pem(raw),
        transport: "offline-bundle",
        separateDeviceValidated: true,
        attestationReference: "synthetic-attestation",
      },
    },
    terms = mainnetTransferTerms(
      profile,
      {
        recipient: recipient.address,
        amount: "1000000",
        feeCap: "5000",
        sourceZatoshis: "100000",
        sourcePaymentCommitment: "d".repeat(64),
        destinationBinding: addressBinding("solana", recipient.address),
        expires: now + 600,
      },
      now,
    );
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)),
      method = request.method;
    methods.push(method);
    const result =
      method === "getGenesisHash"
        ? SOLANA_MAINNET_GENESIS
        : method === "getSlot"
          ? 100
          : method === "getBlock"
            ? {
                blockhash: "11111111111111111111111111111112",
                blockTime: now,
              }
            : method === "getAccountInfo"
              ? { context: { slot: 100 }, value: null }
              : method === "getBalance"
                ? { context: { slot: 100 }, value: 10000000 }
                : method === "getLatestBlockhash"
                  ? {
                      value: {
                        blockhash: "11111111111111111111111111111111",
                        lastValidBlockHeight: 200,
                      },
                    }
                  : method === "isBlockhashValid"
                    ? { value: true }
                    : method === "simulateTransaction"
                      ? { value: { err: null } }
                      : method === "getFeeForMessage"
                        ? { value: 5000 }
                        : null;
    assert.notEqual(result, null, `unexpected method ${method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  return { relayer, recipient, profile, terms, fetcher, methods };
}

test("unsigned Solana mainnet transfer simulates on both providers without a signature", async () => {
  const f = await solanaFixture(),
    prepared = await prepareMainnetTransfer(f.profile, f.terms, f.fetcher, now);
  assert.equal(prepared.kind, "solana-unsigned");
  if (prepared.kind !== "solana-unsigned") throw Error();
  assert.equal(prepared.genesis, SOLANA_MAINNET_GENESIS);
  assert.equal(prepared.fee, "5000");
  assert.equal(prepared.slot, 100);
  assert.ok(
    f.methods.every(
      (m) => !["sendTransaction", "eth_sendRawTransaction"].includes(m),
    ),
  );
});

test("offline Solana signature verifies only the exact prepared message", async () => {
  const f = await solanaFixture(),
    prepared = (await prepareMainnetTransfer(
      f.profile,
      f.terms,
      f.fetcher,
      now,
    )) as SolanaUnsigned,
    unsigned = getTransactionDecoder().decode(
      Buffer.from(prepared.unsignedWire, "base64"),
    ),
    [signatures] = await f.relayer.signTransactions([unsigned as any]),
    signed = { ...unsigned, signatures },
    wire = getBase64EncodedWireTransaction(signed as any),
    bundle: MainnetSignedBundle = {
      version: 1,
      network: "solana",
      termsDigest: prepared.termsDigest,
      preparedDigest: preparedDigest(prepared),
      signed: wire,
    },
    verified = await verifyMainnetSignedBundle(
      f.profile,
      f.terms,
      prepared,
      bundle,
      f.fetcher,
      now,
    );
  assert.match(verified.transactionId, /^[1-9A-HJ-NP-Za-km-z]{87,88}$/);
  assert.equal(verified.totalFee, "5000");
  assert.equal(verified.broadcast, false);
  const tampered = Buffer.from(wire, "base64");
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(
    verifyMainnetSignedBundle(
      f.profile,
      f.terms,
      prepared,
      { ...bundle, signed: tampered.toString("base64") },
      f.fetcher,
      now,
    ),
    /MISMATCH|INVALID/,
  );
});
