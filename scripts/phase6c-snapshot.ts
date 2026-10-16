import { historicalSnapshot } from "../services/wallet/snapshot.ts";
import {
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { portfolio } from "../services/evm/portfolio.ts";
import type { WalletSummary } from "../services/wallet/view.ts";
import { parseAbi, getAddress, type Address, type Hex } from "viem";
import { adapterFor } from "../services/evm/adapter.ts";
function writeAtomic(path: string, data: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
const snapshot = historicalSnapshot();
snapshot.dashboard.zcash = JSON.parse(
  execFileSync(
    resolve("target/debug/zecone-zcash-watch.exe"),
    ["--wallet", snapshot.nativeWallet, "snapshot-summary"],
    { encoding: "utf8", windowsHide: true },
  ),
);
snapshot.networks = await portfolio(snapshot.dashboard.address as Address);
const base = (
  snapshot.networks as { chainId: number; wei: string | null; block?: string }[]
).find((n) => n.chainId === 84532);
if (base?.wei && base.block) {
  snapshot.dashboard.base = {
    wei: base.wei,
    block: base.block,
    observedAt: Date.now() / 1000,
  };
  snapshot.dashboard.health.base = "Read-only RPC snapshot";
}
const receiptChecks: unknown[] = [];
for (const c of snapshot.checkouts.filter((c) => c.destinationTx)) {
  const n = (snapshot.networks as { chainId: number; health: string }[]).find(
    (n) => n.chainId === c.chainId,
  );
  if (n?.health !== "online") {
    receiptChecks.push({
      hash: c.destinationTx,
      chainId: c.chainId,
      status: "RPC unavailable",
    });
    continue;
  }
  try {
    const a = adapterFor(c.chainId);
    const receipt = await a.receipt(c.destinationTx as Hex);
    receiptChecks.push({
      hash: c.destinationTx,
      chainId: c.chainId,
      status: receipt?.status ?? "pending or insufficient depth",
      block: receipt?.blockNumber.toString(),
    });
    if (c.kind === "mint" && c.tokenId && receipt?.status === "success") {
      const owner = await a.client.readContract({
        address: snapshot.dashboard.contract as Address,
        abi: parseAbi(["function ownerOf(uint256) view returns(address)"]),
        functionName: "ownerOf",
        args: [BigInt(c.tokenId)],
      });
      if (getAddress(owner) === getAddress(snapshot.dashboard.address))
        snapshot.dashboard.nfts.push({
          tokenId: c.tokenId,
          hash: c.destinationTx!,
          verifiedAt: Date.now() / 1000,
        });
    }
  } catch {
    receiptChecks.push({
      hash: c.destinationTx,
      chainId: c.chainId,
      status: "verification unavailable",
    });
  }
}
const token = JSON.parse(
  readFileSync(".state/swap-84532-confirmed.json", "utf8"),
);
if (
  (snapshot.networks as any[]).find((n) => n.chainId === 84532)?.health ===
  "online"
) {
  try {
    const balance = await adapterFor(84532).client.readContract({
      address: token.token,
      abi: parseAbi(["function balanceOf(address) view returns(uint256)"]),
      functionName: "balanceOf",
      args: [snapshot.dashboard.address as Address],
    });
    (snapshot.networks as any[])
      .find((n) => n.chainId === 84532)
      .tokens.push({
        address: token.token,
        symbol: "ZTEST",
        decimals: 18,
        balance: balance.toString(),
      });
    (snapshot.networks as any[]).find(
      (n) => n.chainId === 84532,
    ).tokenIndexing =
      "Known Phase 4B ZTEST contract only; arbitrary token indexing unavailable";
  } catch {
    snapshot.dashboard.health.base += "; ZTEST balance unavailable";
  }
}
const z = snapshot.dashboard.zcash as WalletSummary;
// Original wallet may have SDK-spendable notes, but remains quarantined. No spend path exists here.
writeAtomic(".state/phase6c/snapshot.json", JSON.stringify(snapshot, null, 2));
writeAtomic(
  "docs/phase6c-evidence/real-data.json",
  JSON.stringify(
    {
      capturedAt: snapshot.capturedAt,
      syncPerformed: false,
      quarantined: true,
      wallet: {
        totalZatoshis: z.totalZatoshis,
        sdkSpendableZatoshis: z.spendableZatoshis,
        tip: z.tip,
        scanned: z.scanned,
        historyCount: z.history.length,
      },
      checkouts: snapshot.checkouts.map((c) => ({
        kind: c.kind,
        state: c.state,
        chainId: c.chainId,
        paymentTx: c.paymentTx,
        destinationTx: c.destinationTx,
      })),
      networks: snapshot.networks,
      receiptChecks,
      liveRefundsEnabled: false,
    },
    null,
    2,
  ),
);
console.log(
  "Read-only snapshot saved; no wallet synchronization, signing or broadcast.",
);
