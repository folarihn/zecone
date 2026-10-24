// Exact mainnet transfer planning and offline-bundle verification. Signing and
// broadcast are deliberately absent; a signed bundle is verified but never sent.
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerializedLegacy,
} from "viem";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  independentProviders,
  validateProductionProfile,
  type ProductionProfile,
  type Provider,
} from "./production-safety.ts";
import {
  BASE_MAINNET_CAIP,
  BASE_MAINNET_CHAIN_ID,
  SOLANA_MAINNET_CAIP,
  SOLANA_MAINNET_GENESIS,
  addressBinding,
  assertSignerMatchesRelayer,
  destinationNetwork,
  mainnetAddress,
  type DestinationNetwork,
} from "./mainnet-address.ts";
import { readProductionRpc } from "./mainnet-probe.ts";

export const GAS_PRICE_ORACLE =
  "0x420000000000000000000000000000000000000F" as const;
const l1FeeAbi = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
const integer = (value: unknown, label: string) => {
  if (typeof value !== "string" || !/^[1-9]\d{0,30}$/.test(value))
    throw Error(`INVALID_${label}`);
  return BigInt(value);
};
const nonNegative = (value: unknown, label: string) => {
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value))
    throw Error(`INVALID_${label}`);
  return BigInt(value);
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hex = (value: bigint) => `0x${value.toString(16)}`;
const safeInt = (value: unknown) => {
  const n =
    typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)
      ? Number(BigInt(value))
      : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw Error("INVALID_RPC_INTEGER");
  return n;
};

export type MainnetTransferRequest = {
  recipient: string;
  amount: string;
  feeCap: string;
  l1DataFeeBound?: string;
  sourceZatoshis: string;
  sourcePaymentCommitment: string;
  destinationBinding: string;
  quoteDigest?: string;
  expires: number;
};

export type MainnetTransferTerms = {
  version: 1;
  network: DestinationNetwork;
  destinationNetwork: typeof BASE_MAINNET_CAIP | typeof SOLANA_MAINNET_CAIP;
  relayer: string;
  recipient: string;
  amount: string;
  feeCap: string;
  l1DataFeeBound: string;
  maximumDestinationDebit: string;
  sourceNetwork: "zcash-mainnet";
  sourceZatoshis: string;
  sourcePaymentCommitment: string;
  destinationBinding: string;
  quoteDigest: string | null;
  profileDigest: string;
  expires: number;
};

export function mainnetTransferTerms(
  profile: ProductionProfile,
  request: MainnetTransferRequest,
  now = Math.floor(Date.now() / 1000),
): MainnetTransferTerms {
  const network = destinationNetwork(profile.network);
  validateProductionProfile(profile, now);
  if (!profile.enabled) throw Error("MAINNET_PROFILE_DISABLED");
  if (profile.recipients.length !== 1)
    throw Error("EXACT_MAINNET_RECIPIENT_REQUIRED");
  const recipient = mainnetAddress(network, request.recipient),
    relayer = mainnetAddress(network, profile.relayer),
    amount = integer(request.amount, "AMOUNT"),
    feeCap = integer(request.feeCap, "FEE_CAP"),
    l1Bound = nonNegative(
      network === "base" ? (request.l1DataFeeBound ?? "") : "0",
      "L1_DATA_FEE_BOUND",
    );
  if (recipient !== mainnetAddress(network, profile.recipients[0]))
    throw Error("RECIPIENT_NOT_AUTHORIZED");
  if (recipient === relayer) throw Error("SELF_TRANSFER");
  if (feeCap > BigInt(profile.feeCap)) throw Error("FEE_CAP");
  if (network === "base" && l1Bound > feeCap) throw Error("L1_DATA_FEE_BOUND");
  if (amount + feeCap > BigInt(profile.perTransaction))
    throw Error("PER_TRANSACTION_LIMIT");
  const sourceZatoshis = integer(request.sourceZatoshis, "SOURCE_ZATOSHIS");
  if (!request.sourceZatoshis || sourceZatoshis <= 0n)
    throw Error("INVALID_SOURCE_ZATOSHIS");
  if (
    profile.sourceMaximumZatoshis &&
    sourceZatoshis >
      integer(profile.sourceMaximumZatoshis, "SOURCE_MAXIMUM_ZATOSHIS")
  )
    throw Error("SOURCE_ZATOSHIS_CAP_EXCEEDED");
  if (!/^[a-f0-9]{64}$/.test(request.sourcePaymentCommitment))
    throw Error("INVALID_SOURCE_COMMITMENT");
  if (request.destinationBinding !== addressBinding(network, recipient))
    throw Error("DESTINATION_OWNERSHIP_REQUIRED");
  if (
    request.quoteDigest !== undefined &&
    !/^[a-f0-9]{64}$/.test(request.quoteDigest)
  )
    throw Error("INVALID_QUOTE_DIGEST");
  if (
    !Number.isSafeInteger(request.expires) ||
    request.expires <= now ||
    request.expires > now + 1800
  )
    throw Error("INVALID_TERMS_EXPIRY");
  if (!profile.signer) throw Error("SEPARATE_DEVICE_SIGNER_REQUIRED");
  assertSignerMatchesRelayer(
    network,
    profile.signer.publicKey,
    profile.relayer!,
  );
  return {
    version: 1,
    network,
    destinationNetwork:
      network === "base" ? BASE_MAINNET_CAIP : SOLANA_MAINNET_CAIP,
    relayer,
    recipient,
    amount: amount.toString(),
    feeCap: feeCap.toString(),
    l1DataFeeBound: l1Bound.toString(),
    maximumDestinationDebit: (amount + feeCap).toString(),
    sourceNetwork: "zcash-mainnet",
    sourceZatoshis: sourceZatoshis.toString(),
    sourcePaymentCommitment: request.sourcePaymentCommitment,
    destinationBinding: request.destinationBinding,
    quoteDigest: request.quoteDigest ?? null,
    profileDigest: hash(profile),
    expires: request.expires,
  };
}

