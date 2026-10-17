// Standard age file format; no new cryptographic envelope or historical migration.
import { Encrypter, Decrypter } from "age-encryption";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  type KeyPairSigner,
} from "@solana/kit";
import { publicKey, SolanaError } from "./network.ts";

export class EncryptedAccounts {
  private unlocked = new Map<string, KeyPairSigner>();
  constructor(readonly root = ".secrets/phase7c-solana") {}
  private files(label: string) {
    if (!/^(relayer|recipient-[a-f0-9-]{36})$/.test(label))
      throw new SolanaError("INVALID_ACCOUNT_LABEL");
    return {
      cipher: join(this.root, `${label}.age`),
      public: join(this.root, `${label}.public.json`),
    };
  }
  async generate(label: string, passphrase: string) {
    if (passphrase.length < 20 || passphrase.length > 1024)
      throw new SolanaError("STRONG_PASSPHRASE_REQUIRED");
    const f = this.files(label);
    mkdirSync(this.root, { recursive: true });
    if (existsSync(f.cipher) || existsSync(f.public))
      throw new SolanaError("ACCOUNT_EXISTS");
    const seed = randomBytes(32);
    try {
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      const enc = new Encrypter();
      enc.setPassphrase(passphrase); // age default scrypt logN=18; authenticated ChaCha20-Poly1305 payload.
      const cipher = await enc.encrypt(seed);
      // Cipher first: interruption never causes overwriting an identity.
      writeFileSync(f.cipher, cipher, { flag: "wx", mode: 0o600 });
      writeFileSync(
        f.public,
        JSON.stringify({
          address: signer.address,
          label,
          network: "solana:devnet",
          format: "age-v1",
        }),
        { flag: "wx", mode: 0o600 },
      );
      return signer.address;
    } finally {
      seed.fill(0);
    }
  }
  address(label: string) {
    const saved = JSON.parse(readFileSync(this.files(label).public, "utf8"));
    if (
      saved.network !== "solana:devnet" ||
      saved.label !== label ||
      saved.format !== "age-v1"
    )
      throw new SolanaError("ACCOUNT_MISMATCH");
    return publicKey(saved.address);
  }
  async unlock(label: string, passphrase: string, explicit: boolean) {
    if (!explicit) throw new SolanaError("APPROVAL_REQUIRED");
    let seed: Uint8Array | undefined;
    try {
      const file = readFileSync(this.files(label).cipher);
      if (file.length > 2048)
        throw new SolanaError("INVALID_ENCRYPTED_ACCOUNT");
      const dec = new Decrypter();
      dec.addPassphrase(passphrase);
      seed = await dec.decrypt(file);
      if (seed.length !== 32)
        throw new SolanaError("INVALID_ENCRYPTED_ACCOUNT");
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      if (signer.address !== this.address(label))
        throw new SolanaError("ACCOUNT_MISMATCH");
      this.unlocked.set(label, signer);
      return signer.address;
    } catch {
      throw new SolanaError("UNLOCK_FAILED");
    } finally {
      seed?.fill(0);
    }
  }
  signer(label: string) {
    const signer = this.unlocked.get(label);
    if (!signer) throw new SolanaError("WALLET_LOCKED");
    return signer;
  }
  lock() {
    this.unlocked.clear();
  }
  async backup(
    label: string,
    unlockPassphrase: string,
    recoveryPassphrase: string,
    output: string,
  ) {
    if (recoveryPassphrase.length < 20 || recoveryPassphrase.length > 1024)
      throw new SolanaError("STRONG_PASSPHRASE_REQUIRED");
    const dec = new Decrypter();
    dec.addPassphrase(unlockPassphrase);
    let seed: Uint8Array | undefined;
    try {
      seed = await dec.decrypt(readFileSync(this.files(label).cipher));
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      if (signer.address !== this.address(label))
        throw new SolanaError("ACCOUNT_MISMATCH");
      const enc = new Encrypter();
      enc.setPassphrase(recoveryPassphrase);
      writeFileSync(output, await enc.encrypt(seed), {
        flag: "wx",
        mode: 0o600,
      });
      return signer.address;
    } catch {
      throw new SolanaError("BACKUP_FAILED");
    } finally {
      seed?.fill(0);
    }
  }
  async restore(
    label: string,
    cipherFile: string,
    passphrase: string,
    expectedAddress: string,
  ) {
    const f = this.files(label);
    if (existsSync(f.cipher) || existsSync(f.public))
      throw new SolanaError("ACCOUNT_EXISTS");
    const cipher = readFileSync(cipherFile);
    if (cipher.length > 2048)
      throw new SolanaError("INVALID_ENCRYPTED_ACCOUNT");
    const dec = new Decrypter();
    dec.addPassphrase(passphrase);
    let seed: Uint8Array | undefined;
    try {
      seed = await dec.decrypt(cipher);
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      if (signer.address !== publicKey(expectedAddress))
        throw new SolanaError("ACCOUNT_MISMATCH");
      mkdirSync(this.root, { recursive: true });
      writeFileSync(f.cipher, cipher, { flag: "wx", mode: 0o600 });
      writeFileSync(
        f.public,
        JSON.stringify({
          address: signer.address,
          label,
          network: "solana:devnet",
          format: "age-v1",
        }),
        { flag: "wx", mode: 0o600 },
      );
      return signer.address;
    } finally {
      seed?.fill(0);
    }
  }
}
