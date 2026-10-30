// Operator-only: register the ZecOne merchant whose Base payout address is the
// existing allow-listed recipient, using the existing recipient keystore.
// Signs exactly one EIP-4361 registration message (no transaction, no
// approval), and only against a loopback payments API in monitor mode.
//
//   npm run merchant:siwe-register -- --api http://127.0.0.1:4321/ --domain localhost:3000 \
//     --address 0x4b5750d7675f14eB844B74477015302Bf31AE2dB --keystore <base-recipient.keystore.json> \
//     --passphrase-file <passphrase.txt> --out <protected/merchant-api-key.json> \
//     --confirm REGISTER_MERCHANT_0x4b5750d7675f14eB844B74477015302Bf31AE2dB
//
// The API key is written once to --out (mode 0600, never overwritten) and is
// never printed. No key material or signature is printed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { exclusiveJson } from "../services/execution/io.ts";
import { assertExternalPath } from "../services/provisioning/mainnet-watch-backup.ts";
import { openMainnetCredential, readMainnetKeystore } from "../services/provisioning/mainnet-keystore.ts";
import { registerMerchant } from "../services/payments/merchant-register.ts";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v || v.startsWith("--")) throw Error(`MISSING_${name.toUpperCase().replace(/-/g, "_")}`);
  return v;
}

async function main() {
  const address = getAddress(arg("address"));
  if (arg("confirm") !== `REGISTER_MERCHANT_${address}`) throw Error("EXACT_CONFIRMATION_REQUIRED");
  const out = resolve(arg("out"));
  assertExternalPath(out);
  const keystore = readMainnetKeystore(resolve(arg("keystore")));
  const passphraseFile = resolve(arg("passphrase-file"));
  let signed = false;
  const result = await registerMerchant({
    api: arg("api"),
    domain: arg("domain"),
    address,
    name: process.argv.includes("--name") ? arg("name") : "ZecOne restricted mainnet pilot",
    expectedMode: "monitor",
    sign: async (message) => {
      if (signed) throw Error("SINGLE_SIGNATURE_ONLY");
      signed = true;
      const pass = readFileSync(passphraseFile);
      const secret = await openMainnetCredential(keystore, pass, "mainnet:base:recipient");
      try {
        const account = privateKeyToAccount(`0x${secret.toString("hex")}`);
        // Never sign for an address the keystore does not hold.
        if (account.address !== address) throw Error("KEYSTORE_ADDRESS_MISMATCH");
        return await account.signMessage({ message });
      } finally {
        secret.fill(0);
        pass.fill(0);
      }
    },
  });
  if (result.apiKey) exclusiveJson(out, { merchantId: result.merchantId, apiKey: result.apiKey });
  console.log(
    JSON.stringify({
      status: result.created ? "MERCHANT_REGISTERED" : "MERCHANT_ALREADY_REGISTERED_SESSION_ONLY",
      merchantId: result.merchantId,
      payoutAddress: result.payoutAddress,
      payoutVerification: result.payoutVerification,
      apiKeyWritten: result.apiKey ? out : null,
      transactionSigned: false,
    }),
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : "MERCHANT_REGISTRATION_FAILED" }));
  process.exitCode = 1;
});
