// One inspected Raydium devnet CPMM route. No DEX API or arbitrary route import.
import { createHash } from "node:crypto";
import {
  address,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  getBase58Decoder,
  type Instruction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getSyncNativeInstruction,
} from "@solana-program/token";
import {
  Devnet,
  TOKEN,
  GENESIS,
  publicKey,
  SolanaError,
  json,
} from "./network.ts";
import { ata, digest, type Lifetime } from "./transactions.ts";
import type { SolanaDeliveryIntent } from "./settlement-model.ts";

export const CPMM = "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb";
export const POOL = "12aukygfT6qr5KH9MeeVYb4Y9rsmTzAVzUn633BRCfd";
export const WSOL = "So11111111111111111111111111111111111111112";
export const OUTPUT = "2j76mnkJEBxbYv8T9c76PbsGzf5XuhpRoK1kwwTg9MpY";
export const AUTH = "CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq";
export const CONFIG = "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy";
export const VAULT_IN = "4TQu6vwQNkXDz5ZiqcUZe11zrCJCpf6qTv2Gt3UtzbX3";
export const VAULT_OUT = "C6gvtaevcYZ68qdoeV1Li5MSEgaNZvvTXaeQJ7qucTrh";
export const OBSERVATION = "FV3yuMh8VA4AWintdGnpBJ5L45W7e5gm3ByvKLLanVJ4";
export const PROGRAM_DATA = "3KvTa2fYhMxMZNfHho5oX34yLQLwRauoU2JScBkugvXF";
export const PROGRAM_HASH =
  "180aa094c9dc9895f134cb3949097ac3d9a3bb0480b069f7f2859e6ef97fc336";
export type { SwapTerms } from "./settlement-model.ts";
import type { SwapTerms } from "./settlement-model.ts";
export type SwapPrepared = {
  wire: string;
  digest: string;
  fee: string;
  lifetime: { blockhash: string; lastValidBlockHeight: string };
  simulation: { err: unknown; unitsConsumed: string | null };
  swap: SwapTerms;
  expiresAt: number;
  quotedAt?: number;
  quoteExpiresAt?: number;
  approvalExpiresAt?: number;
  quotedOutput?: string;
};
const fail = (code: string): never => {
  throw new SolanaError(code);
};
const discriminator = (name: string) =>
  createHash("sha256").update(name).digest().subarray(0, 8);
const keyAt = (b: Buffer, offset: number) =>
  getBase58Decoder().decode(b.subarray(offset, offset + 32));
const u64 = (b: Buffer, offset: number) => b.readBigUInt64LE(offset);
export type RawAccount = {
  owner: string;
  executable: boolean;
  data: Buffer;
} | null;
export type PoolSnapshot = {
  reserveIn: bigint;
  reserveOut: bigint;
  feeRate: bigint;
};
export function verifyProgram(program: RawAccount, data: RawAccount) {
  const loader = "BPFLoaderUpgradeab1e11111111111111111111111";
  if (
    !program ||
    !data ||
    program.owner !== loader ||
    !program.executable ||
    program.data.length !== 36 ||
    program.data.readUInt32LE(0) !== 2 ||
    keyAt(program.data, 4) !== PROGRAM_DATA ||
    data.owner !== loader ||
    data.executable ||
    createHash("sha256").update(data.data).digest("hex") !== PROGRAM_HASH
  )
    fail("POOL_OR_PROGRAM_CHANGED");
}

