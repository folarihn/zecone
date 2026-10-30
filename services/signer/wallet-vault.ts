// Opt-in encrypted persistence for NEW development credentials only. No HTTP
// imports, legacy source paths, DPAPI fallback or automatic signer activation.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { exclusiveJson } from "../execution/io.ts";
import { encrypt, decrypt } from "./keystore.ts";
import {
  SignerLease,
  LeaseError,
  type WalletRole,
  type LeaseOptions,
} from "./lease.ts";
export type WalletNetwork =
  | "solana-devnet"
  | "base-sepolia"
  | "ethereum-sepolia"
  | "robinhood-testnet"
  | "approval-testnet";
type PublicRecord = {
  id: string;
  role: WalletRole;
  network: WalletNetwork;
  address: string;
  format: "zecone-development-wallet-v1";
};
const roles = ["user", "relayer", "refund-approver"],
  networks = [
    "solana-devnet",
    "base-sepolia",
    "ethereum-sepolia",
    "robinhood-testnet",
    "approval-testnet",
  ];
export class WalletVault {
  #verifiers = new Map<string, SignerLease<Buffer>>();
  #busy = false;
  constructor(
    readonly root = ".secrets/phase8b-wallets",
    readonly options: LeaseOptions = {},
  ) {}
  private validate(role: WalletRole, network?: WalletNetwork) {
    if (
      !roles.includes(role) ||
      (network !== undefined &&
        (!networks.includes(network) ||
          (role === "refund-approver") !== (network === "approval-testnet")))
    )
      throw new LeaseError("UNSUPPORTED_WALLET_ROLE_OR_NETWORK");
  }
  private file(role: WalletRole, id: string) {
    this.validate(role);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        id,
      )
    )
      throw new LeaseError("INVALID_WALLET_ID");
    return join(this.root, role, `${id}.json`);
  }
  private purpose(r: PublicRecord) {
    return `development-wallet:${r.role}:${r.network}:${r.id}:${r.address}`;
  }
  private async address(seed: Buffer, network: WalletNetwork) {
    if (seed.length !== 32) throw new LeaseError("INVALID_CREDENTIAL");
    return network === "solana-devnet" || network === "approval-testnet"
      ? (await createKeyPairSignerFromPrivateKeyBytes(seed)).address
      : privateKeyToAccount(`0x${seed.toString("hex")}`).address;
  }
  public(role: WalletRole, id: string): PublicRecord {
    try {
      const r = JSON.parse(readFileSync(this.file(role, id), "utf8"));
      this.validate(r.role, r.network);
      if (
        r.id !== id ||
        r.role !== role ||
        r.format !== "zecone-development-wallet-v1" ||
        typeof r.address !== "string" ||
        !/^[A-Za-z0-9]{32,64}$/.test(r.address)
      )
        throw Error();
      return {
        id: r.id,
        role: r.role,
        network: r.network,
        address: r.address,
        format: r.format,
      };
    } catch {
      throw new LeaseError("WALLET_UNAVAILABLE");
    }
  }
  list(role: WalletRole) {
    this.validate(role);
    const dir = join(this.root, role);
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
          .map((f) => this.public(role, f.slice(0, -5)))
      : [];
  }
  async create(
    role: WalletRole,
    network: WalletNetwork,
    password: Buffer,
    explicit: boolean,
  ) {
    const seed = randomBytes(32);
    try {
      return await this.import(role, network, seed, password, explicit);
    } finally {
      seed.fill(0);
    }
  }
  async import(
    role: WalletRole,
    network: WalletNetwork,
    input: Buffer,
    password: Buffer,
    explicit: boolean,
  ) {
    if (explicit !== true) throw new LeaseError("APPROVAL_REQUIRED");
    this.validate(role, network);
    if (this.#busy) throw new LeaseError("VAULT_BUSY");
    this.#busy = true;
    const seed = Buffer.from(input),
      pass = Buffer.from(password);
    try {
      const record: PublicRecord = {
        id: randomUUID(),
        role,
        network,
        address: await this.address(seed, network),
        format: "zecone-development-wallet-v1",
      };
      const sealed = await encrypt(seed, pass, this.purpose(record));
      exclusiveJson(this.file(role, record.id), { ...record, sealed });
      return record;
    } catch (e) {
      if (e instanceof LeaseError) throw e;
      throw new LeaseError("CREDENTIAL_CREATION_FAILED");
    } finally {
      seed.fill(0);
      pass.fill(0);
      this.#busy = false;
    }
  }
  // Password verification is not unlock/signing. The temporary secret is wiped
  // immediately; no EVM/native/refund signing adapter is activated by this vault.
  async verify(
    role: WalletRole,
    id: string,
    password: Buffer,
    explicit: boolean,
  ) {
    const record = this.public(role, id),
      key = `${role}:${id}`;
    let lease = this.#verifiers.get(key);
    if (!lease) {
      if (this.#verifiers.size >= 128) throw new LeaseError("WALLET_CAPACITY");
      lease = new SignerLease<Buffer>(role, this.options, (b) => b.fill(0));
      this.#verifiers.set(key, lease);
    }
    if (this.#busy) throw new LeaseError("VAULT_BUSY");
    this.#busy = true;
    const pass = Buffer.from(password);
    try {
      await lease.unlock(async () => {
        const r = JSON.parse(readFileSync(this.file(role, id), "utf8"));
        let seed: Buffer | undefined;
        try {
          seed = await decrypt(r.sealed, pass, this.purpose(record));
          if ((await this.address(seed, record.network)) !== record.address)
            throw Error();
          return seed;
        } catch {
          seed?.fill(0);
          throw new LeaseError("UNLOCK_FAILED");
        }
      }, explicit);
      return {
        verified: true,
        signingActivated: false,
        role: record.role,
        network: record.network,
        address: record.address,
      };
    } finally {
      lease.lock();
      pass.fill(0);
      this.#busy = false;
    }
  }
}
