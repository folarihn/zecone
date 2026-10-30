// Export the raw confirmation segment of ONE detected payment for targeted
// observation (services/operations/candidate-segment-export.ts). Separate from
// scripts/mainnet-block-export.ts, whose historical 10-block finality floor is
// unchanged; this script has no minimum-confirmations flag and cannot export a
// historical range. Read-only: no wallet, key, signing or broadcast.
//
//   node --experimental-transform-types scripts/mainnet-candidate-segment-export.ts \
//     --config <public-probes.json> --output <new dir> --payment-height H \
//     --payment-txid <txid> --payment-confirmations 20
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertExternalPath } from "../services/provisioning/mainnet-watch-backup.ts";
import { assertRawBlockProviders, fetchCorroboratedRawBlock, type RawBlockProvider } from "../services/settlement/mainnet-block-source.ts";
import { exportCandidateSegment, type VerifiedRawBlock } from "../services/operations/candidate-segment-export.ts";

type Provider = { endpoint: string; operator: string };

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw Error(`missing_${name.replaceAll("-", "_")}`);
  return value;
}

export function watchBinary() {
  const name = process.platform === "win32" ? "zecone-zcash-watch.exe" : "zecone-zcash-watch";
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const found = [process.env.ZECONE_WATCH_BIN, join(root, "services", "zcash-watch", "target", "debug", name), join("/usr/local/bin", name)]
    .filter((value): value is string => Boolean(value))
    .find((candidate) => existsSync(candidate));
  if (!found) throw Error("watch_binary_missing");
  return found;
}

/** Local raw-block verification: header hash, Equihash PoW, Merkle root, txid once. */
export function rustVerifyBlock(binary: string, file: string, hash: string, height: number, txid?: string): VerifiedRawBlock {
  const output = execFileSync(
    binary,
    ["--wallet", ".unused", "verify-block", "--block-file", file, "--expected-hash", hash, "--height", String(height), ...(txid ? ["--txid", txid] : [])],
    { encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  const v = JSON.parse(output.trim()) as Record<string, any>;
  return {
    proofOfWork: v.header?.proofOfWork,
    transactionMerkleRootMatchesHeader: v.transactionMerkleRootMatchesHeader,
    transactionIdMatched: v.transactionIdMatched,
    previousBlockHash: v.header?.previousBlockHash,
    target: v.header?.target,
  };
}

async function main() {
  const config = JSON.parse(readFileSync(resolve(argument("config")), "utf8")) as {
    zcash: { lightwalletd: Provider[]; rawBlocks: RawBlockProvider[] };
  };
  const lightwalletd = config.zcash?.lightwalletd;
  if (!Array.isArray(lightwalletd) || lightwalletd.length !== 2) throw Error("zcash_lightwalletd_requires_two_providers");
  if (
    new Set(lightwalletd.map((p) => new URL(p.endpoint).host)).size !== 2 ||
    new Set(lightwalletd.map((p) => p.operator)).size !== 2
  )
    throw Error("zcash_lightwalletd_independence_required");
  assertRawBlockProviders(config.zcash.rawBlocks);
  const output = resolve(argument("output"));
  assertExternalPath(output);
  const binary = watchBinary();
  const manifest = await exportCandidateSegment(
    {
      probe: async (height) => {
        const p = JSON.parse(
          execFileSync(
            binary,
            ["--wallet", ".unused", "probe-mainnet", "--server", lightwalletd[0].endpoint, "--peer", lightwalletd[1].endpoint, "--height", String(height)],
            { encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          ).trim(),
        );
        return { height: p.height, blockHash: String(p.blockHash ?? ""), confirmations: p.confirmations, providerAgreement: p.providerAgreement };
      },
      fetchRaw: (hash) => fetchCorroboratedRawBlock(config.zcash.rawBlocks, hash),
      verifyBlock: async (file, hash, height, txid) => rustVerifyBlock(binary, file, hash, height, txid),
    },
    {
      paymentHeight: Number(argument("payment-height")),
      paymentTxid: argument("payment-txid"),
      paymentConfirmations: Number(argument("payment-confirmations")),
      output,
    },
  );
  console.log(
    JSON.stringify({ status: "PASS", mode: manifest.mode, startHeight: manifest.startHeight, endHeight: manifest.endHeight, agreedTip: manifest.agreedTip, output, executionAllowed: false }),
  );
}

if (process.argv[1] && /mainnet-candidate-segment-export\.ts$/.test(process.argv[1]))
  main().catch((error: unknown) => {
    console.error(error instanceof Error && /^[A-Za-z0-9_]{1,96}$/.test(error.message) ? error.message : "candidate_segment_export_failed");
    process.exitCode = 1;
  });
