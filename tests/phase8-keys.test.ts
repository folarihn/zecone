// Disposable credentials only. No live wallet, network send or production key use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Encrypter } from "age-encryption";
import {
  generateKeyPairSigner,
  createKeyPairSignerFromPrivateKeyBytes,
  createSignableMessage,
  getBase64EncodedWireTransaction,
  blockhash,
  type KeyPairSigner,
} from "@solana/kit";
import { SignerLease, type WalletRole } from "../services/signer/lease.ts";
import { WalletVault } from "../services/signer/wallet-vault.ts";
import { EncryptedAccounts } from "../services/solana/encrypted-accounts.ts";
import {
  leasedSigner,
  signWithLocalSigner,
} from "../services/solana/leased-signer.ts";
import { transaction } from "../services/solana/transactions.ts";
import { GENESIS } from "../services/solana/network.ts";
import { Store } from "../services/execution/store.ts";
import { SolanaSettlement } from "../services/solana/settlement.ts";
import {
  PrivacyDiagnostics,
  checkoutBrowserView,
} from "../services/wallet/privacy.ts";
const dir = () => mkdtempSync(join(tmpdir(), "zecone-key-fixture-")),
  pass = "synthetic-unique-passphrase-for-tests-only";
const code = (expected: string) => (e: any) => e?.code === expected;
function deferred<T>() {
  let yes!: (value: T) => void;
  const promise = new Promise<T>((r) => (yes = r));
  return { promise, yes };
}

