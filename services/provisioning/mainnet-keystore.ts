// Offline mainnet credential sealing. This module generates and stores keys for
// operator handoff only. It has no signer, broadcast, HTTP or settlement import.
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { exclusiveJson } from "../execution/io.ts";

const header = {
  version: 1,
  format: "zecone-mainnet-provisioning-keystore",
  kdf: "scrypt",
  N: 262144,
  r: 8,
  p: 1,
  cipher: "aes-256-gcm",
} as const;
type Envelope = typeof header & {
  purpose: string;
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};
export type MainnetCredentialPurpose =
  | "mainnet:base:recipient"
  | "mainnet:base:relayer"
  | "mainnet:solana:recipient"
  | "mainnet:solana:relayer"
  | "mainnet:zcash:receiver";
const purposes = new Set<MainnetCredentialPurpose>([
  "mainnet:base:recipient",
  "mainnet:base:relayer",
  "mainnet:solana:recipient",
  "mainnet:solana:relayer",
  "mainnet:zcash:receiver",
]);
const aad = (purpose: string) =>
  Buffer.from(JSON.stringify({ ...header, purpose }));
const purpose = (value: string): MainnetCredentialPurpose => {
  if (!purposes.has(value as MainnetCredentialPurpose))
    throw Error("INVALID_MAINNET_CREDENTIAL_PURPOSE");
  return value as MainnetCredentialPurpose;
};
async function derive(password: Buffer, salt: Buffer) {
  if (password.length < 24 || password.length > 1024)
    throw Error("mainnet_passphrase_must_be_at_least_24_bytes");
  return new Promise<Buffer>((yes, no) =>
    scrypt(
      password,
      salt,
      32,
      { N: header.N, r: header.r, p: header.p, maxmem: 512 * 1024 * 1024 },
      (e, k) => (e ? no(Error("mainnet_keystore_kdf_failed")) : yes(k)),
    ),
  );
}

export async function sealMainnetCredential(
  secret: Buffer,
  passphrase: Buffer,
  name: MainnetCredentialPurpose,
): Promise<Envelope> {
  purpose(name);
  if (secret.length !== 32) throw Error("mainnet_credential_must_be_32_bytes");
  const salt = randomBytes(32),
    nonce = randomBytes(12),
    key = await derive(passphrase, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(aad(name));
    return {
      ...header,
      purpose: name,
      salt: salt.toString("hex"),
      nonce: nonce.toString("hex"),
      ciphertext: Buffer.concat([
        cipher.update(secret),
        cipher.final(),
      ]).toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
    };
  } finally {
    key.fill(0);
  }
}

export async function openMainnetCredential(
  value: unknown,
  passphrase: Buffer,
  name: MainnetCredentialPurpose,
): Promise<Buffer> {
  purpose(name);
  const e = value as Envelope;
  if (
    !e ||
    Object.keys(e).sort().join(",") !==
      [...Object.keys(header), "purpose", "salt", "nonce", "ciphertext", "tag"]
        .sort()
        .join(",") ||
    e.version !== 1 ||
    e.format !== header.format ||
    e.kdf !== header.kdf ||
    e.N !== header.N ||
    e.r !== header.r ||
    e.p !== header.p ||
    e.cipher !== header.cipher ||
    e.purpose !== name ||
    !/^[a-f0-9]{64}$/.test(e.salt) ||
    !/^[a-f0-9]{24}$/.test(e.nonce) ||
    !/^[a-f0-9]{64}$/.test(e.ciphertext) ||
    !/^[a-f0-9]{32}$/.test(e.tag)
  )
    throw Error("INVALID_MAINNET_KEYSTORE");
  const key = await derive(passphrase, Buffer.from(e.salt, "hex"));
  let partial: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(e.nonce, "hex"),
        { authTagLength: 16 },
      ),
      tag = Buffer.from(e.tag, "hex");
    decipher.setAAD(aad(name));
    decipher.setAuthTag(tag);
    partial = decipher.update(Buffer.from(e.ciphertext, "hex"));
    const tail = decipher.final();
    const secret = Buffer.concat([partial, tail]);
    tail.fill(0);
    if (secret.length !== 32) throw Error("INVALID_MAINNET_KEYSTORE");
    return secret;
  } catch {
    throw Error("MAINNET_KEYSTORE_AUTHENTICATION_FAILED");
  } finally {
    key.fill(0);
    partial?.fill(0);
  }
}

export function writeMainnetKeystore(path: string, envelope: Envelope): void {
  exclusiveJson(path, envelope);
}

export function readMainnetKeystore(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function generateBaseMainnetKey() {
  const pair = generateKeyPairSync("ec", { namedCurve: "secp256k1" }),
    jwk = pair.privateKey.export({ format: "jwk" }) as JsonWebKey;
  if (!jwk.d) throw Error("BASE_KEY_GENERATION_FAILED");
  const secret = Buffer.from(jwk.d, "base64url");
  if (secret.length !== 32) throw Error("BASE_KEY_GENERATION_FAILED");
  const account = privateKeyToAccount(`0x${secret.toString("hex")}`),
    publicKey = String(pair.publicKey.export({ format: "pem", type: "spki" }));
  return {
    secret,
    address: account.address,
    publicKey,
    verifyPublicKey: createPublicKey(publicKey).asymmetricKeyType === "ec",
  };
}

export async function generateSolanaMainnetKey() {
  const pair = generateKeyPairSync("ed25519"),
    jwk = pair.privateKey.export({ format: "jwk" }) as JsonWebKey;
  if (!jwk.d) throw Error("SOLANA_KEY_GENERATION_FAILED");
  const secret = Buffer.from(jwk.d, "base64url");
  if (secret.length !== 32) throw Error("SOLANA_KEY_GENERATION_FAILED");
  const signer = await createKeyPairSignerFromPrivateKeyBytes(
      new Uint8Array(secret),
    ),
    publicKey = String(pair.publicKey.export({ format: "pem", type: "spki" }));
  return {
    secret,
    address: signer.address,
    publicKey,
    verifyPublicKey: createPublicKey(publicKey).asymmetricKeyType === "ed25519",
  };
}

export function assertDistinctMainnetCredentials(
  values: { purpose: MainnetCredentialPurpose; address: string }[],
) {
  if (
    new Set(values.map((v) => v.address)).size !== values.length ||
    new Set(values.map((v) => v.purpose)).size !== values.length
  )
    throw Error("MAINNET_CREDENTIALS_MUST_BE_DISTINCT");
}

export function constantTimeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}
