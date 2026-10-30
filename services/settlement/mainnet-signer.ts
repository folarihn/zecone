// Isolated mainnet signing boundary. This module is never imported by the
// browser wallet or the generic settlement workers. It opens one purpose-bound
// disposable keystore on explicit operator request, requires an exact prepared
// digest approval, signs only the prepared Base/Solana transfer, and records a
// conservative daily spend count. It has no network, journal or broadcast path.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializedLegacy,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  signTransaction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  openMainnetCredential,
  readMainnetKeystore,
  type MainnetCredentialPurpose,
} from "../provisioning/mainnet-keystore.ts";
import {
  assertSignerMatchesRelayer,
  destinationNetwork,
} from "./mainnet-address.ts";
import {
  assertPreparedMainnetTransfer,
  preparedDigest,
  termsDigest,
  type MainnetPrepared,
  type MainnetSignedBundle,
  type MainnetTransferTerms,
} from "./mainnet-transfer.ts";
import {
  validateProductionProfile,
  type ProductionProfile,
} from "./production-safety.ts";

const integer = (value: unknown) => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,30}$/.test(value))
    throw Error("INVALID_SIGNER_LIMIT");
  return BigInt(value);
};

export type MainnetSignerLimits = {
  perTransaction: string;
  daily: string;
};

export type MainnetSigningApproval = {
  version: 1;
  termsDigest: string;
  preparedDigest: string;
  maximumDestinationDebit: string;
  expires: number;
};

export type OpenMainnetSigner = {
  profile: ProductionProfile;
  keystorePath: string;
  passphrasePath: string;
  limits: MainnetSignerLimits;
  ledgerPath: string;
  now?: () => number;
};

export class MainnetOfflineSigner {
  private closed = false;
  private readonly ledger: DatabaseSync;
  private readonly now: () => number;
  private readonly network: "base" | "solana";
  private readonly purpose: MainnetCredentialPurpose;
  readonly address: string;

