// One-shot mainnet execution boundary. Transaction keys remain on the offline signer;
// this module verifies exact signed bytes and a separate operator authorization before
// persisting bearer-sensitive evidence and making one RPC submission attempt.
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  independentProviders,
  type ProductionProfile,
} from "./production-safety.ts";
import { readProductionRpc } from "./mainnet-probe.ts";
import {
  preparedDigest,
  termsDigest,
  verifyMainnetSignedBundle,
  type MainnetPrepared,
  type MainnetSignedBundle,
  type MainnetTransferTerms,
  type VerifiedMainnetBundle,
} from "./mainnet-transfer.ts";
import {
  MainnetSubmissionJournal,
  readBaseFinalizedReceipt,
  readSolanaFinalizedReceipt,
} from "./mainnet-submitter.ts";
import {
  assertMainnetPaymentAuthorization,
  type MainnetWatchObservation,
} from "./mainnet-watch.ts";

const HEX64 = /^[a-f0-9]{64}$/;
const BASE_TX = /^0x[a-f0-9]{64}$/;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type MainnetExecutionAuthorization = {
  version: 1;
  orderId: string;
  network: "base" | "solana";
  termsDigest: string;
  preparedDigest: string;
  signedDigest: string;
  transactionId: string;
  maximumDestinationDebit: string;
  expires: number;
  nonce: string;
  signature: string;
};

export function executionAuthorizationPayload(
  orderId: string,
  terms: MainnetTransferTerms,
  prepared: MainnetPrepared,
  verified: VerifiedMainnetBundle,
  expires: number,
  nonce: string,
) {
  if (!orderId.trim() || orderId.length > 128 || !HEX64.test(nonce))
    throw Error("INVALID_EXECUTION_AUTHORIZATION");
  return {
    domain: "zecone-mainnet-execution-v1",
    orderId,
    network: terms.network,
    termsDigest: termsDigest(terms),
    preparedDigest: preparedDigest(prepared),
    signedDigest: verified.signedDigest,
    transactionId: verified.transactionId,
    maximumDestinationDebit: terms.maximumDestinationDebit,
    expires,
    nonce,
  } as const;
}

export function verifyExecutionAuthorization(
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  prepared: MainnetPrepared,
  verified: VerifiedMainnetBundle,
  authorization: MainnetExecutionAuthorization,
  now = Math.floor(Date.now() / 1000),
) {
  const authority = profile.executionAuthority;
  if (
    !authority?.separateDeviceValidated ||
    !authority.identity.trim() ||
    !authority.attestationReference.trim()
  )
    throw Error("INDEPENDENT_EXECUTION_AUTHORITY_REQUIRED");
  const payload = executionAuthorizationPayload(
    authorization.orderId,
    terms,
    prepared,
    verified,
    authorization.expires,
    authorization.nonce,
  );
  if (
    authorization.version !== 1 ||
    authorization.network !== payload.network ||
    authorization.termsDigest !== payload.termsDigest ||
    authorization.preparedDigest !== payload.preparedDigest ||
    authorization.signedDigest !== payload.signedDigest ||
    authorization.transactionId !== payload.transactionId ||
    authorization.maximumDestinationDebit !== payload.maximumDestinationDebit ||
    authorization.expires !== payload.expires ||
    authorization.nonce !== payload.nonce ||
    authorization.expires <= now ||
    authorization.expires > terms.expires ||
    typeof authorization.signature !== "string"
  )
    throw Error("INVALID_EXECUTION_AUTHORIZATION");
  let key: ReturnType<typeof createPublicKey>, signature: Buffer;
  try {
    key = createPublicKey(authority.publicKey);
    signature = Buffer.from(authorization.signature, "base64");
  } catch {
    throw Error("INVALID_EXECUTION_AUTHORIZATION");
  }
  if (
    key.asymmetricKeyType !== "ed25519" ||
    signature.length !== 64 ||
    !verify(null, Buffer.from(JSON.stringify(payload)), key, signature)
  )
    throw Error("INVALID_EXECUTION_AUTHORIZATION");
  return Object.freeze({ ...payload, authority: authority.identity });
}

