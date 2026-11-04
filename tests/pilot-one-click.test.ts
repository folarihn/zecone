import assert from "node:assert/strict";
import test from "node:test";
import { waitForOneClickApproval } from "../services/settlement/pilot-one-click.ts";
import type { PilotReview } from "../services/settlement/mainnet-pilot-session.ts";

const now = 2_000_000_000;
const review: PilotReview = {
  action: "SIGN_AND_BROADCAST",
  sessionId: "a".repeat(32),
  chainId: 8453,
  recipient: "0x1111111111111111111111111111111111111111",
  amount: "1000",
  maximumDestinationDebit: "1200",
  feeCap: "200",
  sourceCommitment: "b".repeat(64),
  expires: now + 60,
  termsDigest: "c".repeat(64),
  preparedDigest: "d".repeat(64),
  nonce: 1,
  gas: "21000",
  gasPrice: "1000000",
  blockNumber: "100",
  blockHash: "0x" + "e".repeat(64),
  quoteDigest: "f".repeat(64),
  transactionId: null,
  signedDigest: null,
  sourceShortfall: null,
};

test("localhost one-click review requires its unguessable path and one POST", async () => {
  let listening!: (url: string) => void;
  const urlReady = new Promise<string>((resolve) => (listening = resolve));
  const approval = waitForOneClickApproval(review, "exact-approval", {
    now: () => now,
    open: () => {},
    onListening: listening,
  });
  const url = await urlReady;
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
  const html = await page.text();
  assert.match(html, /SIGN &amp; BROADCAST THIS EXACT TRANSACTION/);
  assert.match(html, /0x1111111111111111111111111111111111111111/);
  assert.match(html, /<dt>Nonce<\/dt><dd>1<\/dd>/);
  assert.match(html, /21000/);
  const bad = await fetch(url, {
    method: "POST",
    headers: { origin: "https://attacker.invalid" },
  });
  assert.equal(bad.status, 403);
  const nullOrigin = await fetch(url, {
    method: "POST",
    headers: { origin: "null" },
  });
  assert.equal(nullOrigin.status, 403);
  const parsed = new URL(url);
  const ok = await fetch(url, {
    method: "POST",
    headers: { origin: parsed.origin },
  });
  assert.equal(ok.status, 200);
  assert.equal(await approval, "exact-approval");
});

test("one-click is unavailable for separate SIGN or expired reviews", async () => {
  await assert.rejects(
    waitForOneClickApproval({ ...review, action: "SIGN" }, "x", {
      now: () => now,
      open: () => {},
    }),
    /ONE_CLICK_ACTION_REQUIRED/,
  );
  await assert.rejects(
    waitForOneClickApproval({ ...review, expires: now }, "x", {
      now: () => now,
      open: () => {},
    }),
    /ONE_CLICK_APPROVAL_EXPIRED/,
  );
});

test("one-click rechecks expiry on POST before granting approval", async () => {
  let current = now,
    listening!: (url: string) => void;
  const urlReady = new Promise<string>((resolve) => (listening = resolve));
  const rejection = assert.rejects(
    waitForOneClickApproval(review, "never-granted", {
      now: () => current,
      open: () => {},
      onListening: listening,
    }),
    /ONE_CLICK_APPROVAL_EXPIRED/,
  );
  const url = await urlReady,
    parsed = new URL(url);
  current = review.expires;
  const response = await fetch(url, {
    method: "POST",
    headers: { origin: parsed.origin },
  });
  assert.equal(response.status, 410);
  await rejection;
});
