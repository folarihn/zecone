// Independent, read-only dApp server. This process never loads wallet keys.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  http,
  encodeFunctionData,
  getAddress,
  toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { readJson } from "../services/execution/io.ts";
import {
  marketAbi,
  nftAbi,
  type MarketConfig,
} from "../services/marketplace/purchase.ts";
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org"),
});
createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  );
  const json = (v: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)),
    );
  };
  if (req.headers.host !== "127.0.0.1:4322" || req.method !== "GET")
    return json({ error: "Loopback GET only" }, 403);
  const u = new URL(req.url!, "http://127.0.0.1:4322");
  try {
    const files: Record<string, [string, string]> = {
      "/": ["marketplace/index.html", "text/html"],
      "/app.js": ["marketplace/app.js", "text/javascript"],
      "/style.css": ["marketplace/style.css", "text/css"],
      "/zecone-provider.js": ["public/zecone-provider.js", "text/javascript"],
    };
    if (files[u.pathname]) {
      const [file, type] = files[u.pathname];
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
      res.end(await readFile(file));
      return;
    }
    if (!["/api/listings", "/api/purchase"].includes(u.pathname))
      return json({ error: "Not found" }, 404);
    if ((await client.getChainId()) !== 84532) throw Error("wrong chain");
    const c = readJson<MarketConfig>(".state/marketplace-confirmed.json");
    if (u.pathname === "/api/listings") {
      const next = await client.readContract({
          address: c.marketplace,
          abi: marketAbi,
          functionName: "nextId",
        }),
        listings = [];
      for (let id = 1n; id < next && id <= 20n; id++) {
        const l = await client.readContract({
          address: c.marketplace,
          abi: marketAbi,
          functionName: "getListing",
          args: [id],
        });
        const owner = await client.readContract({
          address: l.nft,
          abi: nftAbi,
          functionName: "ownerOf",
          args: [l.tokenId],
        });
        listings.push({ id, ...l, owner });
      }
      return json({ chainId: 84532, marketplace: c.marketplace, listings });
    }
    const id = BigInt(u.searchParams.get("listing") || "0"),
      recipient = getAddress(u.searchParams.get("recipient") || "");
    const l = await client.readContract({
      address: c.marketplace,
      abi: marketAbi,
      functionName: "getListing",
      args: [id],
    });
    if (!l.active || BigInt(l.expiry) <= (await client.getBlock()).timestamp)
      throw Error("inactive listing");
    return json({
      from: recipient,
      to: c.marketplace,
      chainId: "0x14a34",
      value: toHex(l.price),
      data: encodeFunctionData({
        abi: marketAbi,
        functionName: "buy",
        args: [id, recipient],
      }),
    });
  } catch {
    return json(
      {
        error:
          "Marketplace unavailable, unconfigured, or listing invalid. No transaction was sent.",
      },
      503,
    );
  }
}).listen(4322, "127.0.0.1", () =>
  console.log("Sepolia Studio: http://127.0.0.1:4322 (Base Sepolia only)"),
);