export function termsDigest(terms: MainnetTransferTerms) {
  return hash(terms);
}

export type BaseUnsigned = {
  kind: "base-unsigned";
  termsDigest: string;
  chainId: typeof BASE_MAINNET_CHAIN_ID;
  tx: {
    type: "legacy";
    chainId: typeof BASE_MAINNET_CHAIN_ID;
    to: string;
    value: string;
    data: "0x";
    nonce: number;
    gas: string;
    gasPrice: string;
  };
  blockHash: string;
  blockNumber: string;
  gasFee: string;
  l1DataFeeBound: string;
  maximumDestinationDebit: string;
  quoteDigest: string;
};

export type SolanaUnsigned = {
  kind: "solana-unsigned";
  termsDigest: string;
  genesis: typeof SOLANA_MAINNET_GENESIS;
  unsignedWire: string;
  messageBase64: string;
  blockhash: string;
  lastValidBlockHeight: string;
  slot: number;
  fee: string;
  maximumDestinationDebit: string;
  quoteDigest: string;
};

export type MainnetPrepared = BaseUnsigned | SolanaUnsigned;

export type MainnetSignedBundle = {
  version: 1;
  network: DestinationNetwork;
  termsDigest: string;
  preparedDigest: string;
  signed: string;
};

export type VerifiedMainnetBundle = {
  version: 1;
  network: DestinationNetwork;
  termsDigest: string;
  preparedDigest: string;
  signed: string;
  transactionId: string;
  signedDigest: string;
  totalFee: string;
  broadcast: false;
};

export function preparedDigest(prepared: MainnetPrepared) {
  return hash(prepared);
}