async function priorSubmission(
  profile: ProductionProfile,
  transactionId: string,
  fetcher: typeof fetch,
) {
  const rows = await Promise.all(
    profile.providers.map((provider) =>
      profile.network === "base"
        ? readProductionRpc(
            provider,
            "eth_getTransactionByHash",
            [transactionId],
            fetcher,
          )
        : readProductionRpc(
            provider,
            "getSignatureStatuses",
            [[transactionId], { searchTransactionHistory: true }],
            fetcher,
          ).then((result) => result?.value?.[0] ?? null),
    ),
  );
  const present = rows.map((row) => row !== null);
  if (present[0] !== present[1])
    throw Error("PROVIDER_SUBMISSION_DISAGREEMENT");
  if (!present[0]) return false;
  if (profile.network === "base") {
    if (
      rows.some(
        (row) => String(row.hash).toLowerCase() !== transactionId.toLowerCase(),
      )
    )
      throw Error("PROVIDER_SUBMISSION_DISAGREEMENT");
  } else if (digest(rows[0]) !== digest(rows[1])) {
    throw Error("PROVIDER_SUBMISSION_DISAGREEMENT");
  }
  return true;
}

async function assertStillExecutable(
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  prepared: MainnetPrepared,
  verified: VerifiedMainnetBundle,
  fetcher: typeof fetch,
) {
  independentProviders(profile);
  if (prepared.kind === "base-unsigned") {
    const rows = await Promise.all(
      profile.providers.map(async (provider) => {
        const [chain, nonce, balance, code, gas] = await Promise.all([
          readProductionRpc(provider, "eth_chainId", [], fetcher),
          readProductionRpc(
            provider,
            "eth_getTransactionCount",
            [terms.relayer, "pending"],
            fetcher,
          ),
          readProductionRpc(
            provider,
            "eth_getBalance",
            [terms.relayer, "finalized"],
            fetcher,
          ),
          readProductionRpc(
            provider,
            "eth_getCode",
            [terms.recipient, "finalized"],
            fetcher,
          ),
          readProductionRpc(
            provider,
            "eth_estimateGas",
            [
              {
                from: terms.relayer,
                to: terms.recipient,
                value: `0x${BigInt(terms.amount).toString(16)}`,
                data: "0x",
              },
              "finalized",
            ],
            fetcher,
          ),
        ]);
        return {
          chain,
          nonce: Number(BigInt(nonce)),
          balance: BigInt(balance),
          code,
          gas: BigInt(gas),
        };
      }),
    );
    if (
      rows.some(
        (row) =>
          row.chain !== "0x2105" ||
          !Number.isSafeInteger(row.nonce) ||
          row.nonce !== prepared.tx.nonce ||
          row.balance < BigInt(terms.maximumDestinationDebit) ||
          row.code !== "0x" ||
          row.gas > BigInt(prepared.tx.gas),
      ) ||
      rows[0].chain !== rows[1].chain ||
      rows[0].nonce !== rows[1].nonce ||
      rows[0].balance !== rows[1].balance ||
      rows[0].code !== rows[1].code ||
      rows[0].gas !== rows[1].gas
    )
      throw Error("BASE_EXECUTION_STATE_CHANGED_OR_DISAGREED");
    return;
  }
  const rows = await Promise.all(
    profile.providers.map(async (provider) => {
      const [genesis, valid, height, simulation] = await Promise.all([
        readProductionRpc(provider, "getGenesisHash", [], fetcher),
        readProductionRpc(
          provider,
          "isBlockhashValid",
          [prepared.blockhash, { commitment: "finalized" }],
          fetcher,
        ),
        readProductionRpc(
          provider,
          "getBlockHeight",
          [{ commitment: "finalized" }],
          fetcher,
        ),
        readProductionRpc(
          provider,
          "simulateTransaction",
          [
            verified.signed,
            {
              encoding: "base64",
              sigVerify: true,
              replaceRecentBlockhash: false,
              commitment: "finalized",
            },
          ],
          fetcher,
        ),
      ]);
      return {
        genesis,
        valid: valid?.value === true,
        height: Number(height),
        simulationOk: simulation?.value?.err === null,
      };
    }),
  );
  if (
    rows.some(
      (row) =>
        row.genesis !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" ||
        !row.valid ||
        !row.simulationOk ||
        !Number.isSafeInteger(row.height) ||
        BigInt(row.height) > BigInt(prepared.lastValidBlockHeight),
    ) ||
    Math.abs(rows[0].height - rows[1].height) > 20
  )
    throw Error("SOLANA_BLOCKHASH_EXPIRED_OR_DISAGREED");
}

