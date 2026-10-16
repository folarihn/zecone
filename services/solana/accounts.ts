import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  type KeyPairSigner,
} from "@solana/kit";
import { SolanaError, publicKey } from "./network.ts";
const ROOT = ".secrets/phase7a-solana";
export class Accounts {
  private unlocked = new Map<string, KeyPairSigner>();
  static async generate(label: "payer" | "recipient") {
    mkdirSync(ROOT, { recursive: true });
    const file = `${ROOT}/${label}.json`;
    if (existsSync(file)) throw new SolanaError("ACCOUNT_EXISTS");
    const seed = randomBytes(32);
    try {
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      writeFileSync(
        file,
        JSON.stringify({ address: signer.address, seed: Array.from(seed) }),
        { flag: "wx", mode: 0o600 },
      );
      return signer.address;
    } finally {
      seed.fill(0);
    }
  }
  static list() {
    return (["payer", "recipient"] as const)
      .filter((label) => existsSync(`${ROOT}/${label}.json`))
      .map((label) => ({
        label,
        address: publicKey(
          JSON.parse(readFileSync(`${ROOT}/${label}.json`, "utf8")).address,
        ),
      }));
  }
  async unlock(label: string, explicit: boolean) {
    if (!explicit || !["payer", "recipient"].includes(label))
      throw new SolanaError("APPROVAL_REQUIRED");
    const saved = JSON.parse(readFileSync(`${ROOT}/${label}.json`, "utf8"));
    const seed = Uint8Array.from(saved.seed as number[]);
    try {
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      if (signer.address !== saved.address)
        throw new SolanaError("ACCOUNT_MISMATCH");
      this.unlocked.set(signer.address, signer);
      return signer.address;
    } finally {
      seed.fill(0);
    }
  }
  lock() {
    this.unlocked.clear();
  }
  signer(owner: string) {
    const signer = this.unlocked.get(owner);
    if (!signer) throw new SolanaError("WALLET_LOCKED");
    return signer;
  }
}