export function assertPreparedMainnetTransfer(
  terms: MainnetTransferTerms,
  prepared: MainnetPrepared,
) {
  if (
    prepared.termsDigest !== termsDigest(terms) ||
    prepared.maximumDestinationDebit !== terms.maximumDestinationDebit
  )
    throw Error("PREPARED_TERMS_MISMATCH");
  if (prepared.kind === "base-unsigned") {
    if (
      terms.network !== "base" ||
      prepared.chainId !== BASE_MAINNET_CHAIN_ID ||
      prepared.tx.chainId !== BASE_MAINNET_CHAIN_ID ||
      prepared.tx.type !== "legacy" ||
      getAddress(prepared.tx.to) !== getAddress(terms.recipient) ||
      prepared.tx.value !== terms.amount ||
      prepared.tx.data.toLowerCase() !== "0x" ||
      !Number.isSafeInteger(prepared.tx.nonce) ||
      prepared.tx.nonce < 0 ||
      prepared.l1DataFeeBound !== terms.l1DataFeeBound
    )
      throw Error("PREPARED_TRANSFER_POLICY_MISMATCH");
    const gas = integer(prepared.tx.gas, "PREPARED_GAS"),
      gasPrice = integer(prepared.tx.gasPrice, "PREPARED_GAS_PRICE"),
      gasFee = integer(prepared.gasFee, "PREPARED_GAS_FEE");
    if (
      gas * gasPrice !== gasFee ||
      gasFee > BigInt(terms.feeCap) ||
      gasFee > BigInt(terms.maximumDestinationDebit)
    )
      throw Error("PREPARED_TRANSFER_POLICY_MISMATCH");
    return;
  }
  if (terms.network !== "solana" || prepared.genesis !== SOLANA_MAINNET_GENESIS)
    throw Error("PREPARED_TRANSFER_POLICY_MISMATCH");
  const lastValidBlockHeight = integer(
      prepared.lastValidBlockHeight,
      "SOLANA_BLOCK_HEIGHT",
    ),
    fee = nonNegative(prepared.fee, "SOLANA_FEE");
  if (
    lastValidBlockHeight > BigInt(Number.MAX_SAFE_INTEGER) ||
    fee > BigInt(terms.feeCap)
  )
    throw Error("PREPARED_TRANSFER_POLICY_MISMATCH");
  const bytes = Buffer.from(prepared.unsignedWire, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== prepared.unsignedWire)
    throw Error("PREPARED_TRANSFER_POLICY_MISMATCH");
  const tx = getTransactionDecoder().decode(bytes),
    signatures = Object.values(tx.signatures) as (Uint8Array | null)[];
  if (
    signatures.some((signature) => signature !== null) ||
    !Buffer.from(getTransactionEncoder().encode(tx)).equals(bytes)
  )
    throw Error("PREPARED_TRANSFER_POLICY_MISMATCH");
  const expected = compileTransaction(
    pipe(
      createTransactionMessage({ version: "legacy" }),
      (m) => setTransactionMessageFeePayer(address(terms.relayer), m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(prepared.blockhash),
            lastValidBlockHeight,
          },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getTransferSolInstruction({
              source: createNoopSigner(address(terms.relayer)),
              destination: address(terms.recipient),
              amount: BigInt(terms.amount),
            }),
          ],
          m,
        ),
    ),
  );
  if (
    !Buffer.from(tx.messageBytes).equals(Buffer.from(expected.messageBytes)) ||
    prepared.messageBase64 !==
      Buffer.from(expected.messageBytes).toString("base64")
  )
    throw Error("PREPARED_TRANSFER_POLICY_MISMATCH");
}

function assertTerms(
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  now: number,
) {
  if (
    terms.version !== 1 ||
    terms.network !== destinationNetwork(profile.network) ||
    terms.profileDigest !== hash(profile) ||
    termsDigest(terms) !== hash(terms)
  )
    throw Error("PRODUCTION_TERMS_MISMATCH");
  if (terms.expires <= now) throw Error("PRODUCTION_TERMS_EXPIRED");
  const recalculated = mainnetTransferTerms(
    profile,
    {
      recipient: terms.recipient,
      amount: terms.amount,
      feeCap: terms.feeCap,
      l1DataFeeBound: terms.l1DataFeeBound,
      sourceZatoshis: terms.sourceZatoshis,
      sourcePaymentCommitment: terms.sourcePaymentCommitment,
      destinationBinding: terms.destinationBinding,
      quoteDigest: terms.quoteDigest ?? undefined,
      expires: terms.expires,
    },
    Math.min(now, terms.expires - 1),
  );
  if (hash(recalculated) !== hash(terms))
    throw Error("PRODUCTION_TERMS_MISMATCH");
  return recalculated;
}