async function sendOnce(
  profile: ProductionProfile,
  verified: VerifiedMainnetBundle,
  fetcher: typeof fetch,
) {
  const provider = profile.providers[0],
    method =
      profile.network === "base" ? "eth_sendRawTransaction" : "sendTransaction",
    params =
      profile.network === "base"
        ? [verified.signed]
        : [
            verified.signed,
            {
              encoding: "base64",
              skipPreflight: false,
              preflightCommitment: "finalized",
              maxRetries: 0,
            },
          ],
    response = await fetcher(provider.endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(12000),
    });
  if (!response.ok) throw Error("MAINNET_BROADCAST_OUTCOME_UNCERTAIN");
  const reader = response.body?.getReader();
  if (!reader) throw Error("MAINNET_BROADCAST_OUTCOME_UNCERTAIN");
  let body = "",
    size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw Error("MAINNET_BROADCAST_OUTCOME_UNCERTAIN");
      body += new TextDecoder().decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    throw Error("MAINNET_BROADCAST_OUTCOME_UNCERTAIN");
  }
  if (data.id !== 1 || data.error || typeof data.result !== "string")
    throw Error("MAINNET_BROADCAST_OUTCOME_UNCERTAIN");
  const actual =
    profile.network === "base" ? data.result.toLowerCase() : data.result;
  const expected =
    profile.network === "base"
      ? verified.transactionId.toLowerCase()
      : verified.transactionId;
  if (actual !== expected) throw Error("MAINNET_BROADCAST_ID_MISMATCH");
  return data.result as string;
}

export async function executeMainnetTransfer(
  journal: MainnetSubmissionJournal,
  payment: MainnetWatchObservation,
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  prepared: MainnetPrepared,
  signed: MainnetSignedBundle,
  authorization: MainnetExecutionAuthorization,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1000),
  guard: () => void = () => {},
) {
  guard();
  if (!profile.enabled || terms.expires <= now)
    throw Error("MAINNET_EXECUTION_NOT_AUTHORIZED");
  const expectedPayment = {
    orderId: authorization.orderId,
    paymentDigest: terms.sourcePaymentCommitment,
    zatoshis: terms.sourceZatoshis,
  };
  assertMainnetPaymentAuthorization(payment, expectedPayment, now);
  const verified = await verifyMainnetSignedBundle(
    profile,
    terms,
    prepared,
    signed,
    fetcher,
    now,
  );
  verifyExecutionAuthorization(
    profile,
    terms,
    prepared,
    verified,
    authorization,
    now,
  );
  await assertStillExecutable(profile, terms, prepared, verified, fetcher);
  const known = await priorSubmission(profile, verified.transactionId, fetcher);
  assertMainnetPaymentAuthorization(
    payment,
    expectedPayment,
    Math.max(now, Math.floor(Date.now() / 1000)),
  );
  guard();
  journal.prepare(terms, verified, authorization.orderId);
  const claim = journal.claim(authorization.orderId);
  try {
    guard();
    if (!known) await sendOnce(profile, verified, fetcher);
    journal.markBroadcast(authorization.orderId, claim.transactionId);
    return Object.freeze({
      orderId: authorization.orderId,
      network: terms.network,
      transactionId: claim.transactionId,
      submitted: !known,
      state: "broadcast" as const,
    });
  } catch (error) {
    journal.markUncertain(
      authorization.orderId,
      error instanceof Error ? error.message : "UNKNOWN_BROADCAST_OUTCOME",
    );
    throw error;
  }
}

export async function reconcileMainnetTransfer(
  journal: MainnetSubmissionJournal,
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  orderId: string,
  fetcher: typeof fetch = fetch,
  guard: () => void = () => {},
) {
  guard();
  const state = journal.status(orderId),
    prior = String(state?.state);
  if (!state || !["claimed", "broadcast", "uncertain"].includes(prior))
    throw Error("MAINNET_RECONCILIATION_NOT_REQUIRED");
  const transactionId = String(state.transaction_id);
  try {
    if (terms.network === "base") {
      if (!BASE_TX.test(transactionId.toLowerCase()))
        throw Error("INVALID_BASE_TRANSACTION_ID");
      const receipt = await readBaseFinalizedReceipt(
        profile,
        terms,
        transactionId,
        fetcher,
      );
      guard();
      if (prior === "claimed") journal.markBroadcast(orderId, transactionId);
      journal.finalizeBase(orderId, receipt, terms);
    } else {
      const receipt = await readSolanaFinalizedReceipt(
        profile,
        terms,
        transactionId,
        fetcher,
      );
      guard();
      if (prior === "claimed") journal.markBroadcast(orderId, transactionId);
      journal.finalizeSolana(orderId, receipt, terms);
    }
  } catch (e) {
    if (
      prior === "claimed" &&
      e instanceof Error &&
      e.message === "MAINNET_RECEIPT_NOT_FOUND"
    ) {
      guard();
      journal.markUncertain(orderId, "CLAIMED_WITHOUT_BROADCAST_PROOF");
      return journal.status(orderId);
    }
    throw e;
  }
  return journal.status(orderId);
}
