// Integration test for the merchant payment API: spawns the server on a temp
// database and exercises create, idempotency, retrieve, quote, and the
// loopback-only demo advance path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEMO_SECRET = "test-demo-secret";
const KEY = `zk_${"0".repeat(24)}_${DEMO_SECRET}`;

function startServer(): Promise<{ proc: ChildProcess; port: number; db: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "zecone-api-"));
  const db = join(dir, "p.sqlite");
  const port = 4300 + Math.floor(Math.random() * 1000);
  const proc = spawn("node", ["--import", "tsx", "services/payments/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ZECONE_PAYMENTS_PORT: String(port),
      ZECONE_PAYMENTS_DB: db,
      ZECONE_DEMO_SECRET: DEMO_SECRET,
      ZECONE_DEMO_OBSERVER: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("server did not start")), 15_000);
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`${base}/api/v1/health`);
        if (r.ok) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve({ proc, port, db, dir });
        }
      } catch {
        /* not ready */
      }
    }, 250);
  });
}

async function stop(proc: ChildProcess, dir: string) {
  proc.kill();
  await new Promise((r) => proc.once("exit", () => r(null)));
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

test("payment API process: create -> idempotent -> retrieve; no public completion route", async () => {
  const { proc, port, dir } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  try {
    // health
    const health = await fetch(`${base}/api/v1/health`).then((r) => r.json());
    assert.equal(health.status, "ok");
    assert.equal(health.livePayoutEnabled, false);

    // unauthorized
    const noAuth = await fetch(`${base}/api/v1/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUsd: "1.00", payoutChain: "base", recipient: "0x4b5750d7675f14eB844B74477015302Bf31AE2dB" }),
    });
    assert.equal(noAuth.status, 401);

    // create
    const body = { amountUsd: "1.00", payoutChain: "base", recipient: "0x4b5750d7675f14eB844B74477015302Bf31AE2dB", metadata: { orderId: "demo-001" } };
    const created = await fetch(`${base}/api/v1/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, "Idempotency-Key": "order-1" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    assert.equal(created.payment.state, "AWAITING_PAYMENT");
    assert.equal(created.payment.zcashAddress, null); // simulated: no payable address
    assert.equal(created.payment.simulated, true);
    assert.equal(created.payment.quote.zecAmount, "0.02");

    // idempotent replay
    const replay = await fetch(`${base}/api/v1/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, "Idempotency-Key": "order-1" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    assert.equal(replay.payment.id, created.payment.id);
    assert.equal(replay.idempotent, true);

    // retrieve
    const retrieved = await fetch(`${base}/api/v1/payments/${created.payment.id}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    }).then((r) => r.json());
    assert.equal(retrieved.payment.state, "AWAITING_PAYMENT");

    // The old unauthenticated "demo advance" route is gone: completion in demo
    // mode is driven only by the server-side observer (or an operator token).
    const advance = await fetch(`${base}/api/v1/demo/${created.payment.id}`, { method: "POST" });
    assert.equal(advance.status, 404);

    // events reflect the lifecycle so far
    const events = await fetch(`${base}/api/v1/payments/${created.payment.id}/events`, {
      headers: { Authorization: `Bearer ${KEY}` },
    }).then((r) => r.json());
    assert.ok(events.events.some((e: { type: string }) => e.type === "payment.awaiting_payment"));
  } finally {
    await stop(proc, dir);
  }
});

test("payment API: invalid recipient is rejected", async () => {
  const { proc, port, dir } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/api/v1/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ amountUsd: "1.00", payoutChain: "base", recipient: "0xnotanaddress" }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error.code, "invalid_recipient");
  } finally {
    await stop(proc, dir);
  }
});

test("payment API process refuses to start in live mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zecone-live-"));
  try {
    const proc = spawn("node", ["--import", "tsx", "services/payments/server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, ZECONE_PAYMENTS_MODE: "live", ZECONE_PAYMENTS_DB: join(dir, "p.sqlite"), ZECONE_PAYMENTS_PORT: "0" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr!.on("data", (c) => (stderr += c));
    const code = await new Promise((r) => proc.once("exit", r));
    assert.equal(code, 1);
    assert.match(stderr, /live mode is disabled/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