async function basePreparation(
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  fetcher: typeof fetch,
  now: number,
): Promise<BaseUnsigned> {
  const providers = profile.providers.slice(0, 2),
    reads = [];
  for (const p of providers) {
    const [chainId, block, code, nonce, balance, gas, gasPrice] =
      await Promise.all([
        readProductionRpc(p, "eth_chainId", [], fetcher),
        readProductionRpc(
          p,
          "eth_getBlockByNumber",
          ["finalized", false],
          fetcher,
        ),
        readProductionRpc(
          p,
          "eth_getCode",
          [terms.recipient, "finalized"],
          fetcher,
        ),
        readProductionRpc(
          p,
          "eth_getTransactionCount",
          [terms.relayer, "pending"],
          fetcher,
        ),
        readProductionRpc(
          p,
          "eth_getBalance",
          [terms.relayer, "finalized"],
          fetcher,
        ),
        readProductionRpc(
          p,
          "eth_estimateGas",
          [
            {
              from: terms.relayer,
              to: terms.recipient,
              value: hex(BigInt(terms.amount)),
              data: "0x",
            },
            "finalized",
          ],
          fetcher,
        ),
        readProductionRpc(p, "eth_gasPrice", [], fetcher),
      ]);
    if (chainId !== "0x2105") throw Error("WRONG_NETWORK");
    if (code !== "0x") throw Error("EOA_RECIPIENT_REQUIRED");
    if (!block?.hash || !block?.number)
      throw Error("FINALIZED_HEAD_UNAVAILABLE");
    const blockTime = safeInt(block.timestamp);
    if (Math.abs(now - blockTime) > 1800) throw Error("STALE_FINALIZED_HEAD");
    reads.push({
      blockHash: String(block.hash),
      blockNumber: safeInt(block.number),
      nonce: safeInt(nonce),
      balance: BigInt(balance),
      gas: BigInt(gas),
      gasPrice: BigInt(gasPrice),
    });
  }
  const first = reads[0];
  if (
    reads.some(
      (r) =>
        r.blockHash !== first.blockHash ||
        r.blockNumber !== first.blockNumber ||
        r.nonce !== first.nonce ||
        r.balance !== first.balance ||
        r.gas !== first.gas,
    )
  )
    throw Error("PROVIDER_DISAGREEMENT");
  const gasPrice = reads.reduce(
      (n, r) => (r.gasPrice > n ? r.gasPrice : n),
      0n,
    ),
    gasFee = first.gas * gasPrice,
    totalFeeCap = gasFee + BigInt(terms.l1DataFeeBound),
    required = BigInt(terms.amount) + totalFeeCap;
  if (totalFeeCap > BigInt(terms.feeCap)) throw Error("TOTAL_FEE_CAP");
  if (first.balance < required) throw Error("INSUFFICIENT_RELAYER_LIQUIDITY");
  const prepared: BaseUnsigned = {
    kind: "base-unsigned",
    termsDigest: termsDigest(terms),
    chainId: BASE_MAINNET_CHAIN_ID,
    tx: {
      type: "legacy",
      chainId: BASE_MAINNET_CHAIN_ID,
      to: terms.recipient,
      value: terms.amount,
      data: "0x",
      nonce: first.nonce,
      gas: first.gas.toString(),
      gasPrice: gasPrice.toString(),
    },
    blockHash: first.blockHash,
    blockNumber: String(first.blockNumber),
    gasFee: gasFee.toString(),
    l1DataFeeBound: terms.l1DataFeeBound,
    maximumDestinationDebit: terms.maximumDestinationDebit,
    quoteDigest: "",
  };
  prepared.quoteDigest = hash({
    network: prepared.kind,
    terms: prepared.termsDigest,
    blockHash: prepared.blockHash,
    tx: prepared.tx,
    gasFee: prepared.gasFee,
    l1DataFeeBound: prepared.l1DataFeeBound,
  });
  return prepared;
}

