// Local user account operations only. Never import this module into the backend.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { EncryptedAccounts } from "../services/solana/encrypted-accounts.ts";
import { WindowsUnlock } from "../services/solana/windows-unlock.ts";
import { Accounts } from "../services/solana/accounts.ts";
import { json } from "../services/solana/network.ts";
const file = ".state/phase7c/profile.json",
  p = JSON.parse(readFileSync(file, "utf8")),
  command = process.argv[2];
const accounts = new EncryptedAccounts(),
  unlock = new WindowsUnlock();
try {
  if (command === "backup") {
    if (!process.argv.includes("--unlock-local-dpapi"))
      throw Error("Explicit local unlock required");
    const passwordFile = process.argv[3],
      output = process.argv[4];
    if (
      !passwordFile ||
      !output ||
      resolve(passwordFile).startsWith(resolve(".secrets")) ||
      existsSync(output)
    )
      throw Error(
        "Provide an external recovery passphrase file and a new backup output path",
      );
    const pass = readFileSync(passwordFile, "utf8").replace(/\r?\n$/, "");
    const address = await accounts.backup(
      p.recipientLabel,
      await unlock.unlock(p.recipientLabel, true),
      pass,
      output,
    );
    console.log(
      json({
        address,
        encryptedRecoveryWritten: true,
        plaintextExported: false,
      }),
    );
  } else if (command === "register-previous") {
    // Read only the established local account descriptor; no signing or network query.
    const old = Accounts.list().find((a) => a.label === "recipient");
    if (!old) throw Error("Previous local recipient unavailable");
    p.existingRecipients = [old.address];
    writeFileSync(file, json(p), { mode: 0o600 });
    console.log(
      json({
        address: old.address,
        registered: true,
        addressReuseWarning: true,
      }),
    );
  } else if (command === "new") {
    if (existsSync(`.state/phase7c/${p.id}/settlement.sqlite`))
      throw Error(
        "Create another recipient only before creating the immutable checkout; preserve the existing recipient and credentials",
      );
    const label = `recipient-${randomUUID()}`;
    p.recipient = await accounts.generate(label, await unlock.create(label));
    p.recipientLabel = label;
    writeFileSync(file, json(p), { mode: 0o600 });
    console.log(json({ address: p.recipient, keysEncrypted: true }));
  } else
    throw Error(
      "Use register-previous, new, or backup <external-passphrase-file> <new-backup.age> --unlock-local-dpapi",
    );
} finally {
  accounts.lock();
}
