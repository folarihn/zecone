import { type Address, keccak256, toHex } from "viem";
import { OpenSeaReadApi, DiscoveryError, slug, limitedText } from "./api.ts";
import {
  addr,
  check,
  integer,
  parseListing,
  checkedFulfillment,
  inspect,
  type InspectedListing,
} from "./inspection.ts";
import { PROTOCOL } from "../seaport/protocol.ts";
export function publicListing(raw: any) {
  check(
    raw?.chain === "ethereum" &&
      typeof raw.order_hash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(raw.order_hash),
    "Unsupported listing network",
  );
  check(
    addr(raw.protocol_address) === PROTOCOL && raw.asset,
    "Unsupported listing protocol",
  );
  return {
    orderHash: raw.order_hash,
    chainId: 1,
    nft: addr(raw.asset.contract),
    tokenId: integer(raw.asset.identifier),
    priceWei: integer(raw.price?.current?.value),
    currency: String(raw.price?.current?.currency).slice(0, 16),
    status: String(raw.status).slice(0, 24),
    seller: addr(raw.protocol_data?.parameters?.offerer),
    validated: false,
  };
}
export function assertFreshPreview(
  p: {
    expiry: number;
    recipient: string;
    orderHash: string;
    executable: boolean;
  },
  recipient: Address,
  orderHash: string,
  now = Math.floor(Date.now() / 1000),
) {
  check(
    p.executable === false &&
      Number.isSafeInteger(p.expiry) &&
      p.expiry > now &&
      p.expiry <= now + 300 &&
      p.recipient === recipient &&
      p.orderHash === orderHash,
    "Preview expired or binding changed",
  );
}
export function collectionFees(
  collection: any,
  name: string,
  listing: InspectedListing,
) {
  check(
    collection?.collection === name &&
      Array.isArray(collection.contracts) &&
      collection.contracts.some(
        (c: any) => c.chain === "ethereum" && addr(c.address) === listing.nft,
      ),
    "Collection contract mismatch",
  );
  check(
    Array.isArray(collection.fees) && collection.fees.length <= 20,
    "Collection fee policy unavailable",
  );
  const fees = collection.fees.map((f: any) => {
    check(
      typeof f.fee === "number" &&
        /^(0|[1-9][0-9]?)(\.[0-9]{1,2})?$/.test(String(f.fee)) &&
        typeof f.required === "boolean",
      "Unsupported collection fee rate",
    );
    const [whole, fraction = ""] = String(f.fee).split(".");
    return {
      recipient: addr(f.recipient),
      bps: BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")),
      required: f.required,
    };
  });
  check(
    new Set(fees.map((f: any) => f.recipient)).size === fees.length,
    "Ambiguous collection fees",
  );
  for (const c of listing.p.consideration.slice(1)) {
    const fee = fees.find((f: any) => f.recipient === c.recipient);
    check(
      fee && (listing.total * fee.bps) / 10000n === BigInt(c.startAmount),
      "Consideration fee disagrees with collection policy",
    );
  }
  for (const fee of fees.filter((f: any) => f.required && f.bps > 0n))
    check(
      listing.p.consideration
        .slice(1)
        .some((c) => c.recipient === fee.recipient),
      "Required collection fee missing",
    );
  return fees.map((f: any) => ({
    recipient: f.recipient,
    basisPoints: String(f.bps),
    required: f.required,
    included: listing.p.consideration
      .slice(1)
      .some((c) => c.recipient === f.recipient),
  }));
}
export class OpenSeaPreviews {
  private busy = false;
  constructor(
    readonly recipient: Address,
    readonly provider: Address,
    readonly api = new OpenSeaReadApi(),
  ) {}
  async catalog(collection: unknown) {
    const name = slug(collection),
      listings = await this.api.listings(name);
    return {
      collection: name,
      source: "Official OpenSea API",
      network: "Ethereum mainnet — read-only",
      listings: listings
        .filter((v: any) => v.chain === "ethereum")
        .map(publicListing),
    };
  }
  async preview(collection: unknown, orderHash: unknown) {
    const name = slug(collection);
    check(
      typeof orderHash === "string" && /^0x[0-9a-f]{64}$/i.test(orderHash),
      "Invalid OpenSea order hash",
    );
    if (this.busy)
      throw new DiscoveryError("An OpenSea inspection is already running");
    this.busy = true;
    try {
      await this.api.supported();
      const raw = await this.api.read(
        `/api/v2/orders/chain/ethereum/protocol/${PROTOCOL}/${orderHash}`,
      );
      // Current live deployment still wraps this response, despite the May
      // migration notice. Accept either documented form, never two identities.
      check(!(raw.order && raw.order_hash), "Ambiguous OpenSea order response");
      const l = parseListing(raw.order ?? raw);
      check(
        l.orderHash.toLowerCase() === orderHash.toLowerCase(),
        "Returned order hash mismatch",
      );
      const collection = await this.api.read(`/api/v2/collections/${name}`);
      const feePolicy = collectionFees(collection, name, l);
      const metadata = await this.api.read(
        `/api/v2/chain/ethereum/contract/${l.nft}/nfts/${l.tokenId}`,
      );
      const nft = metadata.nft;
      check(
        nft &&
          addr(nft.contract) === l.nft &&
          integer(nft.identifier) === l.tokenId &&
          nft.collection === name &&
          nft.token_standard === "erc721",
        "NFT metadata does not match listing",
      );
      const f = await this.api.read("/api/v2/listings/fulfillment_data", {
        listing: {
          chain: "ethereum",
          hash: l.orderHash,
          protocol_address: PROTOCOL,
        },
        fulfiller: { address: this.provider },
        recipient: this.recipient,
        units_to_fill: 1,
        include_optional_creator_fees: false,
      });
      const prepared = checkedFulfillment(f, l, this.recipient);
      const result = await inspect(l, prepared, this.recipient, this.provider);
      const image = await safeImage(nft.display_image_url || nft.image_url);
      const preview = {
        ...result,
        source: "Official OpenSea API",
        collection: name,
        feePolicy,
        name:
          typeof nft.name === "string"
            ? nft.name.slice(0, 160)
            : `NFT #${l.tokenId}`,
        image,
        imageUnavailable: !image,
        openSeaUrl: `https://opensea.io/item/ethereum/${l.nft}/${l.tokenId}`,
      };
      assertFreshPreview(preview, this.recipient, l.orderHash);
      // Review binding only, never accepted as a signed execution intent.
      return {
        ...preview,
        bindingHash: keccak256(toHex(JSON.stringify(preview))),
      };
    } finally {
      this.busy = false;
    }
  }
}
export async function safeImage(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      !["i.seadn.io", "i2.seadn.io", "i2c.seadn.io"].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.port
    )
      return null;
    const r = await fetch(u, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { accept: "image/png,image/jpeg,image/webp" },
    });
    const mime = r.headers.get("content-type")?.split(";")[0];
    if (
      !r.ok ||
      !mime ||
      !["image/png", "image/jpeg", "image/webp"].includes(mime)
    )
      return null;
    const bytes = await limitedText(r, 750000);
    const valid =
      mime === "image/png"
        ? bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
        : mime === "image/jpeg"
          ? bytes.subarray(0, 3).toString("hex") === "ffd8ff"
          : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP";
    return valid ? `data:${mime};base64,${bytes.toString("base64")}` : null;
  } catch {
    return null;
  }
}