async function solanaPreparation(
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  fetcher: typeof fetch,
  now: number,
): Promise<SolanaUnsigned> {
  const providers = profile.providers.slice(0, 2),
    heads: number[] = [];
  for (const p of providers) {
    const genesis = await readProductionRpc(p, "getGenesisHash", [], fetcher);
    if (genesis !== SOLANA_MAINNET_GENESIS) throw Error("WRONG_NETWORK");
    heads.push(
      safeInt(
        await readProductionRpc(
          p,
          "getSlot",
          [{ commitment: "finalized" }],
          fetcher,
        ),
      ),
    );
  }
  const common = Math.min(...heads);
  if (Math.max(...heads) - common > 20)
    throw Error("FINALIZED_HEAD_DISAGREEMENT");
  const anchors: { blockhash: string; blockTime: number }[] = [],
    balances: bigint[] = [];
  for (const p of providers) {
    const block = await readProductionRpc(
        p,
        "getBlock",
        [
          common,
          {
            commitment: "finalized",
            transactionDetails: "none",
            rewards: false,
            maxSupportedTransactionVersion: 0,
          },
        ],
        fetcher,
      ),
      anchor = {
        blockhash: String(block?.blockhash ?? ""),
        blockTime: safeInt(block?.blockTime),
      };
    if (
      !anchor.blockhash ||
      /^0x0+$/.test(anchor.blockhash) ||
      Math.abs(now - anchor.blockTime) > 300
    )
      throw Error("FINALIZED_HEAD_UNAVAILABLE");
    for (const key of [terms.relayer, terms.recipient]) {
      const account = await readProductionRpc(
        p,
        "getAccountInfo",
        [
          key,
          {
            encoding: "base64",
            commitment: "finalized",
            minContextSlot: common,
          },
        ],
        fetcher,
      );
      if (
        account?.value &&
        (account.value.executable ||
          account.value.owner !== "11111111111111111111111111111111")
      )
        throw Error("SYSTEM_ACCOUNT_REQUIRED");
    }
    const balance = await readProductionRpc(
      p,
      "getBalance",
      [terms.relayer, { commitment: "finalized", minContextSlot: common }],
      fetcher,
    );
    if (safeInt(balance?.context?.slot) < common)
      throw Error("STALE_ACCOUNT_STATE");
    balances.push(BigInt(safeInt(balance?.value)));
    anchors.push(anchor);
  }
  if (
    anchors[0].blockhash !== anchors[1].blockhash ||
    anchors[0].blockTime !== anchors[1].blockTime
  )
    throw Error("PROVIDER_DISAGREEMENT");
  if (balances[0] !== balances[1]) throw Error("PROVIDER_DISAGREEMENT");
  const lifetimes: { blockhash: string; lastValidBlockHeight: bigint }[] = [];
  for (const p of providers) {
    const latest = await readProductionRpc(
      p,
      "getLatestBlockhash",
      [{ commitment: "finalized" }],
      fetcher,
    );
    const value = latest?.value;
    if (
      !value?.blockhash ||
      !Number.isSafeInteger(Number(value.lastValidBlockHeight))
    )
      throw Error("BLOCKHASH_UNAVAILABLE");
    lifetimes.push({
      blockhash: String(value.blockhash),
      lastValidBlockHeight: BigInt(value.lastValidBlockHeight),
    });
  }
  if (lifetimes[0].blockhash !== lifetimes[1].blockhash)
    throw Error("PROVIDER_DISAGREEMENT");
  const high = Math.max(
      Number(lifetimes[0].lastValidBlockHeight),
      Number(lifetimes[1].lastValidBlockHeight),
    ),
    low = Math.min(
      Number(lifetimes[0].lastValidBlockHeight),
      Number(lifetimes[1].lastValidBlockHeight),
    );
  if (high - low > 10) throw Error("BLOCKHASH_LIFETIME_DISAGREEMENT");
  const signer = createNoopSigner(address(terms.relayer)),
    tx = compileTransaction(
      pipe(
        createTransactionMessage({ version: "legacy" }),
        (m) => setTransactionMessageFeePayer(signer.address, m),
        (m) =>
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: blockhash(lifetimes[0].blockhash),
              lastValidBlockHeight: BigInt(high),
            },
            m,
          ),
        (m) =>
          appendTransactionMessageInstructions(
            [
              getTransferSolInstruction({
                source: signer,
                destination: address(terms.recipient),
                amount: BigInt(terms.amount),
              }),
            ],
            m,
          ),
      ),
    ),
    unsignedWire = getBase64EncodedWireTransaction(tx),
    messageBase64 = Buffer.from(tx.messageBytes).toString("base64"),
    fees: bigint[] = [];
  const required = BigInt(terms.amount) + BigInt(terms.feeCap);
  if (balances[0] < required) throw Error("INSUFFICIENT_RELAYER_LIQUIDITY");
  for (const p of providers) {
    if (
      (
        await readProductionRpc(
          p,
          "isBlockhashValid",
          [lifetimes[0].blockhash, { commitment: "finalized" }],
          fetcher,
        )
      ).value !== true
    )
      throw Error("BLOCKHASH_UNAVAILABLE");
    const simulation = await readProductionRpc(
      p,
      "simulateTransaction",
      [
        unsignedWire,
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: "finalized",
          minContextSlot: common,
        },
      ],
      fetcher,
    );
    if (!simulation?.value || simulation.value.err)
      throw Error("SIMULATION_FAILED");
    const fee = await readProductionRpc(
      p,
      "getFeeForMessage",
      [messageBase64, { commitment: "finalized" }],
      fetcher,
    );
    fees.push(BigInt(safeInt(fee?.value)));
  }
  if (fees[0] !== fees[1]) throw Error("FEE_DISAGREEMENT");
  if (fees[0] > BigInt(terms.feeCap)) throw Error("TOTAL_FEE_CAP");
  const prepared: SolanaUnsigned = {
    kind: "solana-unsigned",
    termsDigest: termsDigest(terms),
    genesis: SOLANA_MAINNET_GENESIS,
    unsignedWire,
    messageBase64,
    blockhash: lifetimes[0].blockhash,
    lastValidBlockHeight: String(high),
    slot: common,
    fee: fees[0].toString(),
    maximumDestinationDebit: terms.maximumDestinationDebit,
    quoteDigest: "",
  };
  prepared.quoteDigest = hash({
    network: prepared.kind,
    terms: prepared.termsDigest,
    unsignedWire,
    messageBase64,
    blockhash: prepared.blockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
    slot: prepared.slot,
    fee: prepared.fee,
  });
  return prepared;
}

