// Fixed public pool accounts only: no wallet, payment, keys, or transaction sends.
import { writeFileSync } from "node:fs";
import {
  CpmmPolicy,
  CPMM,
  POOL,
  CONFIG,
  VAULT_IN,
  VAULT_OUT,
  WSOL,
  OUTPUT,
  OBSERVATION,
  PROGRAM_DATA,
} from "../services/solana/cpmm.ts";
import { Devnet, DEVNET, GENESIS } from "../services/solana/network.ts";
const reports = [];
for (const [label, endpoint] of [
  ["primary", process.env.ZECONE_SOLANA_RPC_PRIMARY ?? DEVNET],
  ["secondary", process.env.ZECONE_SOLANA_RPC_SECONDARY],
]) {
  if (!endpoint) {
    reports.push({ label, configured: false });
    continue;
  }
  for (const [method, params] of [
    ["getGenesisHash", []],
    [
      "getMultipleAccounts",
      [
        [
          POOL,
          CONFIG,
          VAULT_IN,
          VAULT_OUT,
          WSOL,
          OUTPUT,
          OBSERVATION,
          PROGRAM_DATA,
          CPMM,
        ],
        { encoding: "base64", commitment: "confirmed" },
      ],
    ],
  ] as const) {
    const start = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.text();
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* HTML is not logged */
      }
      reports.push({
        label,
        method,
        httpStatus: response.status,
        bytes: Buffer.byteLength(body),
        elapsedMs: Date.now() - start,
        rpcCode: parsed?.error?.code ?? null,
        genesisMatches:
          method === "getGenesisHash" ? parsed?.result === GENESIS : undefined,
        accountCount: parsed?.result?.value?.length,
        slot: parsed?.result?.context?.slot,
      });
    } catch (e) {
      reports.push({
        label,
        method,
        elapsedMs: Date.now() - start,
        error: e instanceof Error ? e.name : "transport",
      });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const net = new Devnet();
let sdkPool: unknown;
try {
  await net.health();
  await new CpmmPolicy(net).pool();
  sdkPool = { validated: true };
} catch (e) {
  sdkPool = {
    validated: false,
    code: (e as { code?: string }).code ?? "REDACTED",
  };
}
const report = {
  at: new Date().toISOString(),
  reports,
  sdkPool,
  diagnostics: net.diagnostics,
  noWalletQueries: true,
  noSigning: true,
  noBroadcast: true,
};
writeFileSync(
  "docs/phase7c-evidence/rpc-diagnosis.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
