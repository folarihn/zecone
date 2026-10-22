import { Decrypter, Encrypter } from "age-encryption";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const FORMAT = "zecone-mainnet-watch-backup" as const;
const NETWORK = "zcash-mainnet" as const;
const ALLOWED_FILES = [
  "watch-only.json",
  "viewing-key.txt",
  "wallet.sqlite",
  "wallet.sqlite-wal",
  "wallet.sqlite-shm",
] as const;
const REQUIRED_FILES = ["watch-only.json", "viewing-key.txt", "wallet.sqlite"];
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const UNIFIED = /^u1[0-9a-z]{20,220}$/;
const VIEWING_KEY = /^uview1[0-9a-z]{20,4095}$/;
const SQLITE_HEADER = Buffer.from("SQLite format 3\u0000", "binary");

export type WatchMetadata = {
  network: typeof NETWORK;
  watchOnly: true;
  account: string;
  address: string;
  birthday: number;
};

type WatchManifest = {
  version: 1;
  network: typeof NETWORK;
  keyId: string;
  birthday: number;
  address: string;
};

type ArchiveFile = {
  name: (typeof ALLOWED_FILES)[number];
  sha256: string;
  data: string;
};

export type WatchBackupArchive = {
  format: typeof FORMAT;
  version: 1;
  createdAt: string;
  network: typeof NETWORK;
  account: string;
  address: string;
  birthday: number;
  files: ArchiveFile[];
};

