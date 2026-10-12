// The user signer alone reads the user EVM key; the settlement service receives only the signed intent.
import { resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { createPublicClient, http, getAddress, keccak256, toHex } from "viem";
import { baseSepolia } from "viem/chains";
import {
  readJson,
  exclusiveJson,
  loadAccount,
} from "../services/execution/io.ts";
import {
  terms,
  purchaseTyped,
  inspectListing,
  type MarketConfig,
  type UnsignedPurchase,
  type PurchaseIntent,
} from "../services/marketplace/purchase.ts";
async function main() {
  const file = resolve(process.argv[2] ?? ""),
    inside = relative(resolve(".state/purchase-approvals"), file);
  if (
    inside.startsWith("..") ||
    isAbsolute(inside) ||
    !inside.endsWith(".json")
  )
    throw Error("approval_path");
  const a = readJson<{
    approved: boolean;
    expires: number;
    intent: UnsignedPurchase;
  }>(file);
  if (a.approved !== true || a.expires <= Date.now())
    throw Error("approval_expired");
  const c = readJson<MarketConfig>(".state/marketplace-confirmed.json"),
    user = loadAccount(".secrets/user/base-sepolia.json"),
    manifest = readJson<{ zcash: { payer: { address: string } } }>(
      "docs/PUBLIC_WALLETS.json",
    );
  terms(a.intent, c, user.address, Math.floor(Date.now() / 1000));
  if (a.intent.refundHash !== keccak256(toHex(manifest.zcash.payer.address)))
    throw Error("refund_destination");
  const client = createPublicClient({
      chain: baseSepolia,
      transport: http("https://sepolia.base.org"),
    }),
    l = await inspectListing(
      client,
      c,
      BigInt(a.intent.listingId),
      user.address,
    );
  if (
    l.price.toString() !== a.intent.price ||
    l.tokenId.toString() !== a.intent.tokenId ||
    getAddress(l.seller) !== getAddress(a.intent.seller) ||
    Number(l.expiry) < a.intent.expiry
  )
    throw Error("listing_changed");
  const out = file.replace(/\.json$/, ".signed.json");
  if (existsSync(out)) {
    const old = readJson<PurchaseIntent>(out);
    const { signature, ...unsigned } = old;
    if (JSON.stringify(unsigned) !== JSON.stringify(a.intent))
      throw Error("signature_conflict");
  } else
    exclusiveJson(out, {
      ...a.intent,
      signature: await user.signTypedData(purchaseTyped(a.intent)),
    });
  console.log(JSON.stringify({ intentFile: out }));
}
main().catch(() => {
  console.error("Local marketplace approval failed; no success is assumed.");
  process.exitCode = 1;
});
