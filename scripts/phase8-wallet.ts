// Local opt-in provisioning only. Never imported by wallet/backend servers.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import {
  WalletVault,
  type WalletNetwork,
} from "../services/signer/wallet-vault.ts";
import type { WalletRole } from "../services/signer/lease.ts";
const [command, role, network] = process.argv.slice(2),
  vault = new WalletVault();
let password: Buffer | undefined;
try {
  if (command === "list")
    console.log(
      JSON.stringify({
        wallets: vault.list(role as WalletRole),
        signingActivated: false,
      }),
    );
  else if (
    command === "create" &&
    process.argv.includes("--allow-new-testnet-credential")
  ) {
    const index = process.argv.indexOf("--password-file");
    if (index < 0 || !process.argv[index + 1]) throw Error();
    const file = realpathSync(process.argv[index + 1]),
      rel = relative(realpathSync("."), file),
      size = statSync(file).size;
    const outside =
      rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (!outside || size < 16 || size > 1024) throw Error();
    password = readFileSync(file);
    // The file is raw passphrase bytes (no newline). No passphrase/key argument,
    // clipboard, environment variable or existing-wallet import is accepted.
    console.log(
      JSON.stringify(
        await vault.create(
          role as WalletRole,
          network as WalletNetwork,
          password,
          true,
        ),
      ),
    );
  } else throw Error();
} catch {
  console.error(
    "New testnet credential operation unavailable. Use list <role> or create <role> <testnet> --allow-new-testnet-credential --password-file <local-file>. No secrets are printed.",
  );
  process.exitCode = 1;
} finally {
  password?.fill(0);
}
