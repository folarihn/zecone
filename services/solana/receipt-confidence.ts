import { signature } from "@solana/kit";
import { GENESIS, publicKey } from "./network.ts";
import {
  EvidenceReader,
  EvidenceError,
  canonical,
  type ReadRpc,
} from "../execution/rpc-confidence.ts";
const invalid = (): never => {
  throw new EvidenceError("INVALID_EVIDENCE");
};
const uint = (n: any) => (Number.isSafeInteger(n) && n >= 0 ? n : invalid());
function tokens(rows: any) {
  if (!Array.isArray(rows)) return invalid();
  const indexes = new Set<number>();
  return rows
    .map((r: any) => {
      const index = uint(r.accountIndex);
      if (
        indexes.has(index) ||
        typeof r.mint !== "string" ||
        typeof r.owner !== "string" ||
        !/^\d+$/.test(r.uiTokenAmount?.amount) ||
        !Number.isSafeInteger(r.uiTokenAmount?.decimals) ||
        r.uiTokenAmount.decimals < 0 ||
        r.uiTokenAmount.decimals > 255 ||
        BigInt(r.uiTokenAmount.amount) > 18446744073709551615n
      )
        return invalid();
      indexes.add(index);
      publicKey(r.mint);
      publicKey(r.owner);
      return {
        index,
        mint: r.mint,
        owner: r.owner,
        programId: r.programId ?? null,
        amount: r.uiTokenAmount.amount,
        decimals: r.uiTokenAmount.decimals,
      };
    })
    .sort((a: any, b: any) => a.index - b.index);
}
async function observe(rpc: ReadRpc, sig: string) {
  if ((await rpc("getGenesisHash", [])) !== GENESIS)
    throw new EvidenceError("WRONG_NETWORK");
  const receipt = await rpc("getTransaction", [
    sig,
    {
      commitment: "finalized",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  if (!receipt) return null;
  const slot = uint(receipt.slot);
  const statuses = await rpc("getSignatureStatuses", [
    [sig],
    { searchTransactionHistory: true },
  ]);
  const status = statuses?.value?.[0];
  if (!status || status.confirmationStatus !== "finalized") return null;
  if (
    uint(status.slot) !== slot ||
    canonical(status.err) !== canonical(receipt.meta?.err)
  )
    return invalid();
  const head = uint(await rpc("getSlot", [{ commitment: "finalized" }]));
  if (head < slot) return null;
  const block = await rpc("getBlock", [
    slot,
    { commitment: "finalized", transactionDetails: "none", rewards: false },
  ]);
  if (!block) return null;
  const meta = receipt.meta,
    tx = receipt.transaction;
  if (!["legacy", 0].includes(receipt.version)) return invalid();
  if (
    typeof block.blockhash !== "string" ||
    typeof block.previousBlockhash !== "string" ||
    uint(block.parentSlot) >= slot ||
    tx?.signatures?.[0] !== sig ||
    !tx.message ||
    !Array.isArray(tx.message.accountKeys) ||
    !Array.isArray(tx.message.instructions) ||
    !Array.isArray(meta?.preBalances) ||
    !Array.isArray(meta.postBalances) ||
    meta.preBalances.length !== meta.postBalances.length ||
    !Object.hasOwn(meta, "err")
  )
    return invalid();
  publicKey(block.blockhash);
  publicKey(block.previousBlockhash);
  const loaded = meta.loadedAddresses;
  if (
    receipt.version === 0 &&
    (!Array.isArray(loaded?.readonly) || !Array.isArray(loaded?.writable))
  )
    return invalid();
  const accountCount =
    tx.message.accountKeys.length +
    (loaded?.readonly?.length ?? 0) +
    (loaded?.writable?.length ?? 0);
  if (
    meta.preBalances.length !== accountCount ||
    !Array.isArray(meta.preTokenBalances) ||
    !Array.isArray(meta.postTokenBalances)
  )
    return invalid();
  for (const row of [...meta.preTokenBalances, ...meta.postTokenBalances])
    if (uint(row.accountIndex) >= accountCount) return invalid();
  meta.preBalances.forEach(uint);
  meta.postBalances.forEach(uint);
  uint(meta.fee);
  const material = {
    slot,
    blockhash: block.blockhash,
    previousBlockhash: block.previousBlockhash,
    parentSlot: block.parentSlot,
    version: receipt.version,
    signatures: tx.signatures,
    message: tx.message,
    err: meta.err,
    fee: meta.fee,
    preBalances: meta.preBalances,
    postBalances: meta.postBalances,
    preTokens: tokens(meta.preTokenBalances ?? []),
    postTokens: tokens(meta.postTokenBalances ?? []),
    loadedAddresses: meta.loadedAddresses ?? null,
    innerInstructions: meta.innerInstructions ?? [],
  };
  return { evidence: receipt, material };
}
export function solanaReceiptEvidence(reader: EvidenceReader, sig: string) {
  try {
    signature(sig);
  } catch {
    throw new EvidenceError("INVALID_DESTINATION_REFERENCE");
  }
  return reader.verify("SOLANA_FINALIZED_TRANSACTION", (rpc) =>
    observe(rpc, sig),
  );
}
