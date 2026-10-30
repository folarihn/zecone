// Only this separate local helper reads the user key. Never expose it to Seaport or APIs.
import { resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { keccak256, toHex } from "viem";
import {
  readJson,
  exclusiveJson,
  loadAccount,
} from "../services/execution/io.ts";
import {
  terms,
  typed,
  eq,
  type SeaportConfig,
  type UnsignedSeaport,
  type SeaportIntent,
} from "../services/seaport/protocol.ts";
import { verifyListing } from "../services/seaport/adapter.ts";
async function main() {
  const file = resolve(process.argv[2] ?? ""),
    inside = relative(resolve(".state/seaport-approvals"), file);
  if (
    inside.startsWith("..") ||
    isAbsolute(inside) ||
    !inside.endsWith(".json")
  )
    throw Error("approval_path");
  const a = readJson<{
    approved: boolean;
    expires: number;
    intent: UnsignedSeaport;
  }>(file);
  if (!a.approved || a.expires <= Date.now()) throw Error("expired_approval");
  const c = readJson<SeaportConfig>(".state/seaport-84532-confirmed.json"),
    user = loadAccount(".secrets/user/base-sepolia.json"),
    manifest = readJson<{ zcash: { payer: { address: string } } }>(
      "docs/PUBLIC_WALLETS.json",
    );
  if (
    !eq(c.user, user.address) ||
    a.intent.refundHash !== keccak256(toHex(manifest.zcash.payer.address))
  )
    throw Error("wrong_user_or_refund");
  terms(a.intent, c, Math.floor(Date.now() / 1000));
  await verifyListing(a.intent.listing, c);
  const out = file.replace(/\.json$/, ".signed.json");
  if (existsSync(out)) {
    const { signature, ...old } = readJson<SeaportIntent>(out);
    if (JSON.stringify(old) !== JSON.stringify(a.intent))
      throw Error("approval_conflict");
  } else
    exclusiveJson(out, {
      ...a.intent,
      signature: await user.signTypedData(typed(a.intent)),
    });
  console.log(JSON.stringify({ intentFile: out }));
}
main().catch(() => {
  console.error("Local Seaport approval failed; no success assumed.");
  process.exitCode = 1;
});
