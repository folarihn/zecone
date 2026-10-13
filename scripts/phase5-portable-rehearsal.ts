// Automated fixture approval ONLY for synthetic notes. Real approval is manual.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
const exec = promisify(execFile),
  base = ["--import", "tsx", "scripts/phase5-portable.ts"];
const call = async (args: string[], timeout = 30000) =>
  JSON.parse(
    (
      await exec(process.execPath, [...base, ...args], {
        windowsHide: true,
        timeout,
        maxBuffer: 16384,
      })
    ).stdout,
  );
async function main() {
  const p = await call(["prepare-simulation"]),
    r = await call(["review", p.session]);
  let rejected = false;
  try {
    await call(["sign", p.session, "wrong-digest"]);
  } catch {
    rejected = true;
  }
  if (!rejected) throw Error("missing_manual_gate");
  const signed = await call(["sign", p.session, r.approvalDigest], 240000),
    before = readFileSync(signed.outputFile);
  await call(["recover", p.session]);
  const after = readFileSync(signed.outputFile);
  if (!before.equals(after)) throw Error("recovery_bytes_changed");
  const reply = JSON.parse(after.toString());
  if (
    Object.keys(reply).sort().join(",") !==
    "liveEnabled,network,rawTransactionHex,refundId,requestDigest,simulatedIsolation,txid,version"
  )
    throw Error("output_leaks_signer_metadata");
  const report = {
    at: new Date().toISOString(),
    syntheticNotes: true,
    simulatedIsolation: true,
    separateProcesses: true,
    automatedFixtureApproval: true,
    wrongApprovalRejected: true,
    exactBytesRecovered: true,
    exportContainsKeysOrPczt: false,
    rawTransactionBytes: reply.rawTransactionHex.length / 2,
    responseHash: createHash("sha256").update(after).digest("hex"),
    separateDeviceValidated: false,
    liveEnabled: false,
    broadcast: false,
  };
  writeFileSync(
    "docs/phase5-evidence/completion-portable-cli.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
main().catch(() => {
  console.error("synthetic_portable_rehearsal_failed");
  process.exitCode = 1;
});
