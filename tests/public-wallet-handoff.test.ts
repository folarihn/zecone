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
