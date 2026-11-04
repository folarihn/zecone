import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const executionTx =
  "0f0e944238b7649fa927876875011cc97ea7972eeb8da6ba445898ce3c1def47";
const completedPaymentTx =
  "cad535249a27d4503f54ab23811fa9ea3ea4f40a1eb916231e5d267f9a032163";
const completedPayoutTx =
  "0x8ab550cd3419009fc4086260104d5e0a2ea8f2008b03d35cb087c5210f321289";

test("public evidence separates the real Zcash execution test from hosted settlement", () => {
  const evidence = readFileSync("app/evidence.ts", "utf8");
  const explorer = readFileSync("app/explorer/page.tsx", "utf8");
  assert.match(evidence, new RegExp(executionTx));
  assert.match(evidence, /finalityThreshold: 10/);
  assert.match(evidence, /confirmationsAtVerification: 11/);
  assert.match(evidence, /status: "FINALIZED"/);
  assert.match(
    explorer,
    /It was not created by the hosted checkout and did not trigger a Base payout/,
  );
  assert.match(
    explorer,
    /intentionally public evidence, not a live\s+wallet feed/,
  );
});

test("public evidence records the completed restricted live checkout without claiming public settlement", () => {
  const readme = readFileSync("README.md", "utf8");
  const evidence = readFileSync("app/evidence.ts", "utf8");
  const explorer = readFileSync("app/explorer/page.tsx", "utf8");
  assert.match(evidence, new RegExp(completedPaymentTx));
  assert.match(evidence, new RegExp(completedPayoutTx));
  assert.match(evidence, /wei: "4424465524565"/);
  assert.match(evidence, /status: "COMPLETED"/);
  assert.match(explorer, /completed restricted\s+live checkout/);
  assert.match(readme, /restricted operator-controlled path, not unrestricted/);
});