const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const lower = (value: string) => value.toLowerCase();
const hasHistoricalComponent = (path: string) =>
  resolve(path)
    .split(/[\\/]+/)
    .some((part) => {
      const value = part.toLowerCase();
      return value === ".secrets" || value === ".state";
    });
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = () => {
  for (const start of [moduleRoot, resolve(".")]) {
    let current = start;
    for (;;) {
      if (existsSync(resolve(current, ".git"))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
};
const inside = (path: string, root: string) => {
  const p = lower(resolve(path)),
    r = lower(resolve(root));
  return p === r || p.startsWith(r + sep);
};
const rejectHistoricalAndRepositoryPath = (path: string) => {
  if (hasHistoricalComponent(path))
    throw Error("HISTORICAL_WALLET_PATH_FORBIDDEN");
  const root = repositoryRoot();
  if (root && inside(path, root)) throw Error("WATCH_PATH_INSIDE_REPOSITORY");
};
const rejectRealHistoricalAndRepositoryPath = (path: string) => {
  rejectHistoricalAndRepositoryPath(path);
  if (!existsSync(path)) return;
  rejectHistoricalAndRepositoryPath(realpathSync(path));
};

export function assertExternalPath(path: string) {
  const absolute = resolve(path);
  rejectHistoricalAndRepositoryPath(absolute);
  if (existsSync(absolute)) {
    if (lstatSync(absolute).isSymbolicLink())
      throw Error("SYMLINKED_WATCH_PATH");
    rejectRealHistoricalAndRepositoryPath(absolute);
  }
  const parent = dirname(absolute);
  if (!existsSync(parent)) return;
  rejectRealHistoricalAndRepositoryPath(parent);
  const realParent = realpathSync(parent);
  if (lower(realParent) !== lower(parent))
    throw Error("SYMLINKED_WATCH_PATH");
}

function assertFile(path: string, name: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error(`WATCH_FILE_NOT_REGULAR:${name}`);
  if (stat.size < 1 || stat.size > MAX_FILE_BYTES)
    throw Error(`WATCH_FILE_SIZE:${name}`);
}

function parseManifest(value: unknown): WatchManifest {
  const manifest = value as WatchManifest;
  if (
    !manifest ||
    Object.keys(manifest).sort().join(",") !==
      "address,birthday,keyId,network,version" ||
    manifest.version !== 1 ||
    manifest.network !== NETWORK ||
    !HEX64.test(manifest.keyId) ||
    !Number.isSafeInteger(manifest.birthday) ||
    manifest.birthday < 1 ||
    typeof manifest.address !== "string" ||
    !UNIFIED.test(manifest.address)
  )
    throw Error("INVALID_WATCH_MANIFEST");
  return manifest;
}

function verifyViewingKey(encoded: string, manifest: WatchManifest): void {
  const key = encoded.trim();
  if (
    !key ||
    key.length > 4096 ||
    !VIEWING_KEY.test(key) ||
    sha256(key) !== manifest.keyId
  )
    throw Error("INVALID_MAINNET_VIEWING_KEY");
}

function verifyDatabaseBytes(data: Buffer) {
  if (data.length < 100 || !data.subarray(0, 16).equals(SQLITE_HEADER))
    throw Error("INVALID_WATCH_DATABASE");
}

function verifyDatabase(path: string) {
  verifyDatabaseBytes(readFileSync(path));
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare("PRAGMA integrity_check").all() as {
      integrity_check?: string;
    }[];
    if (
      rows.length !== 1 ||
      rows[0]?.integrity_check?.toLowerCase() !== "ok"
    )
      throw Error("INVALID_WATCH_DATABASE");
  } catch {
    throw Error("INVALID_WATCH_DATABASE");
  } finally {
    database?.close();
  }
}

function inspectDirectory(directory: string) {
  rejectRealHistoricalAndRepositoryPath(directory);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("WATCH_PROFILE_DIRECTORY_REQUIRED");
  const entries = readdirSync(directory).sort();
  if (entries.includes("process.lock"))
    throw Error("WATCH_PROFILE_MUST_BE_STOPPED");
  for (const name of entries)
    if (!ALLOWED_FILES.includes(name as (typeof ALLOWED_FILES)[number]))
      throw Error(`UNEXPECTED_WATCH_PROFILE_FILE:${name}`);
  for (const required of REQUIRED_FILES)
    if (!entries.includes(required))
      throw Error(`MISSING_WATCH_PROFILE_FILE:${required}`);
  for (const name of entries) assertFile(resolve(directory, name), name);
  const manifest = parseManifest(
    JSON.parse(readFileSync(resolve(directory, "watch-only.json"), "utf8")),
  );
  verifyViewingKey(
    readFileSync(resolve(directory, "viewing-key.txt"), "utf8"),
    manifest,
  );
  verifyDatabase(resolve(directory, "wallet.sqlite"));
  return {
    manifest,
    metadata: {
      network: NETWORK,
      watchOnly: true,
      account: manifest.keyId,
      address: manifest.address,
      birthday: manifest.birthday,
    } satisfies WatchMetadata,
  };
}

function decodeArchiveFile(file: ArchiveFile): Buffer {
  if (
    !file ||
    !ALLOWED_FILES.includes(file.name) ||
    !HEX64.test(file.sha256 ?? "") ||
    typeof file.data !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) ||
    file.data.length % 4 !== 0
  )
    throw Error("INVALID_WATCH_BACKUP");
  const data = Buffer.from(file.data, "base64");
  if (
    data.length < 1 ||
    data.length > MAX_FILE_BYTES ||
    sha256(data) !== file.sha256
  )
    throw Error("WATCH_BACKUP_FILE_INTEGRITY_FAILED");
  return data;
}

export function validateWatchBackupArchive(value: unknown): WatchBackupArchive {
  const archive = value as WatchBackupArchive;
  if (
    !archive ||
    Object.keys(archive).sort().join(",") !==
      "account,address,birthday,createdAt,files,format,network,version" ||
    archive.format !== FORMAT ||
    archive.version !== 1 ||
    typeof archive.createdAt !== "string" ||
    Number.isNaN(Date.parse(archive.createdAt)) ||
    archive.network !== NETWORK ||
    !HEX64.test(archive.account) ||
    typeof archive.address !== "string" ||
    !UNIFIED.test(archive.address) ||
    !Number.isSafeInteger(archive.birthday) ||
    archive.birthday < 1 ||
    !Array.isArray(archive.files)
  )
    throw Error("INVALID_WATCH_BACKUP");
  const names = new Set<string>();
  let total = 0;
  for (const file of archive.files) {
    if (names.has(file?.name)) throw Error("DUPLICATE_WATCH_BACKUP_FILE");
    names.add(file?.name);
    total += decodeArchiveFile(file).length;
  }
  if (total > MAX_ARCHIVE_BYTES) throw Error("WATCH_BACKUP_TOO_LARGE");
  for (const required of REQUIRED_FILES)
    if (!names.has(required)) throw Error("INCOMPLETE_WATCH_BACKUP");
  const manifest = parseManifest(
    JSON.parse(
      decodeArchiveFile(
        archive.files.find((file) => file.name === "watch-only.json")!,
      ).toString("utf8"),
    ),
  );
  verifyViewingKey(
    decodeArchiveFile(
      archive.files.find((file) => file.name === "viewing-key.txt")!,
    ).toString("utf8"),
    manifest,
  );
  verifyDatabaseBytes(
    decodeArchiveFile(
      archive.files.find((file) => file.name === "wallet.sqlite")!,
    ),
  );
  if (
    manifest.keyId !== archive.account ||
    manifest.address !== archive.address ||
    manifest.birthday !== archive.birthday
  )
    throw Error("WATCH_BACKUP_METADATA_MISMATCH");
  return archive;
}

export function packWatchProfile(directory: string): {
  archive: WatchBackupArchive;
  metadata: WatchMetadata;
} {
  assertExternalPath(directory);
  const { manifest, metadata } = inspectDirectory(resolve(directory));
  const files = readdirSync(resolve(directory))
    .sort()
    .map((name) => {
      const data = readFileSync(resolve(directory, name));
      return {
        name: name as ArchiveFile["name"],
        sha256: sha256(data),
        data: data.toString("base64"),
      };
    });
  return {
    metadata,
    archive: {
      format: FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      network: NETWORK,
      account: manifest.keyId,
      address: manifest.address,
      birthday: manifest.birthday,
      files,
    },
  };
}

export async function encryptWatchBackup(
  archive: WatchBackupArchive,
  recipient: string,
): Promise<Uint8Array> {
  validateWatchBackupArchive(archive);
  if (!/^age1[0-9a-z]{20,200}$/.test(recipient))
    throw Error("AGE_RECIPIENT_REQUIRED");
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(JSON.stringify(archive));
}

export async function decryptWatchBackup(
  ciphertext: Uint8Array,
  identity: string,
): Promise<WatchBackupArchive> {
  if (
    ciphertext.length < 32 ||
    ciphertext.length > MAX_ARCHIVE_BYTES ||
    !/^AGE-SECRET-KEY-(PQ-)?1[0-9A-Z]+$/.test(identity)
  )
    throw Error("INVALID_WATCH_BACKUP_IDENTITY");
  try {
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    return validateWatchBackupArchive(
      JSON.parse(await decrypter.decrypt(ciphertext, "text")),
    );
  } catch {
    throw Error("WATCH_BACKUP_DECRYPT_FAILED");
  }
}

export function writeEncryptedWatchBackup(
  path: string,
  ciphertext: Uint8Array,
): void {
  assertExternalPath(path);
  if (existsSync(path)) throw Error("WATCH_BACKUP_MUST_BE_NEW");
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, ciphertext);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function restoreWatchProfile(
  archive: WatchBackupArchive,
  output: string,
): WatchMetadata {
  validateWatchBackupArchive(archive);
  assertExternalPath(output);
  if (existsSync(output)) throw Error("WATCH_RESTORE_DIRECTORY_MUST_BE_NEW");
  const parent = dirname(resolve(output));
  if (!existsSync(parent)) throw Error("WATCH_RESTORE_PARENT_REQUIRED");
  rejectRealHistoricalAndRepositoryPath(parent);
  const temporary = resolve(
    parent,
    `.${basename(output)}.restore-${randomBytes(12).toString("hex")}`,
  );
  mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const file of archive.files) {
      const data = decodeArchiveFile(file),
        path = resolve(temporary, file.name);
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    const recovered = inspectDirectory(temporary).metadata;
    renameSync(temporary, resolve(output));
    return recovered;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
