// Push a pre-signed public pilot quote through the SSH-tunneled loopback
// operator endpoint. No keystore or private key is read by this command.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SignedCheckoutPilotQuote } from "../services/payments/pilot-quote.ts";
import { httpRemote } from "./operator-sync.ts";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value || value.startsWith("--")) throw Error(`MISSING_${name.toUpperCase().replace(/-/g, "_")}`);
  return value;
}

async function main() {
  const remote = httpRemote(
    arg("remote"),
    readFileSync(resolve(arg("token-file")), "utf8").trim(),
  );
  const envelope = JSON.parse(readFileSync(resolve(arg("quote-file")), "utf8")) as SignedCheckoutPilotQuote;
  const result = await remote.quote(envelope);
  process.stdout.write(JSON.stringify({ status: "QUOTE_ACCEPTED", result }) + "\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "QUOTE_PUSH_FAILED"}\n`);
  process.exitCode = 1;
});
