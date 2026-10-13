// Signer-side only. No HTTP route imports this module. Uses Node/OpenSSL primitives,
// not a new cipher. This versioned envelope is not Ethereum Web3 Secret Storage.
import {
  randomBytes,
  scrypt,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
  createPrivateKey,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exclusiveJson } from "../execution/io.ts";

const header = {
  version: 1,
  format: "zecone-local-testnet-keystore",
  kdf: "scrypt",
  N: 131072,
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
const aad = (purpose: string) =>
  Buffer.from(JSON.stringify({ ...header, purpose }));
const validPurpose = (v: string) => {
  if (!/^(operator-approval|signer-approval|isolated-wallet-test)$/.test(v))
    throw Error("keystore_purpose");
};
async function derive(password: Buffer, salt: Buffer): Promise<Buffer> {
  if (password.length < 16 || password.length > 1024)
    throw Error("passphrase_must_be_16_to_1024_bytes");
  return new Promise((yes, no) =>
    scrypt(
      password,
      salt,
      32,
      { N: header.N, r: header.r, p: header.p, maxmem: 256 * 1024 * 1024 },
      (e, k) => (e ? no(Error("keystore_kdf_failed")) : yes(k)),
    ),
  );
}
export async function encrypt(
  secret: Buffer,
  password: Buffer,
  purpose: string,
): Promise<Envelope> {
  validPurpose(purpose);
  if (secret.length < 16 || secret.length > 65536)
    throw Error("keystore_payload_size");
  const salt = randomBytes(32),
    nonce = randomBytes(12),
    key = await derive(password, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(aad(purpose));
    return {
      ...header,
      purpose,
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
export async function decrypt(
  value: unknown,
  password: Buffer,
  purpose: string,
): Promise<Buffer> {
  validPurpose(purpose);
  let key: Buffer | undefined, first: Buffer | undefined;
  try {
    const e = value as Envelope;
    if (
      !e ||
      Object.keys(e).sort().join(",") !==
        [
          ...Object.keys(header),
          "purpose",
          "salt",
          "nonce",
          "ciphertext",
          "tag",
        ]
          .sort()
          .join(",") ||
      e.purpose !== purpose
    )
      throw Error();
    for (const k of Object.keys(header) as (keyof typeof header)[])
      if (e[k] !== header[k]) throw Error();
    if (
      !/^[a-f0-9]{64}$/.test(e.salt) ||
      !/^[a-f0-9]{24}$/.test(e.nonce) ||
      !/^[a-f0-9]{32}$/.test(e.tag) ||
      typeof e.ciphertext !== "string" ||
      e.ciphertext.length > 131072 ||
      e.ciphertext.length < 32 ||
      e.ciphertext.length % 2 ||
      !/^[a-f0-9]+$/.test(e.ciphertext)
    )
      throw Error();
    key = await derive(password, Buffer.from(e.salt, "hex"));
    const d = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(e.nonce, "hex"),
      { authTagLength: 16 },
    );
    d.setAAD(aad(purpose));
    d.setAuthTag(Buffer.from(e.tag, "hex"));
    first = d.update(Buffer.from(e.ciphertext, "hex"));
    const last = d.final();
    const result = Buffer.concat([first, last]);
    last.fill(0);
    return result;
  } catch {
    throw Error("keystore_unlock_failed");
  } finally {
    key?.fill(0);
    first?.fill(0);
  }
}
export async function writeVerifiedKeystore(
  path: string,
  secret: Buffer,
  password: Buffer,
  purpose: string,
) {
  const encrypted = await encrypt(secret, password, purpose);
  exclusiveJson(path, encrypted);
  const restored = await decrypt(
    JSON.parse(readFileSync(path, "utf8")),
    password,
    purpose,
  );
  try {
    if (restored.length !== secret.length || !timingSafeEqual(restored, secret))
      throw Error("keystore_verification_failed");
  } finally {
    restored.fill(0);
  }
  // Activation is deliberately separate. A crash leaves either no destination or
  // an unactivated encrypted file, never a deleted/replaced source credential.
  return { path: resolve(path), verified: true, activated: false };
}
export async function stageEncryptedCopy(
  source: string,
  destination: string,
  password: Buffer,
  purpose: string,
  explicit: boolean,
) {
  if (explicit !== true || resolve(source) === resolve(destination))
    throw Error("explicit_new_destination_required");
  const secret = readFileSync(source);
  try {
    return await writeVerifiedKeystore(destination, secret, password, purpose);
  } finally {
    secret.fill(0);
  }
}
export class ApprovalVault {
  #secret: Buffer | undefined;
  #expiry = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  constructor(
    readonly role: "operator" | "signer",
    readonly clock = () => Date.now(),
  ) {}
  lock() {
    this.#generation++;
    this.#secret?.fill(0);
    this.#secret = undefined;
    this.#expiry = 0;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  get unlocked() {
    if (this.clock() >= this.#expiry) this.lock();
    return !!this.#secret;
  }
  async unlock(
    envelope: unknown,
    password: Buffer,
    localConsent: boolean,
    ttlMs = 60000,
  ) {
    this.lock();
    if (
      localConsent !== true ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 300000
    )
      throw Error("local_unlock_consent_required");
    const generation = this.#generation,
      secret = await decrypt(envelope, password, `${this.role}-approval`);
    try {
      const k = createPrivateKey({ key: secret, format: "der", type: "pkcs8" });
      if (k.asymmetricKeyType !== "ed25519") throw Error("approval_key_type");
      if (generation !== this.#generation) throw Error("unlock_cancelled");
      this.#secret = secret;
      this.#expiry = this.clock() + ttlMs;
      this.#timer = setTimeout(() => this.lock(), ttlMs);
      this.#timer.unref();
    } catch (e) {
      secret.fill(0);
      throw e;
    }
  }
  withKey<T>(operation: (key: KeyObject) => T): T {
    if (!this.unlocked) throw Error("signer_locked");
    // Only trusted signer code receives a KeyObject. Never expose it in an API.
    return operation(
      createPrivateKey({ key: this.#secret!, format: "der", type: "pkcs8" }),
    );
  }
}