  private constructor(
    private readonly profile: ProductionProfile,
    private readonly secret: Buffer,
    private readonly base: PrivateKeyAccount | null,
    private readonly solana: KeyPairSigner | null,
    private readonly pin: MainnetSignerLimits,
    ledgerPath: string,
    now: () => number,
  ) {
    this.network = destinationNetwork(profile.network);
    this.purpose = `mainnet:${this.network}:relayer`;
    this.address = base?.address ?? solana!.address;
    this.now = now;
    if (ledgerPath !== ":memory:")
      mkdirSync(dirname(ledgerPath), { recursive: true });
    this.ledger = new DatabaseSync(ledgerPath);
    this.ledger.exec("PRAGMA busy_timeout=5000");
    const tables = this.ledger
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    if (
      tables.length > 0 &&
      !tables.some(({ name }) => name === "mainnet_signer_prints")
    ) {
      this.secret.fill(0);
      this.ledger.close();
      throw Error("INVALID_SIGNER_LEDGER");
    }
    this.ledger
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mainnet_signer_prints(
        prepared_digest TEXT PRIMARY KEY,
        terms_digest TEXT NOT NULL,
        maximum_debit TEXT NOT NULL,
        day INTEGER NOT NULL,
        state TEXT NOT NULL,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mainnet_signer_control(
        id INTEGER PRIMARY KEY CHECK(id=1),
        revoked INTEGER NOT NULL,
        reason TEXT,
        changed INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO mainnet_signer_control(id,revoked,reason,changed)
        VALUES(1,0,NULL,0);`);
  }

  get revoked() {
    return (
      (
        this.ledger
          .prepare("SELECT revoked FROM mainnet_signer_control WHERE id=1")
          .get() as { revoked: number }
      ).revoked === 1
    );
  }

  static async open(options: OpenMainnetSigner) {
    if (!options.ledgerPath || options.ledgerPath === ":memory:")
      throw Error("DURABLE_SIGNER_LEDGER_REQUIRED");
    const profile = validateProductionProfile(options.profile),
      network = destinationNetwork(profile.network),
      purpose = `mainnet:${network}:relayer` as MainnetCredentialPurpose,
      per = integer(options.limits.perTransaction),
      day = integer(options.limits.daily);
    if (day < per) throw Error("INVALID_SIGNER_LIMIT");
    if (!profile.relayer || !profile.signer)
      throw Error("SEPARATE_DEVICE_SIGNER_REQUIRED");
    assertSignerMatchesRelayer(
      network,
      profile.signer.publicKey,
      profile.relayer,
    );
    let passphrase: Buffer;
    try {
      passphrase = readFileSync(options.passphrasePath);
    } catch {
      throw Error("SIGNER_PASSPHRASE_UNAVAILABLE");
    }
    let secret: Buffer | undefined;
    try {
      if (passphrase.length < 24 || passphrase.length > 1024)
        throw Error("INVALID_SIGNER_PASSPHRASE");
      secret = await openMainnetCredential(
        readMainnetKeystore(options.keystorePath),
        passphrase,
        purpose,
      );
      if (secret.length !== 32) throw Error("INVALID_MAINNET_KEYSTORE");
      const hex = `0x${secret.toString("hex")}` as const;
      let base: PrivateKeyAccount | null = null,
        solana: KeyPairSigner | null = null,
        address: string;
      if (network === "base") {
        base = privateKeyToAccount(hex);
        address = base.address;
      } else {
        solana = await createKeyPairSignerFromPrivateKeyBytes(
          new Uint8Array(secret),
        );
        address = solana.address;
      }
      if (
        getAddressOrSelf(network, address) !==
        getAddressOrSelf(network, profile.relayer)
      )
        throw Error("SIGNER_RELAYER_MISMATCH");
      const signer = new MainnetOfflineSigner(
        profile,
        secret,
        base,
        solana,
        { perTransaction: per.toString(), daily: day.toString() },
        options.ledgerPath,
        options.now ?? (() => Math.floor(Date.now() / 1000)),
      );
      if (signer.revoked) {
        signer.close();
        throw Error("SIGNER_REVOKED");
      }
      return signer;
    } catch (error) {
      secret?.fill(0);
      throw error;
    } finally {
      passphrase.fill(0);
    }
  }

  sign(
    terms: MainnetTransferTerms,
    prepared: MainnetPrepared,
    approval: MainnetSigningApproval,
  ): Promise<MainnetSignedBundle> {
    return this.signLocked(terms, prepared, approval);
  }

  private async signLocked(
    terms: MainnetTransferTerms,
    prepared: MainnetPrepared,
    approval: MainnetSigningApproval,
  ): Promise<MainnetSignedBundle> {
    if (this.closed) throw Error("SIGNER_CLOSED");
    if (this.revoked) throw Error("SIGNER_REVOKED");
    const now = this.now(),
      expectedTerms = termsDigest(terms),
      expectedPrepared = preparedDigest(prepared);
    if (
      approval.version !== 1 ||
      approval.termsDigest !== expectedTerms ||
      approval.preparedDigest !== expectedPrepared ||
      approval.maximumDestinationDebit !== terms.maximumDestinationDebit ||
      !Number.isSafeInteger(approval.expires) ||
      approval.expires <= now ||
      approval.expires > now + 900 ||
      approval.expires > terms.expires ||
      terms.expires <= now ||
      terms.network !== this.network ||
      prepared.termsDigest !== expectedTerms ||
      prepared.maximumDestinationDebit !== terms.maximumDestinationDebit
    )
      throw Error("EXACT_SIGNER_APPROVAL_REQUIRED");
    assertPreparedMainnetTransfer(terms, prepared);
    if (BigInt(terms.maximumDestinationDebit) > BigInt(this.pin.perTransaction))
      throw Error("SIGNER_PER_TRANSACTION_LIMIT");
    this.reserve(
      expectedPrepared,
      expectedTerms,
      terms.maximumDestinationDebit,
    );
    let bundle: MainnetSignedBundle;
    try {
      if (this.network === "base") {
        if (!this.base || prepared.kind !== "base-unsigned")
          throw Error("SIGNER_NETWORK_MISMATCH");
        if (
          prepared.tx.chainId !== 8453 ||
          getAddress(prepared.tx.to) !== getAddress(terms.recipient) ||
          BigInt(prepared.tx.value) !== BigInt(terms.amount) ||
          prepared.tx.data.toLowerCase() !== "0x"
        )
          throw Error("PREPARED_TRANSFER_POLICY_MISMATCH");
        const raw = await this.base.signTransaction({
            type: "legacy",
            chainId: 8453,
            to: getAddress(prepared.tx.to),
            value: BigInt(prepared.tx.value),
            data: "0x",
            nonce: prepared.tx.nonce,
            gas: BigInt(prepared.tx.gas),
            gasPrice: BigInt(prepared.tx.gasPrice),
          }),
          parsed = parseTransaction(raw);
        if (
          parsed.type !== "legacy" ||
          parsed.chainId !== 8453 ||
          !parsed.to ||
          getAddress(parsed.to) !== getAddress(terms.recipient) ||
          parsed.value !== BigInt(terms.amount) ||
          parsed.nonce !== prepared.tx.nonce ||
          parsed.gas !== BigInt(prepared.tx.gas) ||
          parsed.gasPrice !== BigInt(prepared.tx.gasPrice) ||
          (parsed.data ?? "0x").toLowerCase() !== "0x"
        )
          throw Error("SIGNED_TRANSACTION_POLICY_MISMATCH");
        const recovered = await recoverTransactionAddress({
          serializedTransaction: raw as TransactionSerializedLegacy,
        });
        if (getAddress(recovered) !== getAddress(this.address))
          throw Error("SIGNED_TRANSACTION_SIGNER_MISMATCH");
        bundle = {
          version: 1,
          network: "base",
          termsDigest: expectedTerms,
          preparedDigest: expectedPrepared,
          signed: raw,
        };
      } else {
        if (!this.solana || prepared.kind !== "solana-unsigned")
          throw Error("SIGNER_NETWORK_MISMATCH");
        const tx = getTransactionDecoder().decode(
          Buffer.from(prepared.unsignedWire, "base64"),
        );
        const signed = await signTransaction(
          [this.solana.keyPair],
          tx as never,
        );
        bundle = {
          version: 1,
          network: "solana",
          termsDigest: expectedTerms,
          preparedDigest: expectedPrepared,
          signed: getBase64EncodedWireTransaction(signed as never),
        };
      }
      this.markSigned(expectedPrepared);
      return bundle;
    } catch (error) {
      this.abandon(expectedPrepared);
      throw error;
    }
  }

  private atomic<T>(fn: () => T): T {
    this.ledger.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.ledger.exec("COMMIT");
      return value;
    } catch (error) {
      this.ledger.exec("ROLLBACK");
      throw error;
    }
  }

  private reserve(prepared: string, terms: string, maximumDebit: string): void {
    const now = this.now(),
      day = Math.floor(now / 86400);
    this.atomic(() => {
      const old = this.ledger
        .prepare("SELECT * FROM mainnet_signer_prints WHERE prepared_digest=?")
        .get(prepared) as
        | {
            terms_digest: string;
            maximum_debit: string;
            day: number;
            state: string;
            created: number;
          }
        | undefined;
      if (old) {
        if (
          old.terms_digest !== terms ||
          old.maximum_debit !== maximumDebit ||
          old.day !== day
        )
          throw Error("SIGNER_REPLAY_CONFLICT");
        if (old.state === "SIGNED") return;
        if (now - old.created < 60) throw Error("SIGNER_APPROVAL_IN_PROGRESS");
        this.ledger
          .prepare(
            "UPDATE mainnet_signer_prints SET state='SIGNING',created=?,updated=? WHERE prepared_digest=?",
          )
          .run(now, now, prepared);
        return;
      }
      const spent = this.ledger
        .prepare("SELECT maximum_debit FROM mainnet_signer_prints WHERE day=?")
        .all(day) as { maximum_debit: string }[];
      const total =
        spent.reduce((n, row) => n + BigInt(row.maximum_debit), 0n) +
        BigInt(maximumDebit);
      if (total > BigInt(this.pin.daily)) throw Error("SIGNER_DAILY_LIMIT");
      this.ledger
        .prepare(
          "INSERT INTO mainnet_signer_prints(prepared_digest,terms_digest,maximum_debit,day,state,created,updated) VALUES(?,?,?,?, 'SIGNING',?,?)",
        )
        .run(prepared, terms, maximumDebit, day, now, now);
    });
  }

  private markSigned(prepared: string) {
    this.ledger
      .prepare(
        "UPDATE mainnet_signer_prints SET state='SIGNED',updated=? WHERE prepared_digest=?",
      )
      .run(this.now(), prepared);
  }

  private abandon(prepared: string) {
    this.ledger
      .prepare(
        "DELETE FROM mainnet_signer_prints WHERE prepared_digest=? AND state='SIGNING'",
      )
      .run(prepared);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.secret.fill(0);
    this.ledger.close();
  }
}

export function revokeMainnetSigner(
  ledgerPath: string,
  reason: string,
  now = Math.floor(Date.now() / 1000),
) {
  if (!reason.trim() || reason.length > 256)
    throw Error("SIGNER_REVOCATION_REASON_REQUIRED");
  if (ledgerPath === ":memory:") throw Error("DURABLE_SIGNER_LEDGER_REQUIRED");
  if (!existsSync(ledgerPath)) throw Error("SIGNER_LEDGER_NOT_FOUND");
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const db = new DatabaseSync(ledgerPath);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (
      !db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='mainnet_signer_prints'",
        )
        .get()
    )
      throw Error("INVALID_SIGNER_LEDGER");
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mainnet_signer_prints(
        prepared_digest TEXT PRIMARY KEY,
        terms_digest TEXT NOT NULL,
        maximum_debit TEXT NOT NULL,
        day INTEGER NOT NULL,
        state TEXT NOT NULL,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mainnet_signer_control(
        id INTEGER PRIMARY KEY CHECK(id=1),
        revoked INTEGER NOT NULL,
        reason TEXT,
        changed INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO mainnet_signer_control(id,revoked,reason,changed)
        VALUES(1,0,NULL,0);`);
    db.prepare(
      "UPDATE mainnet_signer_control SET revoked=1,reason=?,changed=? WHERE id=1",
    ).run(reason.trim(), now);
  } finally {
    db.close();
  }
}

function getAddressOrSelf(network: "base" | "solana", value: string) {
  return network === "base" ? getAddress(value) : value;
}
