// Public metadata only: no wallet address, viewing key, spending key or transaction data.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { verifyProviderAgreement } from "../services/signer/chain-agreement.ts";
const exec = promisify(execFile),
  directory = "docs/phase51-evidence",
  height = 4498492;
const providers = [
  {
    operator: "zec.rocks",
    url: "https://testnet.zec.rocks:443",
    documentation: "https://hosh.zec.rocks/zec/testnet.zec.rocks%3A443",
  },
  {
    operator: "ECC",
    url: "https://lightwalletd.testnet.electriccoin.co:9067",
    documentation:
      "https://docs.rs/zingolib/latest/src/zingolib/config.rs.html",
  },
  {
    operator: "ZEC.PRO",
    url: "https://lwd.testnet.zec.pro:443",
    documentation: "https://zec.pro/",
  },
];
async function main() {
  mkdirSync(directory, { recursive: true });
  const outcomes = await Promise.all(
    providers.map(async (p) => {
      try {
        const { stdout } = await exec(
          resolve("target/debug/zecone-zcash-watch.exe"),
          [
            "--wallet",
            resolve(".state/phase51-probe-unused"),
            "probe-provider",
            "--server",
            p.url,
            "--height",
            String(height),
          ],
          { windowsHide: true, timeout: 45000, maxBuffer: 8192 },
        );
        return { ...p, status: "verified", evidence: JSON.parse(stdout) };
      } catch (e: any) {
        const error = String(e.stderr ?? "");
        return {
          ...p,
          status: "unavailable-or-rejected",
          evidence: undefined,
          reason: error.includes("wrong_network")
            ? "wrong-network"
            : error.includes("unsupported_consensus")
              ? "unsupported-consensus"
              : error.includes("ironwood")
                ? "ironwood-evidence-unavailable"
                : e.killed
                  ? "timeout"
                  : "connection-or-protocol-failure",
        };
      }
    }),
  );
  const agreements = [];
  for (let i = 0; i < outcomes.length; i++)
    for (let j = i + 1; j < outcomes.length; j++) {
      const a = outcomes[i],
        b = outcomes[j];
      if (a.evidence && b.evidence)
        try {
          agreements.push({
            operators: [a.operator, b.operator],
            ...verifyProviderAgreement(
              a.evidence,
              b.evidence,
              Math.floor(Date.now() / 1000),
            ),
          });
        } catch {}
    }
  const report = {
    at: new Date().toISOString(),
    height,
    outcomes,
    agreements,
    independentProviderAgreement: agreements.length > 0,
    operatorIndependence:
      "Distinct published operator identities only; upstream infrastructure independence is not audited",
    fullConsensusValidation: false,
    relevantTransactionInclusion: "not-testable-without-original-txid",
    walletScanAgreement: "not-established-across-providers",
    liveRefundsEnabled: false,
  };
  const file = join(
    directory,
    `providers-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ file, ...report }, null, 2));
}
main().catch(() => {
  console.error("phase51_public_provider_probe_failed");
  process.exitCode = 1;
});
