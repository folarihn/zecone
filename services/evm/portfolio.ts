import { existsSync } from "node:fs";
import { getAddress, parseAbi, type Address } from "viem";
import { readJson } from "../execution/io.ts";
import { NETWORK_IDS, network } from "./networks.ts";
import { adapterFor } from "./adapter.ts";
import { nftAbi, type MarketConfig } from "../marketplace/purchase.ts";
const erc20 = parseAbi(["function balanceOf(address) view returns(uint256)"]);
export async function portfolio(user: Address) {
  return Promise.all(NETWORK_IDS.map(async id => {
    const n = network(id), a = adapterFor(id);
    const base = { chainId: id, name: n.name, address: user, explorer: n.explorer,
      tokenIndexing: n.tokens.length ? "allowlisted contracts only" : "No ERC-20 contracts configured; arbitrary token indexing unavailable",
      nftIndexing: "Known marketplace inventory only; arbitrary collection indexing unavailable",
      configured: existsSync(n.deploymentFile) };
    try {
      const head = await a.health();
      const wei = await a.client.getBalance({ address: user });
      const tokens = await Promise.all(n.tokens.map(async t => ({ ...t, balance: (await a.client.readContract({ address: t.address, abi: erc20, functionName: "balanceOf", args: [user] })).toString() })));
      const nfts: { address: Address; tokenId: string }[] = [];
      let nftStatus = "unavailable: marketplace not deployed";
      if (base.configured) {
        const c = readJson<MarketConfig>(n.deploymentFile);
        if ((c.chainId ?? 84532) !== id) throw Error("wrong_deployment_chain");
        try {
          for (const tokenId of [1n, 2n, 3n]) {
            const owner = await a.client.readContract({ address: c.nft, abi: nftAbi, functionName: "ownerOf", args: [tokenId] });
            if (getAddress(owner) === getAddress(user)) nfts.push({ address: c.nft, tokenId: tokenId.toString() });
          }
          nftStatus = "verified onchain for known inventory";
        } catch { nftStatus = "unavailable: ownership query failed"; nfts.length = 0; }
      }
      return { ...base, health: "online", checkedAt: new Date().toISOString(), block: head.block, wei: wei.toString(), tokens, nfts, nftStatus };
    } catch { return { ...base, health: "unavailable", checkedAt: new Date().toISOString(), wei: null, tokens: null, nfts: null, nftStatus: "unavailable" }; }
  }));
}
