import {
  signTransaction,
  signTransactionWithSigners,
  type KeyPairSigner,
  type MessagePartialSigner,
  type TransactionPartialSigner,
} from "@solana/kit";
import { SignerLease, LeaseError, type WalletRole } from "../signer/lease.ts";
export type LeasedSigner = MessagePartialSigner & TransactionPartialSigner;
const managed = new WeakMap<object, () => void>();
export function leasedSigner(
  lease: SignerLease<KeyPairSigner>,
  address: KeyPairSigner["address"],
  role: WalletRole,
): LeasedSigner {
  const generation = lease.capture(role);
  const signer: LeasedSigner = Object.freeze({
    address,
    signMessages: async (messages, config) => {
      if (messages.length !== 1)
        throw new LeaseError("SINGLE_SIGNING_OPERATION_REQUIRED");
      return lease.run(role, generation, (s) =>
        s.signMessages(messages, config),
      );
    },
    signTransactions: async (transactions, config) => {
      if (transactions.length !== 1)
        throw new LeaseError("SINGLE_SIGNING_OPERATION_REQUIRED");
      return lease.run(role, generation, (s) =>
        s.signTransactions(transactions, config),
      );
    },
  });
  managed.set(signer, () => {
    if (lease.capture(role) !== generation)
      throw new LeaseError("WALLET_LOCKED");
  });
  return signer;
}
// The legacy KeyPairSigner path is unchanged. New encrypted accounts never
// export CryptoKeyPair, so retained facades can be revoked immediately.
export async function signWithLocalSigner(
  signer: KeyPairSigner | LeasedSigner,
  tx: Parameters<typeof signTransaction>[1],
) {
  const check = managed.get(signer);
  if (!check) return signTransaction([(signer as KeyPairSigner).keyPair], tx);
  check();
  const signed = await signTransactionWithSigners([signer], tx);
  check();
  return signed;
}
