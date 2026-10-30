// age encryption only; legacy files are read compatibly, never rewritten.
import { Encrypter, Decrypter } from "age-encryption";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  type KeyPairSigner,
} from "@solana/kit";
import { publicKey, SolanaError } from "./network.ts";
import {
  SignerLease,
  type LeaseOptions,
  type WalletRole,
} from "../signer/lease.ts";
import { leasedSigner } from "./leased-signer.ts";

export class EncryptedAccounts {
  #leases = new Map<string, SignerLease<KeyPairSigner>>();
  #addresses = new Map<string, KeyPairSigner["address"]>();
  constructor(
    readonly root = ".secrets/phase7c-solana",
    readonly options: LeaseOptions = {},
  ) {}
  private files(label: string) {
    if (!/^(relayer|recipient-[a-f0-9-]{36})$/.test(label))
      throw new SolanaError("INVALID_ACCOUNT_LABEL");
    return {
      cipher: join(this.root, `${label}.age`),
      public: join(this.root, `${label}.public.json`),
    };
  }
  private role(label: string): WalletRole {
    this.files(label);
    return label === "relayer" ? "relayer" : "user";
  }
  private lease(label: string) {
    let value = this.#leases.get(label);
    if (!value) {
      if (this.#leases.size >= 128) throw new SolanaError("ACCOUNT_CAPACITY");
      value = new SignerLease<KeyPairSigner>(this.role(label), this.options);
      this.#leases.set(label, value);
    }
    return value;
  }
  private metadata(label: string) {
    const saved = JSON.parse(readFileSync(this.files(label).public, "utf8"));
    if (
      saved.network !== "solana:devnet" ||
      saved.label !== label ||
      !["age-v1", "age-role-v2"].includes(saved.format) ||
      (saved.role !== undefined && saved.role !== this.role(label))
    )
      throw new SolanaError("ACCOUNT_MISMATCH");
    publicKey(saved.address);
    return saved;
  }
  private prefix(label: string) {
    return Buffer.from(`ZecOne/solana/role/v2:${this.role(label)}:${label}:`);
  }
  private seed(label: string, payload: Uint8Array, format?: string) {
    const prefix = this.prefix(label);
    if (payload.length === 32 && format !== "age-role-v2") return payload;
    if (
      format === "age-v1" ||
      payload.length !== prefix.length + 32 ||
      !Buffer.from(payload.subarray(0, prefix.length)).equals(prefix)
    )
      throw new SolanaError("ACCOUNT_MISMATCH");
    return payload.subarray(prefix.length);
  }
  protected async decryptPayload(cipher: Uint8Array, passphrase: string) {
    if (cipher.length > 2048 || passphrase.length > 1024)
      throw new SolanaError("UNLOCK_FAILED");
    const dec = new Decrypter();
    dec.addPassphrase(passphrase);
    return dec.decrypt(cipher);
  }
  async generate(label: string, passphrase: string) {
    if (passphrase.length < 20 || passphrase.length > 1024)
      throw new SolanaError("STRONG_PASSPHRASE_REQUIRED");
    const f = this.files(label);
    mkdirSync(this.root, { recursive: true });
    if (existsSync(f.cipher) || existsSync(f.public))
      throw new SolanaError("ACCOUNT_EXISTS");
    const seed = randomBytes(32),
      payload = Buffer.concat([this.prefix(label), seed]);
    try {
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed),
        enc = new Encrypter();
      enc.setPassphrase(passphrase);
      writeFileSync(f.cipher, await enc.encrypt(payload), {
        flag: "wx",
        mode: 0o600,
      });
      writeFileSync(
        f.public,
        JSON.stringify({
          address: signer.address,
          label,
          role: this.role(label),
          network: "solana:devnet",
          format: "age-role-v2",
        }),
        { flag: "wx", mode: 0o600 },
      );
      return signer.address;
    } finally {
      seed.fill(0);
      payload.fill(0);
    }
  }
  address(label: string) {
    return publicKey(this.metadata(label).address);
  }
  list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((f) =>
        /^(relayer|recipient-[a-f0-9-]{36})\.public\.json$/.test(f),
      )
      .map((f) => {
        const label = f.slice(0, -".public.json".length);
        return {
          label,
          role: this.role(label),
          address: this.address(label),
          network: "solana:devnet",
        };
      });
  }
  status(label: string) {
    return this.lease(label).status();
  }
  async unlock(
    label: string,
    passphrase: string,
    explicit: boolean,
    role: WalletRole = this.role(label),
  ) {
    if (role !== this.role(label))
      throw new SolanaError("SIGNER_ROLE_MISMATCH");
    let address: KeyPairSigner["address"] | undefined;
    await this.lease(label).unlock(async () => {
      let payload: Uint8Array | undefined;
      try {
        const meta = this.metadata(label);
        payload = await this.decryptPayload(
          readFileSync(this.files(label).cipher),
          passphrase,
        );
        const signer = await createKeyPairSignerFromPrivateKeyBytes(
          this.seed(label, payload, meta.format),
        );
        if (signer.address !== publicKey(meta.address))
          throw new SolanaError("ACCOUNT_MISMATCH");
        address = signer.address;
        this.#addresses.set(label, address);
        return signer;
      } finally {
        payload?.fill(0);
      }
    }, explicit);
    return address!;
  }
  signer(label: string, role: WalletRole = this.role(label)) {
    if (role !== this.role(label))
      throw new SolanaError("SIGNER_ROLE_MISMATCH");
    const address = this.#addresses.get(label);
    if (!address) throw new SolanaError("WALLET_LOCKED");
    return leasedSigner(this.lease(label), address, role);
  }
  lock(label?: string) {
    if (label !== undefined) {
      this.files(label);
      this.#leases.get(label)?.lock();
      this.#addresses.delete(label);
    } else {
      for (const lease of this.#leases.values()) lease.lock();
      this.#addresses.clear();
    }
  }
  async backup(
    label: string,
    unlockPassphrase: string,
    recoveryPassphrase: string,
    output: string,
  ) {
    if (recoveryPassphrase.length < 20 || recoveryPassphrase.length > 1024)
      throw new SolanaError("STRONG_PASSPHRASE_REQUIRED");
    let payload: Uint8Array | undefined;
    try {
      const meta = this.metadata(label);
      payload = await this.decryptPayload(
        readFileSync(this.files(label).cipher),
        unlockPassphrase,
      );
      const signer = await createKeyPairSignerFromPrivateKeyBytes(
        this.seed(label, payload, meta.format),
      );
      if (signer.address !== publicKey(meta.address))
        throw new SolanaError("ACCOUNT_MISMATCH");
      const enc = new Encrypter();
      enc.setPassphrase(recoveryPassphrase);
      writeFileSync(output, await enc.encrypt(payload), {
        flag: "wx",
        mode: 0o600,
      });
      return signer.address;
    } catch {
      throw new SolanaError("BACKUP_FAILED");
    } finally {
      payload?.fill(0);
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
    let payload: Uint8Array | undefined;
    try {
      payload = await this.decryptPayload(cipher, passphrase);
      const signer = await createKeyPairSignerFromPrivateKeyBytes(
        this.seed(label, payload),
      );
      if (signer.address !== publicKey(expectedAddress))
        throw new SolanaError("ACCOUNT_MISMATCH");
      mkdirSync(this.root, { recursive: true });
      writeFileSync(f.cipher, cipher, { flag: "wx", mode: 0o600 });
      writeFileSync(
        f.public,
        JSON.stringify({
          address: signer.address,
          label,
          role: this.role(label),
          network: "solana:devnet",
          format: payload.length === 32 ? "age-v1" : "age-role-v2",
        }),
        { flag: "wx", mode: 0o600 },
      );
      return signer.address;
    } catch {
      throw new SolanaError("RESTORE_FAILED");
    } finally {
      payload?.fill(0);
    }
  }
}