export async function prepareMainnetTransfer(
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1000),
): Promise<MainnetPrepared> {
  assertTerms(profile, terms, now);
  independentProviders(profile);
  const prepared =
    terms.network === "base"
      ? await basePreparation(profile, terms, fetcher, now)
      : await solanaPreparation(profile, terms, fetcher, now);
  return prepared;
}

async function baseL1Fees(
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  prepared: BaseUnsigned,
  signed: Hex,
  fetcher: typeof fetch,
): Promise<bigint[]> {
  const data = encodeFunctionData({
      abi: l1FeeAbi,
      functionName: "getL1Fee",
      args: [signed],
    }),
    fees: bigint[] = [];
  for (const p of profile.providers.slice(0, 2))
    fees.push(
      BigInt(
        await readProductionRpc(
          p,
          "eth_call",
          [
            {
              from: terms.relayer,
              to: GAS_PRICE_ORACLE,
              data,
            },
            hex(BigInt(prepared.blockNumber)),
          ],
          fetcher,
        ),
      ),
    );
  return fees;
}

function solanaSignedAddress(signature: Uint8Array) {
  return getBase58Decoder().decode(signature) as string;
}

export async function verifyMainnetSignedBundle(
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  prepared: MainnetPrepared,
  bundle: MainnetSignedBundle,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedMainnetBundle> {
  assertTerms(profile, terms, now);
  assertPreparedMainnetTransfer(terms, prepared);
  const expectedTerms = termsDigest(terms),
    expectedPrepared = preparedDigest(prepared);
  if (
    bundle.version !== 1 ||
    bundle.network !== terms.network ||
    bundle.termsDigest !== expectedTerms ||
    prepared.termsDigest !== expectedTerms ||
    bundle.preparedDigest !== expectedPrepared
  )
    throw Error("SIGNED_BUNDLE_BINDING_MISMATCH");
  if (prepared.kind === "base-unsigned") {
    if (terms.network !== "base") throw Error("SIGNED_BUNDLE_NETWORK_MISMATCH");
    if (!/^0x[0-9a-fA-F]+$/.test(bundle.signed))
      throw Error("INVALID_SIGNED_TRANSACTION");
    const raw = bundle.signed as Hex;
    let tx;
    try {
      tx = parseTransaction(raw);
    } catch {
      throw Error("INVALID_SIGNED_TRANSACTION");
    }
    if (
      tx.type !== "legacy" ||
      tx.chainId !== BASE_MAINNET_CHAIN_ID ||
      !tx.to ||
      getAddress(tx.to) !== getAddress(terms.recipient) ||
      tx.value !== BigInt(terms.amount) ||
      (tx.data ?? "0x").toLowerCase() !== "0x" ||
      tx.nonce !== prepared.tx.nonce ||
      tx.gas !== BigInt(prepared.tx.gas) ||
      tx.gasPrice !== BigInt(prepared.tx.gasPrice)
    )
      throw Error("SIGNED_TRANSACTION_POLICY_MISMATCH");
    const recovered = await recoverTransactionAddress({
      serializedTransaction: raw as TransactionSerializedLegacy,
    });
    if (getAddress(recovered) !== getAddress(terms.relayer))
      throw Error("SIGNED_TRANSACTION_SIGNER_MISMATCH");
    const l1Fees = await baseL1Fees(profile, terms, prepared, raw, fetcher);
    if (
      l1Fees.length !== 2 ||
      l1Fees.some((fee) => fee > BigInt(terms.l1DataFeeBound))
    )
      throw Error("L1_DATA_FEE_CAP");
    const gasFee = BigInt(prepared.tx.gas) * BigInt(prepared.tx.gasPrice),
      totalFee = gasFee + (l1Fees[0] > l1Fees[1] ? l1Fees[0] : l1Fees[1]);
    if (totalFee > BigInt(terms.feeCap)) throw Error("TOTAL_FEE_CAP");
    return {
      version: 1,
      network: "base",
      termsDigest: expectedTerms,
      preparedDigest: expectedPrepared,
      signed: raw,
      transactionId: keccak256(raw),
      signedDigest: createHash("sha256").update(raw).digest("hex"),
      totalFee: totalFee.toString(),
      broadcast: false,
    };
  }
  if (terms.network !== "solana") throw Error("SIGNED_BUNDLE_NETWORK_MISMATCH");
  if (prepared.kind !== "solana-unsigned")
    throw Error("SIGNED_BUNDLE_NETWORK_MISMATCH");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(bundle.signed))
    throw Error("INVALID_SIGNED_TRANSACTION");
  const bytes = Buffer.from(bundle.signed, "base64");
  if (bytes.toString("base64") !== bundle.signed)
    throw Error("NONCANONICAL_SIGNED_TRANSACTION");
  const tx = getTransactionDecoder().decode(bytes);
  if (!Buffer.from(getTransactionEncoder().encode(tx)).equals(bytes))
    throw Error("NONCANONICAL_SIGNED_TRANSACTION");
  if (
    !Buffer.from(tx.messageBytes).equals(
      Buffer.from(prepared.messageBase64, "base64"),
    )
  )
    throw Error("SIGNED_MESSAGE_MISMATCH");
  const keys = Object.keys(tx.signatures);
  if (keys.length !== 1 || keys[0] !== terms.relayer)
    throw Error("SIGNED_TRANSACTION_SIGNER_MISMATCH");
  const signature = (tx.signatures as Record<string, Uint8Array>)[
    terms.relayer as Address
  ];
  if (!signature || signature.length !== 64 || signature.every((b) => b === 0))
    throw Error("INVALID_SIGNED_TRANSACTION");
  const publicKey = getAddressEncoder().encode(
      address(terms.relayer),
    ) as Uint8Array,
    valid = verify(
      null,
      Buffer.from(tx.messageBytes),
      createPublicKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",
          x: Buffer.from(publicKey).toString("base64url"),
        },
        format: "jwk",
      }),
      Buffer.from(signature),
    );
  if (!valid) throw Error("SIGNED_TRANSACTION_SIGNER_MISMATCH");
  return {
    version: 1,
    network: "solana",
    termsDigest: expectedTerms,
    preparedDigest: expectedPrepared,
    signed: bundle.signed,
    transactionId: solanaSignedAddress(signature),
    signedDigest: createHash("sha256").update(bytes).digest("hex"),
    totalFee: prepared.fee,
    broadcast: false,
  };
}

// The live boundary is intentionally not implemented as a hidden switch. A
// verified bundle still cannot move funds until a separately audited submitter,
// durable single-writer claim and operator approval are installed.
export function submitMainnetTransfer(): never {
  throw Error(
    "MAINNET_LIVE_EXECUTION_NOT_ACTIVATED_SEPARATE_AUDIT_AND_OPERATOR_APPROVAL_REQUIRED",
  );
}
// Signed bytes are bearer-sensitive until conclusively reconciled. Ordinary
// operator output must not serialize the verified bundle itself.
export function verifiedMainnetSummary(bundle: VerifiedMainnetBundle) {
  return {
    version: bundle.version,
    network: bundle.network,
    termsDigest: bundle.termsDigest,
    preparedDigest: bundle.preparedDigest,
    transactionId: bundle.transactionId,
    signedDigest: bundle.signedDigest,
    totalFee: bundle.totalFee,
    broadcast: false,
    signing: false,
  };
}
