// Read-only chain verification plus permission-revoke proof after the one live send.
import { chromium, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
const db = new DatabaseSync(".state/dapps.sqlite", { readOnly: true });
const sent = db
  .prepare(
    "select tx_hash from requests where method='eth_sendTransaction' and tx_hash is not null order by created desc limit 1",
  )
  .get() as { tx_hash: string } | undefined;
const methods = db
  .prepare(
    "select method,state from requests where origin='http://127.0.0.1:4321' order by created",
  )
  .all() as { method: string; state: string }[];
db.close();
if (!sent) throw Error("No actual dApp sendTransaction hash is recorded.");
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http("https://sepolia.base.org", {
    timeout: 20000,
    retryCount: 1,
  }),
});
const [chain, tx, receipt, head] = await Promise.all([
  publicClient.getChainId(),
  publicClient.getTransaction({ hash: sent.tx_hash as `0x${string}` }),
  publicClient.getTransactionReceipt({ hash: sent.tx_hash as `0x${string}` }),
  publicClient.getBlockNumber(),
]);
if (
  chain !== 84532 ||
  receipt.status !== "success" ||
  tx.value !== 0n ||
  tx.from.toLowerCase() !== tx.to?.toLowerCase() ||
  tx.input !== "0x"
)
  throw Error(
    "Recorded transaction did not match the approved Base Sepolia self-transfer.",
  );
const browser = await chromium.launch({ channel: "msedge", headless: true });
let revokePassed = false,
  readAfterRevoke = "";
try {
  const context = await browser.newContext({
      storageState: ".secrets/phase1-browser-session.json",
    }),
    dapp = await context.newPage();
  await dapp.goto("http://127.0.0.1:4321");
  const popupPromise = dapp.waitForEvent("popup");
  await dapp.getByRole("button", { name: "Read account and chain" }).click();
  const popup = await popupPromise;
  await expect(dapp.locator("#output")).toContainText("0x14a34", {
    timeout: 30000,
  });
  readAfterRevoke = await dapp.locator("#output").innerText();
  if (!readAfterRevoke.includes('"accounts": []'))
    throw Error("Revoked origin still received an EVM account.");
  await dapp.getByRole("button", { name: "Try after disconnect" }).click();
  await expect(dapp.locator("#output")).toContainText("4100", {
    timeout: 30000,
  });
  revokePassed = true;
  await popup.close();
} finally {
  await browser.close();
}
if (!revokePassed) throw Error("Origin revocation was not verified.");
const required = [
  "eth_requestAccounts",
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
];
for (const method of required)
  if (!methods.some((r) => r.method === method && r.state === "done"))
    throw Error(`Live request did not complete: ${method}`);
const result = {
  observedAt: new Date().toISOString(),
  dappOrigin: "http://127.0.0.1:4321",
  walletOrigin: "http://127.0.0.1:3210",
  transport: "EIP-1193 explicit popup with EIP-6963-compatible SDK discovery",
  chainId: chain,
  accountReadAfterRevocation: readAfterRevoke,
  transactionHash: sent.tx_hash,
  explorer: `https://sepolia.basescan.org/tx/${sent.tx_hash}`,
  from: tx.from,
  to: tx.to,
  valueWei: tx.value.toString(),
  calldata: tx.input,
  receiptStatus: receipt.status,
  block: receipt.blockNumber.toString(),
  confirmations: (head - receipt.blockNumber + 1n).toString(),
  gasUsed: receipt.gasUsed.toString(),
  effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
  methods: [
    "eth_requestAccounts",
    "eth_accounts",
    "eth_chainId",
    "personal_sign",
    "eth_signTypedData_v4",
    "eth_sendTransaction",
  ],
  originRevoked: true,
  unauthorizedAfterRevoke: "4100",
};
mkdirSync("docs/phase2-evidence", { recursive: true });
writeFileSync(
  "docs/phase2-evidence/live-dapp.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