export function validateTerms(t: SwapTerms) {
  if (
    !t ||
    t.program !== CPMM ||
    t.pool !== POOL ||
    t.inputMint !== WSOL ||
    t.outputMint !== OUTPUT ||
    t.inputDecimals !== 9 ||
    t.outputDecimals !== 6 ||
    t.amountIn !== "1000000" ||
    t.slippageBps !== 100 ||
    t.programHash !== PROGRAM_HASH ||
    !/^[1-9]\d{0,19}$/.test(t.expectedOut) ||
    !/^[1-9]\d{0,19}$/.test(t.minimumOut) ||
    BigInt(t.expectedOut) > (1n << 64n) - 1n ||
    BigInt(t.minimumOut) !== (BigInt(t.expectedOut) * 9900n) / 10000n
  )
    fail("UNSUPPORTED_SWAP_TERMS");
}
export function quoteOutput(s: PoolSnapshot, amount = 1000000n) {
  if (
    s.reserveIn <= 0n ||
    s.reserveOut <= 0n ||
    s.feeRate < 0n ||
    s.feeRate > 10000n
  )
    fail("INVALID_POOL_LIQUIDITY");
  const net = amount - (amount * s.feeRate + 999999n) / 1000000n;
  return (net * s.reserveOut) / (s.reserveIn + net);
}
export function decodePool(
  accounts: RawAccount[],
  now = Math.floor(Date.now() / 1000),
): PoolSnapshot {
  if (accounts.length !== 7 || accounts.some((a) => !a))
    fail("MISSING_POOL_ACCOUNT");
  const [pool, config, vin, vout, min, mout, obs] = accounts as Exclude<
    RawAccount,
    null
  >[];
  if (
    pool.owner !== CPMM ||
    pool.data.length !== 637 ||
    !pool.data.subarray(0, 8).equals(discriminator("account:PoolState")) ||
    config.owner !== CPMM ||
    config.data.length !== 236 ||
    !config.data.subarray(0, 8).equals(discriminator("account:AmmConfig")) ||
    obs.owner !== CPMM ||
    obs.data.length < 8 ||
    !obs.data.subarray(0, 8).equals(discriminator("account:ObservationState"))
  )
    fail("POOL_OR_PROGRAM_CHANGED");
  const expected = [
    CONFIG,
    null,
    VAULT_IN,
    VAULT_OUT,
    null,
    WSOL,
    OUTPUT,
    TOKEN,
    TOKEN,
    OBSERVATION,
  ];
  expected.forEach((k, i) => {
    if (k && keyAt(pool.data, 8 + 32 * i) !== k) fail("POOL_ACCOUNT_MISMATCH");
  });
  if (
    pool.data[329] & 4 ||
    pool.data[331] !== 9 ||
    pool.data[332] !== 6 ||
    pool.data[390] !== 0 ||
    u64(pool.data, 373) > BigInt(now)
  )
    fail("UNSUPPORTED_POOL_STATE");
  for (const [a, decimals] of [
    [min, 9],
    [mout, 6],
  ] as const) {
    if (
      a.owner !== TOKEN ||
      a.data.length !== 82 ||
      a.data[45] !== 1 ||
      a.data[44] !== decimals ||
      a.data.readUInt32LE(0) !== 0 ||
      a.data.readUInt32LE(46) !== 0
    )
      fail("UNSUPPORTED_MINT");
  }
  for (const [a, mint] of [
    [vin, WSOL],
    [vout, OUTPUT],
  ] as const)
    validateTokenAccount(a, mint, AUTH);
  const reserveIn =
    u64(vin.data, 64) -
    u64(pool.data, 341) -
    u64(pool.data, 357) -
    u64(pool.data, 397);
  const reserveOut =
    u64(vout.data, 64) -
    u64(pool.data, 349) -
    u64(pool.data, 365) -
    u64(pool.data, 405);
  const result = { reserveIn, reserveOut, feeRate: u64(config.data, 12) };
  quoteOutput(result);
  return result;
}
export function validateTokenAccount(
  a: RawAccount,
  mint: string,
  owner: string,
) {
  if (
    !a ||
    a.owner !== TOKEN ||
    a.data.length !== 165 ||
    keyAt(a.data, 0) !== mint ||
    keyAt(a.data, 32) !== owner ||
    a.data[108] !== 1 ||
    a.data.readUInt32LE(72) !== 0 ||
    a.data.readUInt32LE(129) !== 0
  )
    fail("UNSUPPORTED_TOKEN_ACCOUNT");
}
export async function swapTransaction(
  i: SolanaDeliveryIntent,
  t: SwapTerms,
  lifetime: Lifetime,
) {
  validateTerms(t);
  if (
    i.network !== "solana:devnet" ||
    i.genesis !== GENESIS ||
    i.lamports !== t.amountIn ||
    i.feeCap !== "10000" ||
    i.relayer === i.recipient
  )
    fail("SWAP_BINDING");
  const signer = createNoopSigner(publicKey(i.relayer)),
    input = await ata(i.relayer, WSOL),
    output = await ata(i.recipient, OUTPUT);
  const data = Buffer.alloc(24);
  discriminator("global:swap_base_input").copy(data);
  data.writeBigUInt64LE(BigInt(t.amountIn), 8);
  data.writeBigUInt64LE(BigInt(t.minimumOut), 16);
  const swap: Instruction = {
    programAddress: address(CPMM),
    accounts: [
      { address: signer.address, role: 2 },
      { address: address(AUTH), role: 0 },
      { address: address(CONFIG), role: 0 },
      { address: address(POOL), role: 1 },
      { address: input, role: 1 },
      { address: output, role: 1 },
      { address: address(VAULT_IN), role: 1 },
      { address: address(VAULT_OUT), role: 1 },
      { address: address(TOKEN), role: 0 },
      { address: address(TOKEN), role: 0 },
      { address: address(WSOL), role: 0 },
      { address: address(OUTPUT), role: 0 },
      { address: address(OBSERVATION), role: 1 },
    ],
    data,
  };
  const instructions = [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: signer,
      ata: input,
      owner: signer.address,
      mint: address(WSOL),
    }),
    getTransferSolInstruction({
      source: signer,
      destination: input,
      amount: BigInt(t.amountIn),
    }),
    getSyncNativeInstruction({ account: input }),
    getCreateAssociatedTokenIdempotentInstruction({
      payer: signer,
      ata: output,
      owner: publicKey(i.recipient),
      mint: address(OUTPUT),
    }),
    swap,
  ];
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: "legacy" }),
      (tx) => setTransactionMessageFeePayer(signer.address, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
    ),
  );
}
export async function inspectSwap(i: SolanaDeliveryIntent, p: SwapPrepared) {
  validateTerms(i.swap!);
  if (
    json(p.swap) !== json(i.swap) ||
    p.digest !== digest(p.wire) ||
    p.wire.length > 1644 ||
    Buffer.from(p.wire, "base64").toString("base64") !== p.wire
  )
    fail("SWAP_BINDING");
  const tx = getTransactionDecoder().decode(Buffer.from(p.wire, "base64"));
  const expected = await swapTransaction(i, i.swap!, {
    blockhash: blockhash(p.lifetime.blockhash),
    lastValidBlockHeight: BigInt(p.lifetime.lastValidBlockHeight),
  });
  if (
    !Buffer.from(getTransactionEncoder().encode(tx)).equals(
      Buffer.from(p.wire, "base64"),
    ) ||
    !Buffer.from(tx.messageBytes).equals(Buffer.from(expected.messageBytes)) ||
    Object.keys(tx.signatures).length !== 1 ||
    !Object.hasOwn(tx.signatures, i.relayer)
  )
    fail("ARBITRARY_SWAP_INSTRUCTION");
  return tx;
}

