import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("public wallet route hands off to the loopback gateway and never renders cloud pairing", () => {
  const source = readFileSync("app/wallet/page.tsx", "utf8");
  assert.match(source, /process\.env\.ZECONE_SURFACE !== "wallet"/);
  assert.match(source, /http:\/\/127\.0\.0\.1:3210/);
  assert.match(source, /Never paste a pairing code on zecone\.xyz/);
  assert.match(
    source,
    /if \(process\.env\.ZECONE_SURFACE !== "wallet"\) return <LocalWalletHandoff \/>/,
  );
});

test("public wallet copy distinguishes the verified local Mainnet view", () => {
  const handoff = readFileSync("app/wallet/page.tsx", "utf8");
  const overview = readFileSync("app/wallet-app/page.tsx", "utf8");
  const home = readFileSync("app/page.tsx", "utf8");
  assert.match(handoff, /Verified Mainnet receiving, balance, history and sync views run in the local wallet/);
  assert.match(overview, /Verified local Mainnet view/);
  assert.match(overview, /public website cannot pair with the local wallet/);
  assert.match(home, /verified read-only Mainnet wallet view/);
  assert.doesNotMatch(overview, /current build runs on testnets/);
});
