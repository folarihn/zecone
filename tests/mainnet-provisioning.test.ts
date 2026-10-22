// Disposable credentials only. These addresses are not pilot/production accounts.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import {
  generateBaseMainnetKey,
  generateSolanaMainnetKey,
  sealMainnetCredential,
  openMainnetCredential,
  writeMainnetKeystore,
  readMainnetKeystore,
  assertDistinctMainnetCredentials,
} from "../services/provisioning/mainnet-keystore.ts";
import { relayerFromSigner } from "../services/settlement/mainnet-address.ts";
test("disposable Base/Solana derivation matches independent public-key derivation and roles stay separate", async () => {
  const keys = [
    await generateBaseMainnetKey(),
    await generateBaseMainnetKey(),
    await generateSolanaMainnetKey(),
    await generateSolanaMainnetKey(),
  ];
  try {
    for (const k of keys.slice(0, 2)) {
      assert.equal(
        privateKeyToAccount(`0x${k.secret.toString("hex")}`).address,
        k.address,
      );
      assert.equal(relayerFromSigner("base", k.publicKey), k.address);
    }
    for (const k of keys.slice(2)) {
      assert.equal(
        (await createKeyPairSignerFromPrivateKeyBytes(k.secret)).address,
        k.address,
      );
      assert.equal(relayerFromSigner("solana", k.publicKey), k.address);
    }
    assertDistinctMainnetCredentials(
      keys.map((k, i) => ({
        purpose: [
          "mainnet:base:recipient",
          "mainnet:base:relayer",
          "mainnet:solana:recipient",
          "mainnet:solana:relayer",
        ][i] as any,
        address: k.address,
      })),
    );
    assert.equal(new Set(keys.map((k) => k.address)).size, 4);
  } finally {
    keys.forEach((k) => k.secret.fill(0));
  }
});
test("disposable encrypted persistence, backup and recovery reveal no plaintext and refuse overwrite", async () => {
  const pass = randomBytes(48),
    key = await generateBaseMainnetKey(),
    root = mkdtempSync(join(tmpdir(), "zecone-provision-"));
  let recovered: Buffer | undefined;
  try {
    const envelope = await sealMainnetCredential(
        key.secret,
        pass,
        "mainnet:base:recipient",
      ),
      file = join(root, "wallet.json"),
      backup = join(root, "backup.json");
    writeMainnetKeystore(file, envelope);
    assert.throws(() => writeMainnetKeystore(file, envelope));
    const saved = readFileSync(file, "utf8");
    assert.ok(!saved.includes(key.secret.toString("hex")));
    assert.ok(!saved.includes(pass.toString("hex")));
    copyFileSync(file, backup);
    recovered = await openMainnetCredential(
      readMainnetKeystore(backup),
      pass,
      "mainnet:base:recipient",
    );
    assert.ok(recovered.equals(key.secret));
    assert.equal(
      privateKeyToAccount(`0x${recovered.toString("hex")}`).address,
      key.address,
    );
  } finally {
    key.secret.fill(0);
    pass.fill(0);
    recovered?.fill(0);
  }
});
test("disposable credential passwords, network/purpose substitution and tampering fail closed", async () => {
  const pass = randomBytes(48),
    secret = randomBytes(32);
  try {
    const e = await sealMainnetCredential(
      secret,
      pass,
      "mainnet:solana:relayer",
    );
    await assert.rejects(
      openMainnetCredential(e, randomBytes(48), "mainnet:solana:relayer"),
    );
    await assert.rejects(
      openMainnetCredential(e, pass, "mainnet:solana:recipient"),
    );
    await assert.rejects(
      openMainnetCredential(e, pass, "mainnet:base:relayer"),
    );
    await assert.rejects(
      openMainnetCredential(
        { ...e, purpose: "development-wallet:relayer" },
        pass,
        "mainnet:solana:relayer",
      ),
    );
    await assert.rejects(
      openMainnetCredential(
        { ...e, tag: "0".repeat(32) },
        pass,
        "mainnet:solana:relayer",
      ),
    );
    await assert.rejects(
      openMainnetCredential(
        { ...e, ciphertext: "ab".repeat(1000000) },
        pass,
        "mainnet:solana:relayer",
      ),
      /INVALID_MAINNET_KEYSTORE/,
    );
  } finally {
    pass.fill(0);
    secret.fill(0);
  }
});

test("disposable Zcash mainnet provisioning records birthday and recovers the same UFVK", () => {
  const root = mkdtempSync(join(tmpdir(), "zecone-zcash-provision-")),
    passphrase = join(root, "passphrase.bin"),
    output = join(root, "wallets"),
    recovered = join(root, "recovered.ufvk");
  writeFileSync(passphrase, randomBytes(48));
  try {
    const provision = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/mainnet-provision.ts",
        "--out",
        output,
        "--passphrase-file",
        passphrase,
        "--zcash-birthday",
        "3526000",
        "--confirm",
        "CREATE_MAINNET_KEYS",
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(provision.status, 0, provision.stderr);
    const metadata = JSON.parse(
        readFileSync(join(output, "provisioning.json"), "utf8"),
      ) as {
        credentials: { role: string; birthday?: number }[];
      },
      originalUfvk = readFileSync(join(output, "zcash-receiver.ufvk"), "utf8");
    assert.equal(
      metadata.credentials.find((item) => item.role === "zcash-receiver")
        ?.birthday,
      3_526_000,
    );
    assert.match(originalUfvk, /^uview1/);
    assert.ok(!provision.stdout.includes(originalUfvk.trim()));

    const recovery = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/mainnet-zcash-recover.ts",
        "--keystore",
        join(output, "zcash-receiver.keystore.json"),
        "--passphrase-file",
        passphrase,
        "--provisioning",
        join(output, "provisioning.json"),
        "--out",
        recovered,
        "--confirm",
        "RECOVER_MAINNET_UFVK",
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(readFileSync(recovered, "utf8"), originalUfvk);
    assert.ok(!recovery.stdout.includes(originalUfvk.trim()));
    assert.equal(JSON.parse(recovery.stdout).birthday, 3_526_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
