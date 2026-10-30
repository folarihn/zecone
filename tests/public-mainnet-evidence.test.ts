import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const executionTx = "0f0e944238b7649fa927876875011cc97ea7972eeb8da6ba445898ce3c1def47";

test("public evidence separates the real Zcash execution test from hosted settlement", () => {
  const evidence = readFileSync("app/evidence.ts", "utf8");
  const explorer = readFileSync("app/explorer/page.tsx", "utf8");
  assert.match(evidence, new RegExp(executionTx));
  assert.match(evidence, /finalityThreshold: 10/);
  assert.match(evidence, /confirmationsAtVerification: 11/);
  assert.match(evidence, /status: "FINALIZED"/);
  assert.match(explorer, /It was not created by the hosted checkout and did not trigger a Base payout/);
  assert.match(explorer, /intentionally public evidence, not a live wallet feed/);
});
