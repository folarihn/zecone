import { createHash } from "node:crypto";
import {
  address,
  blockhash,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getTransferCheckedInstruction,
  findAssociatedTokenPda,
} from "@solana-program/token";
import {
  Devnet,
  GENESIS,
  TOKEN,
  SolanaError,
  publicKey,
  json,
} from "./network.ts";
export type Action = {
  family: "solana";
  network: "solana:devnet";
  genesis: typeof GENESIS;
  owner: string;
  recipient: string;
  amount: string;
  asset: { kind: "SOL" } | { kind: "SPL"; mint: string; decimals: number };
  feeCap: string;
};
export type Lifetime = {
  blockhash: ReturnType<typeof blockhash>;
  lastValidBlockHeight: bigint;
};
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function validateAction(action: Action, disposable: readonly string[]) {
  if (
    action.family !== "solana" ||
    action.network !== "solana:devnet" ||
    action.genesis !== GENESIS
  )
    throw new SolanaError("WRONG_NETWORK");
  publicKey(action.owner);
  publicKey(action.recipient);
  if (
    !disposable.includes(action.owner) ||
    !disposable.includes(action.recipient) ||
    action.owner === action.recipient
  )
    throw new SolanaError("DISPOSABLE_ACCOUNTS_REQUIRED");
  if (
    !/^[1-9]\d*$/.test(action.amount) ||
    BigInt(action.amount) > (1n << 64n) - 1n
  )
    throw new SolanaError("INVALID_AMOUNT");
  if (!/^\d+$/.test(action.feeCap) || BigInt(action.feeCap) > 100000n)
    throw new SolanaError("FEE_CAP");
  if (action.asset.kind === "SOL") {
    if (BigInt(action.amount) > 10000000n) throw new SolanaError("AMOUNT_CAP");
  } else if (action.asset.kind === "SPL") {
    publicKey(action.asset.mint);
    if (
      !Number.isInteger(action.asset.decimals) ||
      action.asset.decimals < 0 ||
      action.asset.decimals > 255
    )
      throw new SolanaError("INVALID_DECIMALS");
  } else throw new SolanaError("UNSUPPORTED_ASSET");
}
export async function transaction(action: Action, lifetime: Lifetime) {
  const signer = createNoopSigner(publicKey(action.owner));
  const instruction =
    action.asset.kind === "SOL"
      ? getTransferSolInstruction({
          source: signer,
          destination: publicKey(action.recipient),
          amount: BigInt(action.amount),
        })
      : getTransferCheckedInstruction({
          source: await ata(action.owner, action.asset.mint),
          destination: await ata(action.recipient, action.asset.mint),
          mint: address(action.asset.mint),
          authority: signer,
          amount: BigInt(action.amount),
          decimals: action.asset.decimals,
        });
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: "legacy" }),
      (tx) => setTransactionMessageFeePayer(signer.address, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
      (tx) => appendTransactionMessageInstructions([instruction], tx),
    ),
  );
}
export async function ata(owner: string, mint: string) {
  return (
    await findAssociatedTokenPda({
      owner: publicKey(owner),
      mint: publicKey(mint),
      tokenProgram: address(TOKEN),
    })
  )[0];
}
// Canonical reconstruction rejects arbitrary programs, extra accounts, lookup tables,
// fee-payer substitution, noncanonical encodings and every instruction not reviewed.
export async function inspect(
  wire: string,
  action: Action,
  lifetime: Lifetime,
  disposable: readonly string[],
) {
  validateAction(action, disposable);
  if (wire.length > 1700 || !/^[A-Za-z0-9+/]*={0,2}$/.test(wire))
    throw new SolanaError("INVALID_TRANSACTION");
  const bytes = Buffer.from(wire, "base64");
  if (bytes.toString("base64") !== wire)
    throw new SolanaError("INVALID_TRANSACTION");
  const actual = getTransactionDecoder().decode(bytes);
  if (!Buffer.from(getTransactionEncoder().encode(actual)).equals(bytes))
    throw new SolanaError("NONCANONICAL_TRANSACTION");
  const expected = await transaction(action, lifetime);
  if (
    !Buffer.from(actual.messageBytes).equals(
      Buffer.from(expected.messageBytes),
    ) ||
    Object.keys(actual.signatures).length !== 1 ||
    !Object.hasOwn(actual.signatures, action.owner)
  )
    throw new SolanaError("UNSUPPORTED_TRANSACTION");
  const decoded = getCompiledTransactionMessageDecoder().decode(
    actual.messageBytes,
  );
  if (decoded.version !== "legacy")
    throw new SolanaError("UNSUPPORTED_TRANSACTION");
  return actual;
}
export async function validateToken(net: Devnet, action: Action) {
  if (action.asset.kind !== "SPL") return;
  const mint: any = await net.account(action.asset.mint);
  const info = mint?.data?.parsed?.info;
  if (
    mint?.owner !== TOKEN ||
    mint?.data?.parsed?.type !== "mint" ||
    !info?.isInitialized ||
    info.decimals !== action.asset.decimals ||
    info.freezeAuthority ||
    info.extensions?.length
  )
    throw new SolanaError("UNSUPPORTED_MINT");
  for (const owner of [action.owner, action.recipient]) {
    const account: any = await net.account(await ata(owner, action.asset.mint));
    const a = account?.data?.parsed?.info;
    if (
      account?.owner !== TOKEN ||
      !a ||
      a.owner !== owner ||
      a.mint !== action.asset.mint ||
      a.state !== "initialized" ||
      a.delegate ||
      a.closeAuthority ||
      a.extensions?.length
    )
      throw new SolanaError("UNSUPPORTED_TOKEN_ACCOUNT");
    if (
      owner === action.owner &&
      BigInt(a.tokenAmount.amount) < BigInt(action.amount)
    )
      throw new SolanaError("INSUFFICIENT_TOKENS");
  }
}
export async function prepare(
  net: Devnet,
  action: Action,
  disposable: readonly string[],
) {
  validateAction(action, disposable);
  await validateToken(net, action);
  const lifetime = await net.latest();
  const tx = await transaction(action, lifetime),
    wire = getBase64EncodedWireTransaction(tx);
  await inspect(wire, action, lifetime, disposable);
  const fee = await net.fee(Buffer.from(tx.messageBytes).toString("base64"));
  if (fee === null || fee > BigInt(action.feeCap))
    throw new SolanaError("FEE_UNAVAILABLE_OR_EXCESSIVE");
  if (!(await net.valid(lifetime.blockhash)))
    throw new SolanaError("BLOCKHASH_EXPIRED");
  const simulation = await net.simulate(wire);
  return {
    action,
    lifetime: {
      ...lifetime,
      lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
    },
    wire,
    fee: fee.toString(),
    digest: digest(wire),
    simulation: JSON.parse(
      json({
        err: simulation.err,
        unitsConsumed: simulation.unitsConsumed ?? null,
      }),
    ),
    state: simulation.err ? "SIMULATION_FAILED" : "AWAITING_EXPLICIT_APPROVAL",
  };
}
export type Prepared = Awaited<ReturnType<typeof prepare>>;
