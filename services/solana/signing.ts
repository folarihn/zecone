import {
  blockhash,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransaction,
} from "@solana/kit";
import { type Accounts } from "./accounts.ts";
import { type Devnet, SolanaError } from "./network.ts";
import { inspect, validateToken } from "./transactions.ts";
import { type SolanaJournal } from "./journal.ts";
// Local-only signing boundary. Not exposed to the Phase 7A browser server.
export async function signReviewed(
  journal: SolanaJournal,
  net: Devnet,
  accounts: Accounts,
  id: string,
  hash: string,
  approved: boolean,
  disposable: readonly string[],
) {
  const row = journal.get(id);
  if (!row) throw new SolanaError("UNKNOWN_TRANSACTION");
  const p = JSON.parse(row.payload);
  const signer = accounts.signer(p.action.owner);
  if (!(await net.valid(blockhash(p.lifetime.blockhash))))
    throw new SolanaError("BLOCKHASH_EXPIRED");
  await validateToken(net, p.action);
  const tx = await inspect(
    p.wire,
    p.action,
    {
      blockhash: blockhash(p.lifetime.blockhash),
      lastValidBlockHeight: BigInt(p.lifetime.lastValidBlockHeight),
    },
    disposable,
  );
  const sim = await net.simulate(p.wire);
  if (sim.err) throw new SolanaError("SIMULATION_FAILED");
  const fee = await net.fee(Buffer.from(tx.messageBytes).toString("base64"));
  if (fee === null || fee > BigInt(p.action.feeCap))
    throw new SolanaError("FEE_UNAVAILABLE_OR_EXCESSIVE");
  journal.claimSigning(id, hash, approved);
  const signed = await signTransaction([signer.keyPair], tx);
  const signature = getSignatureFromTransaction(signed);
  journal.recordSignature(
    id,
    signature,
    getBase64EncodedWireTransaction(signed),
  );
  return { signature, wire: getBase64EncodedWireTransaction(signed) };
}