export class CpmmPolicy {
  readonly queryCounts: Record<string, number> = {};
  constructor(
    readonly net = new Devnet(),
    readonly now = () => Math.floor(Date.now() / 1000),
  ) {}
  async raw(keys: string[]): Promise<RawAccount[]> {
    this.queryCounts.getMultipleAccounts =
      (this.queryCounts.getMultipleAccounts ?? 0) + 1;
    return this.net.read(async (signal) => {
      const result = await this.net.rpc
        .getMultipleAccounts(keys.map(publicKey), {
          encoding: "base64",
          commitment: "confirmed",
        })
        .send({ abortSignal: signal });
      return result.value.map((a) =>
        a
          ? {
              owner: a.owner,
              executable: a.executable,
              data: Buffer.from(a.data[0], "base64"),
            }
          : null,
      );
    });
  }
  async pool() {
    const accounts = await this.raw([
      POOL,
      CONFIG,
      VAULT_IN,
      VAULT_OUT,
      WSOL,
      OUTPUT,
      OBSERVATION,
      PROGRAM_DATA,
      CPMM,
    ]);
    verifyProgram(accounts[8], accounts[7]);
    return decodePool(accounts.slice(0, 7), this.now());
  }
  async terms(): Promise<SwapTerms> {
    const out = quoteOutput(await this.pool());
    const t: SwapTerms = {
      program: CPMM,
      pool: POOL,
      inputMint: WSOL,
      outputMint: OUTPUT,
      inputDecimals: 9,
      outputDecimals: 6,
      amountIn: "1000000",
      slippageBps: 100,
      expectedOut: out.toString(),
      minimumOut: ((out * 9900n) / 10000n).toString(),
      programHash: PROGRAM_HASH,
    };
    validateTerms(t);
    return t;
  }
  async accounts(i: SolanaDeliveryIntent) {
    const keys = [await ata(i.relayer, WSOL), await ata(i.recipient, OUTPUT)];
    const accounts = await this.raw(keys);
    accounts.forEach((a, n) => {
      if (a)
        validateTokenAccount(
          a,
          n === 0 ? WSOL : OUTPUT,
          n === 0 ? i.relayer : i.recipient,
        );
    });
    if (accounts[0] && u64(accounts[0].data, 64) !== 0n)
      fail("INPUT_ATA_MUST_BE_EMPTY");
    const rent = await this.net.read((s) =>
      this.net.rpc
        .getMinimumBalanceForRentExemption(165n)
        .send({ abortSignal: s }),
    );
    if (rent > 3000000n) fail("RENT_CAP");
    const needed =
      BigInt(i.lamports) +
      BigInt(i.feeCap) +
      rent * BigInt(accounts.filter((a) => !a).length);
    if ((await this.net.balance(i.relayer)) < needed)
      fail("INSUFFICIENT_RELAYER_BALANCE");
  }
  async prepare(
    i: SolanaDeliveryIntent,
    preparationDeadline = i.expiry,
  ): Promise<SwapPrepared> {
    validateTerms(i.swap!);
    const quotedOutput = quoteOutput(await this.pool());
    if (quotedOutput < BigInt(i.swap!.minimumOut)) fail("SLIPPAGE_VIOLATION");
    if ((quotedOutput * 9900n) / 10000n > BigInt(i.swap!.minimumOut))
      fail("FRESH_QUOTE_REQUIRES_CHANGED_MINIMUM_APPROVAL");
    await this.accounts(i);
    const lifetime = await this.net.latest(),
      tx = await swapTransaction(i, i.swap!, lifetime),
      wire = getBase64EncodedWireTransaction(tx);
    const fee = await this.net.fee(
      Buffer.from(tx.messageBytes).toString("base64"),
    );
    if (fee === null || fee > BigInt(i.feeCap)) fail("FEE_CAP");
    if (!(await this.net.valid(lifetime.blockhash))) fail("BLOCKHASH_EXPIRED");
    const simulation = await this.net.simulate(wire);
    const p: SwapPrepared = {
      wire,
      digest: digest(wire),
      fee: fee!.toString(),
      lifetime: {
        blockhash: lifetime.blockhash,
        lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
      },
      swap: i.swap!,
      quotedOutput: quotedOutput.toString(),
      // These are application deadlines; neither extends lastValidBlockHeight.
      quotedAt: this.now(),
      quoteExpiresAt: Math.min(preparationDeadline, this.now() + 90),
      approvalExpiresAt: Math.min(preparationDeadline, this.now() + 300),
      expiresAt: Math.min(preparationDeadline, this.now() + 90),
      simulation: {
        err: simulation.err,
        unitsConsumed: simulation.unitsConsumed?.toString() ?? null,
      },
    };
    await inspectSwap(i, p);
    return p;
  }
  async inspect(i: SolanaDeliveryIntent, p: SwapPrepared) {
    if (p.expiresAt <= this.now()) fail("SWAP_QUOTE_EXPIRED");
    if (quoteOutput(await this.pool()) < BigInt(i.swap!.minimumOut))
      fail("SLIPPAGE_VIOLATION");
    await this.accounts(i);
    return inspectSwap(i, p);
  }
  async verifyEffects(i: SolanaDeliveryIntent, receipt: any) {
    const keys: string[] = receipt.transaction.message.accountKeys,
      m = receipt.meta;
    const input = await ata(i.relayer, WSOL),
      output = await ata(i.recipient, OUTPUT);
    const token = (
      list: any[],
      account: string,
      mint: string,
      owner: string,
      decimals: number,
      missing = false,
    ) => {
      const rows = list.filter((x) => x.accountIndex === keys.indexOf(account));
      if (!rows.length && missing) return 0n;
      if (rows.length !== 1) fail("TOKEN_EFFECT_MISSING");
      const r = rows[0];
      if (
        r.mint !== mint ||
        r.owner !== owner ||
        r.programId !== TOKEN ||
        r.uiTokenAmount.decimals !== decimals ||
        !/^\d+$/.test(r.uiTokenAmount.amount)
      )
        fail("TOKEN_EFFECT_MISMATCH");
      return BigInt(r.uiTokenAmount.amount);
    };
    const before = (a: string, mint: string, owner: string, d: number) =>
      token(
        m.preTokenBalances,
        a,
        mint,
        owner,
        d,
        BigInt(m.preBalances[keys.indexOf(a)]) === 0n,
      );
    const after = (a: string, mint: string, owner: string, d: number) =>
      token(m.postTokenBalances, a, mint, owner, d);
    const out =
      after(output, OUTPUT, i.recipient, 6) -
      before(output, OUTPUT, i.recipient, 6);
    if (
      out < BigInt(i.swap!.minimumOut) ||
      after(VAULT_OUT, OUTPUT, AUTH, 6) - before(VAULT_OUT, OUTPUT, AUTH, 6) !==
        -out ||
      after(VAULT_IN, WSOL, AUTH, 9) - before(VAULT_IN, WSOL, AUTH, 9) !==
        BigInt(i.lamports) ||
      after(input, WSOL, i.relayer, 9) !== 0n ||
      before(input, WSOL, i.relayer, 9) !== 0n
    )
      fail("SWAP_EFFECT_MISMATCH");
    const rent = [input, output].reduce((n, a) => {
      const k = keys.indexOf(a),
        pre = BigInt(m.preBalances[k]),
        post = BigInt(m.postBalances[k]);
      if (pre === 0n) {
        if (post > 3000000n || post <= 0n) fail("RENT_CAP");
        return n + post;
      }
      if (post !== pre) fail("ATA_RENT_CHANGED");
      return n;
    }, 0n);
    const debit = BigInt(m.preBalances[0]) - BigInt(m.postBalances[0]);
    if (
      keys[0] !== i.relayer ||
      debit !== BigInt(i.lamports) + BigInt(m.fee) + rent
    )
      fail("SWAP_DEBIT_MISMATCH");
    return {
      recipientDelta: out.toString(),
      input: i.lamports,
      rent: rent.toString(),
      relayerDelta: debit.toString(),
    };
  }
}
