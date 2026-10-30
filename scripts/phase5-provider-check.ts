import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyProviderAgreement } from "../services/signer/chain-agreement.ts";
const exec = promisify(execFile),
  height = 4498450;
const providers = [
  { operator: "zec.rocks", url: "https://testnet.zec.rocks:443" },
  {
    operator: "Electric Coin Company",
    url: "https://lightwalletd.testnet.electriccoin.co:9067",
  },
];
const outcomes: {
  operator: string;
  url: string;
  status: string;
  evidence?: any;
}[] = [];
for (const p of providers) {
  try {
    const { stdout } = await exec(
      resolve(
        `target/debug/zecone-zcash-watch${process.platform === "win32" ? ".exe" : ""}`,
      ),
      [
        "--wallet",
        resolve(".state/provider-probe-unused"),
        "probe-provider",
        "--server",
        p.url,
        "--height",
        String(height),
      ],
      { windowsHide: true, timeout: 45000, maxBuffer: 4096 },
    );
    outcomes.push({ ...p, status: "verified", evidence: JSON.parse(stdout) });
  } catch {
    outcomes.push({ ...p, status: "unavailable_or_rejected" });
  }
}
const a = outcomes[0]?.evidence,
  b = outcomes[1]?.evidence;
let agreement;
try {
  if (a && b)
    agreement = verifyProviderAgreement(a, b, Math.floor(Date.now() / 1000));
} catch {}
const report = {
  at: new Date().toISOString(),
  height,
  readOnly: true,
  outcomes,
  independentProviderAgreement: !!agreement,
  fullConsensusValidation: false,
  relevantPaymentInclusion: "not-tested-unfunded-wallet",
  liveRefundsEnabled: false,
};
writeFileSync(
  "docs/phase5-evidence/completion-provider-check.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