test("8B lease requires consent, validates bounds and separates roles", async () => {
  const l = new SignerLease<object>("user");
  let loads = 0;
  await assert.rejects(
    l.unlock(async () => {
      loads++;
      return {};
    }, false),
    code("APPROVAL_REQUIRED"),
  );
  assert.equal(loads, 0);
  assert.equal(l.status().state, "LOCKED");
  assert.throws(() => new SignerLease("user", { inactivityMs: 0 }));
  assert.throws(
    () => new SignerLease("user", { inactivityMs: 200, maxLeaseMs: 100 }),
  );
  await l.unlock(async () => ({}), true);
  assert.equal(l.status().state, "UNLOCKED");
  assert.throws(() => l.capture("relayer"), code("SIGNER_ROLE_MISMATCH"));
  l.lock();
  assert.equal(l.status().state, "LOCKED");
  const broken = new SignerLease<object>("user", {}, () => {
    throw Error("synthetic-secret-canary");
  });
  await broken.unlock(async () => ({}), true);
  broken.lock();
  assert.equal(broken.status().state, "LOCKED");
  assert.equal(broken.status().cleanupFailed, true);
  await assert.rejects(
    broken.unlock(async () => ({}), true),
    code("SIGNER_CLEANUP_FAILED"),
  );
  const replacing = new SignerLease<object>("user", {}, () => {
    throw Error("synthetic-secret-canary");
  });
  await replacing.unlock(async () => ({}), true);
  await assert.rejects(
    replacing.unlock(async () => {
      loads++;
      return {};
    }, true),
    code("SIGNER_CLEANUP_FAILED"),
  );
  assert.equal(loads, 0);
  assert.equal(replacing.status().state, "LOCKED");
});
test("8B inactivity and hard deadlines reject retained leases without relying on timers", async () => {
  let now = 0;
  const l = new SignerLease<object>("relayer", {
    now: () => now,
    inactivityMs: 10,
    maxLeaseMs: 25,
  });
  await l.unlock(async () => ({}), true);
  const token = l.capture("relayer");
  now = 9;
  await l.run("relayer", token, async () => true);
  assert.equal(l.status().expiresAt, 19);
  now = 18;
  await l.run("relayer", token, async () => true);
  assert.equal(l.status().expiresAt, 25);
  now = 25;
  await assert.rejects(
    l.run("relayer", token, async () =>
      assert.fail("Expired lease reached signer"),
    ),
    code("WALLET_LOCKED"),
  );
  assert.equal(l.status().state, "LOCKED");
});
test("8B idle timer locks automatically without a status read", async () => {
  let disposed = 0;
  const l = new SignerLease<object>(
    "user",
    { inactivityMs: 15, maxLeaseMs: 100 },
    () => disposed++,
  );
  await l.unlock(async () => ({}), true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(disposed, 1);
  assert.equal(l.status().state, "LOCKED");
});
test("8B delayed unlock is cancelled by lock and cannot race another KDF", async () => {
  const d = deferred<object>();
  let disposed = 0,
    loads = 0;
  const l = new SignerLease<object>("user", {}, () => disposed++);
  const pending = l.unlock(async () => {
    loads++;
    return d.promise;
  }, true);
  assert.equal(l.status().state, "UNLOCKING");
  await assert.rejects(
    l.unlock(async () => {
      loads++;
      return {};
    }, true),
    code("SIGNER_BUSY"),
  );
  l.lock();
  assert.equal(l.status().state, "LOCKED");
  await assert.rejects(
    l.unlock(async () => ({}), true),
    code("SIGNER_BUSY"),
  );
  d.yes({});
  await assert.rejects(pending, code("UNLOCK_CANCELLED"));
  assert.equal(loads, 1);
  assert.equal(disposed, 1);
  assert.equal(l.status().state, "LOCKED");
  await l.unlock(async () => ({}), true);
  l.lock();
});
test("8B lock during an operation suppresses its result and forbids concurrent signing/unlock", async () => {
  const l = new SignerLease<object>("relayer"),
    d = deferred<string>();
  await l.unlock(async () => ({}), true);
  const token = l.capture("relayer"),
    pending = l.run("relayer", token, async () => d.promise);
  await assert.rejects(
    l.run("relayer", token, async () => "bad"),
    code("SIGNER_BUSY"),
  );
  await assert.rejects(
    l.unlock(async () => ({}), true),
    code("SIGNER_BUSY"),
  );
  l.lock();
  d.yes("discarded-result");
  await assert.rejects(pending, code("WALLET_LOCKED"));
  await l.unlock(async () => ({}), true);
  await assert.rejects(
    l.run("relayer", token, async () =>
      assert.fail("Stale generation reached signer"),
    ),
    code("WALLET_LOCKED"),
  );
  l.lock();
});
test("8B operation finishing after expiry is rejected and role leases are independent", async () => {
  let now = 0;
  const options = { now: () => now, inactivityMs: 10, maxLeaseMs: 20 };
  const user = new SignerLease<object>("user", options),
    relayer = new SignerLease<object>("relayer", options);
  await user.unlock(async () => ({}), true);
  await relayer.unlock(async () => ({}), true);
  user.lock();
  assert.equal(relayer.status().state, "UNLOCKED");
  const t = relayer.capture("relayer");
  await assert.rejects(
    relayer.run("relayer", t, async () => {
      now = 11;
      return "discard";
    }),
    code("WALLET_LOCKED"),
  );
});
test("8B failed attempts are bounded, lock cannot reset cooldown, restart begins locked", async () => {
  let now = 0,
    loads = 0;
  const options = {
    now: () => now,
    maxFailures: 2,
    cooldownMs: 100,
    failureWindowMs: 1000,
  };
  const l = new SignerLease<object>("user", options),
    bad = async () => {
      loads++;
      throw Error("synthetic-secret-canary");
    };
  for (let i = 0; i < 2; i++)
    await assert.rejects(l.unlock(bad, true), code("UNLOCK_FAILED"));
  l.lock();
  await assert.rejects(l.unlock(bad, true), code("UNLOCK_THROTTLED"));
  assert.equal(loads, 2);
  now = 100;
  await l.unlock(async () => ({}), true);
  l.lock();
  assert.equal(new SignerLease("user", options).status().state, "LOCKED");
});
test("8B revocable SDK facade exports no keypair and remains revoked after re-unlock", async () => {
  const raw = await generateKeyPairSigner(),
    l = new SignerLease<KeyPairSigner>("user");
  await l.unlock(async () => raw, true);
  const facade = leasedSigner(l, raw.address, "user");
  assert.equal("keyPair" in facade, false);
  const message = createSignableMessage(
    "synthetic fixture; no financial authorization",
  );
  await assert.rejects(
    facade.signMessages([]),
    code("SINGLE_SIGNING_OPERATION_REQUIRED"),
  );
  await assert.rejects(
    facade.signMessages([message, message]),
    code("SINGLE_SIGNING_OPERATION_REQUIRED"),
  );
  assert.ok((await facade.signMessages([message]))[0][raw.address]);
  l.lock();
  await assert.rejects(facade.signMessages([message]), code("WALLET_LOCKED"));
  await l.unlock(async () => raw, true);
  await assert.rejects(facade.signMessages([message]), code("WALLET_LOCKED"));
  l.lock();
  assert.ok(!JSON.stringify(facade).includes("privateKey"));
});
test("8B SDK adapter preserves exact canonical bytes for leased and legacy signers", async () => {
  const raw = await generateKeyPairSigner(),
    recipient = (await generateKeyPairSigner()).address;
  const l = new SignerLease<KeyPairSigner>("relayer");
  await l.unlock(async () => raw, true);
  const tx = await transaction(
    {
      family: "solana",
      network: "solana:devnet",
      genesis: GENESIS,
      owner: raw.address,
      recipient,
      amount: "1",
      asset: { kind: "SOL" },
      feeCap: "10000",
    },
    {
      blockhash: blockhash("11111111111111111111111111111111"),
      lastValidBlockHeight: 1000n,
    },
  );
  const a = await signWithLocalSigner(raw, tx),
    b = await signWithLocalSigner(leasedSigner(l, raw.address, "relayer"), tx);
  assert.equal(
    getBase64EncodedWireTransaction(a),
    getBase64EncodedWireTransaction(b),
  );
  l.lock();
});

test("8B new vault imports encrypted seed32 only; role/network/address tampering fails AEAD", async () => {
  const root = dir(),
    v = new WalletVault(root),
    seed = randomBytes(32),
    password = Buffer.from(pass);
  try {
    await assert.rejects(
      v.import("user", "base-sepolia", seed, password, false),
    );
    const meta = await v.import("user", "base-sepolia", seed, password, true),
      file = join(root, "user", `${meta.id}.json`),
      bytes = readFileSync(file);
    assert.ok(!bytes.includes(seed));
    assert.ok(!bytes.includes(Buffer.from(seed.toString("hex"))));
    assert.ok(!bytes.includes(password));
    assert.ok(!JSON.stringify(meta).includes("sealed"));
    assert.equal(
      (await v.verify("user", meta.id, password, true)).signingActivated,
      false,
    );
    await assert.rejects(
      v.verify(
        "user",
        meta.id,
        Buffer.from("incorrect-long-password-for-fixtures"),
        true,
      ),
      code("UNLOCK_FAILED"),
    );
    const original = readFileSync(file, "utf8"),
      changed = JSON.parse(original);
    changed.role = "relayer";
    mkdirSync(join(root, "relayer"));
    writeFileSync(
      join(root, "relayer", `${meta.id}.json`),
      JSON.stringify(changed),
    );
    await assert.rejects(
      v.verify("relayer", meta.id, password, true),
      code("UNLOCK_FAILED"),
    );
    changed.role = "user";
    changed.network = "ethereum-sepolia";
    writeFileSync(file, JSON.stringify(changed));
    await assert.rejects(
      v.verify("user", meta.id, password, true),
      code("UNLOCK_FAILED"),
    );
    writeFileSync(file, original);
    assert.equal(new WalletVault(root).list("user").length, 1);
    assert.ok(!JSON.stringify(v.list("user")).includes(seed.toString("hex")));
  } finally {
    seed.fill(0);
    password.fill(0);
  }
});
test("8B refund approver storage is a distinct role; mainnet and native wallet activation are unsupported", async () => {
  const v = new WalletVault(dir()),
    password = Buffer.from(pass);
  const meta = await v.create(
    "refund-approver",
    "approval-testnet",
    password,
    true,
  );
  assert.equal(meta.role, "refund-approver");
  assert.equal(
    (await v.verify("refund-approver", meta.id, password, true))
      .signingActivated,
    false,
  );
  assert.throws(() => v.public("user", meta.id));
  for (const [role, network] of [
    ["user", "mainnet"],
    ["relayer", "zcash-testnet"],
    ["refund-approver", "base-sepolia"],
    ["user", "approval-testnet"],
  ])
    await assert.rejects(
      v.create(role as WalletRole, network as any, password, true),
    );
  password.fill(0);
});
test("8B vault verification throttles failures and never exposes secret fields in diagnostics or response data", async () => {
  let now = 0;
  const v = new WalletVault(dir(), {
      now: () => now,
      maxFailures: 1,
      cooldownMs: 100,
    }),
    password = Buffer.from(pass),
    seed = randomBytes(32);
  try {
    const meta = await v.import(
      "relayer",
      "solana-devnet",
      seed,
      password,
      true,
    );
    let error: unknown;
    try {
      await v.verify(
        "relayer",
        meta.id,
        Buffer.from("wrong-password-for-fixture-only"),
        true,
      );
    } catch (e) {
      error = e;
    }
    assert.ok(!String(error).includes(pass));
    await assert.rejects(
      v.verify("relayer", meta.id, password, true),
      code("UNLOCK_THROTTLED"),
    );
    now = 100;
    const result = await v.verify("relayer", meta.id, password, true),
      d = new PrivacyDiagnostics();
    d.record("INVALID_REQUEST", { seed: seed.toString("hex"), pass, error });
    for (const item of [
      result,
      v.public("relayer", meta.id),
      d.export(),
      checkoutBrowserView(
        { kind: "solana", seed: seed.toString("hex") },
        "opaque",
      ),
    ]) {
      assert.ok(!JSON.stringify(item).includes(seed.toString("hex")));
      assert.ok(!JSON.stringify(item).includes(pass));
    }
    const source = readFileSync("app/checkout/tracker.tsx", "utf8");
    assert.ok(!source.includes("wallet-vault"));
    assert.ok(!source.includes("encrypted-accounts"));
  } finally {
    seed.fill(0);
    password.fill(0);
  }
});
test("8B provisioning CLI is opt-in; list is read-only and does not unlock any signer", async () => {
  const root = dir(),
    cwd = join(root, "working");
  mkdirSync(cwd);
  const script = resolve("scripts/phase8-wallet.ts"),
    passwordFile = join(root, "passphrase.bytes");
  writeFileSync(passwordFile, pass);
  const exec = promisify(execFile),
    args = ["--import", "tsx", script];
  // Resolve tsx from the project; the child cwd is deliberately a disposable root.
  const tsx = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
  args[1] = tsx;
  const listed = await exec(process.execPath, [...args, "list", "user"], {
    cwd,
    windowsHide: true,
  });
  assert.deepEqual(JSON.parse(listed.stdout).wallets, []);
  assert.equal(readdirSync(cwd).length, 0);
  const misleading = join(cwd, "..local-password.bytes");
  writeFileSync(misleading, pass);
  await assert.rejects(
    exec(
      process.execPath,
      [
        ...args,
        "create",
        "user",
        "base-sepolia",
        "--allow-new-testnet-credential",
        "--password-file",
        misleading,
      ],
      { cwd, windowsHide: true },
    ),
  );
  await assert.rejects(
    exec(
      process.execPath,
      [
        ...args,
        "create",
        "user",
        "base-sepolia",
        "--password-file",
        passwordFile,
      ],
      { cwd, windowsHide: true },
    ),
  );
  const created = await exec(
    process.execPath,
    [
      ...args,
      "create",
      "user",
      "base-sepolia",
      "--allow-new-testnet-credential",
      "--password-file",
      passwordFile,
    ],
    { cwd, windowsHide: true },
  );
  const meta = JSON.parse(created.stdout),
    file = join(cwd, ".secrets/phase8b-wallets/user", `${meta.id}.json`),
    before = readFileSync(file);
  const output = await exec(process.execPath, [...args, "list", "user"], {
    cwd,
    windowsHide: true,
  });
  assert.equal(JSON.parse(output.stdout).wallets.length, 1);
  assert.ok(before.equals(readFileSync(file)));
  assert.ok(!output.stdout.includes(pass));
  assert.ok(!created.stdout.includes("sealed"));
  assert.ok(!created.stderr.includes(pass));
});

test("8B encrypted Solana accounts invalidate retained facades, auto-expire, and restart locked", async () => {
  let now = 0;
  const root = dir(),
    label = `recipient-${randomUUID()}`,
    a = new EncryptedAccounts(root, {
      now: () => now,
      inactivityMs: 10,
      maxLeaseMs: 30,
    });
  const address = await a.generate(label, pass),
    before = readFileSync(join(root, `${label}.age`));
  assert.equal(a.status(label).state, "LOCKED");
  assert.equal(a.list()[0].address, address);
  await a.unlock(label, pass, true);
  const signer = a.signer(label),
    message = createSignableMessage("test-only message");
  a.lock(label);
  await assert.rejects(signer.signMessages([message]), code("WALLET_LOCKED"));
  await a.unlock(label, pass, true);
  const fresh = a.signer(label);
  now = 10;
  await assert.rejects(fresh.signMessages([message]), code("WALLET_LOCKED"));
  assert.equal(new EncryptedAccounts(root).status(label).state, "LOCKED");
  assert.ok(before.equals(readFileSync(join(root, `${label}.age`))));
  await assert.rejects(
    a.unlock(label, pass, true, "relayer"),
    code("SIGNER_ROLE_MISMATCH"),
  );
});
test("8B actual delayed age unlock cannot restore access after lock", async () => {
  const root = dir(),
    label = `recipient-${randomUUID()}`,
    base = new EncryptedAccounts(root);
  await base.generate(label, pass);
  const started = deferred<void>(),
    release = deferred<void>();
  class Delayed extends EncryptedAccounts {
    protected override async decryptPayload(
      cipher: Uint8Array,
      password: string,
    ) {
      started.yes();
      await release.promise;
      return super.decryptPayload(cipher, password);
    }
  }
  const a = new Delayed(root),
    pending = a.unlock(label, pass, true);
  await started.promise;
  a.lock();
  release.yes();
  await assert.rejects(pending, code("UNLOCK_CANCELLED"));
  assert.equal(a.status(label).state, "LOCKED");
  assert.throws(() => a.signer(label));
});
test("8B new age credentials bind role/label; read-only metadata never decrypts", async () => {
  const root = dir(),
    label = `recipient-${randomUUID()}`,
    a = new EncryptedAccounts(root);
  const address = await a.generate(label, pass);
  class ReadOnly extends EncryptedAccounts {
    protected override async decryptPayload(): Promise<Uint8Array> {
      assert.fail("Display attempted decryption");
    }
  }
  const readOnly = new ReadOnly(root);
  assert.equal(readOnly.address(label), address);
  assert.equal(readOnly.list().length, 1);
  assert.equal(readOnly.status(label).state, "LOCKED");
  copyFileSync(join(root, `${label}.age`), join(root, "relayer.age"));
  const meta = JSON.parse(
    readFileSync(join(root, `${label}.public.json`), "utf8"),
  );
  writeFileSync(
    join(root, "relayer.public.json"),
    JSON.stringify({ ...meta, label: "relayer", role: "relayer" }),
  );
  await assert.rejects(a.unlock("relayer", pass, true), code("UNLOCK_FAILED"));
  class Rejecting extends EncryptedAccounts {
    calls = 0;
    protected override async decryptPayload(): Promise<Uint8Array> {
      this.calls++;
      throw Error("synthetic-secret-canary");
    }
  }
  const rejects = new Rejecting(root, { maxFailures: 2, cooldownMs: 1000 });
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      rejects.unlock(label, pass, true),
      code("UNLOCK_FAILED"),
    );
  rejects.lock();
  await assert.rejects(
    rejects.unlock(label, pass, true),
    code("UNLOCK_THROTTLED"),
  );
  assert.equal(rejects.calls, 2);
});
test("8B legacy age-v1 compatibility leaves existing bytes unchanged", async () => {
  const root = dir(),
    seed = randomBytes(32),
    label = "relayer",
    signer = await createKeyPairSignerFromPrivateKeyBytes(seed),
    enc = new Encrypter();
  enc.setPassphrase(pass);
  const cipher = await enc.encrypt(seed);
  seed.fill(0);
  writeFileSync(join(root, "relayer.age"), cipher);
  writeFileSync(
    join(root, "relayer.public.json"),
    JSON.stringify({
      label,
      address: signer.address,
      network: "solana:devnet",
      format: "age-v1",
    }),
  );
  const hash = () =>
      createHash("sha256")
        .update(readFileSync(join(root, "relayer.age")))
        .update(readFileSync(join(root, "relayer.public.json")))
        .digest("hex"),
    before = hash();
  const a = new EncryptedAccounts(root);
  await a.unlock(label, pass, true);
  assert.equal(a.signer(label).address, signer.address);
  a.lock();
  assert.equal(hash(), before);
});
test("8B completed settlement rejects duplicate execution before even reading a leased signer", async () => {
  const store = new Store(":memory:"),
    network: any = new Proxy(
      {},
      {
        get() {
          assert.fail("Completed fixture reached network");
        },
      },
    ),
    service = new SolanaSettlement(store, network, () => 100);
  const relayer = (await generateKeyPairSigner()).address,
    recipient = (await generateKeyPairSigner()).address;
  const id = service.quote({
    profileId: randomUUID(),
    requestId: randomUUID(),
    recipient,
    relayer,
    lamports: "1000000",
    account: "a".repeat(64),
    paymentAddress: "utest1_SYNTHETIC_ONLY",
  }).id;
  store.db.prepare("UPDATE orders SET state='settled'").run();
  store.db
    .prepare("UPDATE solana_settlement SET state='COMPLETED',claimed=1")
    .run();
  const signer: any = new Proxy(
    {},
    {
      get() {
        assert.fail("Completed fixture reached signer");
      },
    },
  );
  await assert.rejects(
    service.execute(
      id,
      { orderId: id, digest: "unapproved", approved: true },
      signer,
    ),
  );
  assert.equal(service.row(id).state, "COMPLETED");
  store.close();
});
