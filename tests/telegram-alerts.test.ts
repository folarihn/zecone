// Telegram delivery for supervisor alerts: one message per condition, periodic
// reminders, a resolved notice, and failures that never escape. Synthetic only:
// the sender is a fake; no network, tokens or funds.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TelegramAlerts,
  telegramSender,
  validateTelegramChatId,
  validateTelegramToken,
} from "../services/operations/telegram-alerts.ts";
import type { SupervisorAlert } from "../services/operations/operator-supervisor.ts";

const scanStale: SupervisorAlert = {
  alert: "SCAN_STALE",
  ageSeconds: 4000,
  limitSeconds: 1800,
};
const heartbeat: SupervisorAlert = {
  alert: "HEARTBEAT_STALE",
  ageSeconds: 1000,
  limitSeconds: 900,
};

function harness(send?: (text: string) => Promise<void>) {
  let now = 1_800_000_000;
  const sent: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const t = new TelegramAlerts(
    send ??
      (async (text) => {
        sent.push(text);
      }),
    { now: () => now, log: (e) => logs.push(e), remindSeconds: 3600 },
  );
  return { t, sent, logs, advance: (s: number) => (now += s) };
}

test("telegram: a lasting alert is sent once, reminded, then resolved", async () => {
  const h = harness();
  await h.t.onCycle([scanStale]);
  h.advance(120);
  await h.t.onCycle([scanStale]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^ZecOne: ALERT Wallet scan stale/);
  h.advance(3600);
  await h.t.onCycle([scanStale, heartbeat]);
  assert.equal(h.sent.length, 3);
  assert.match(h.sent[1], /STILL Wallet scan stale/);
  assert.match(h.sent[2], /ALERT Heartbeat stale .*Real checkouts are paused/);
  await h.t.onCycle([heartbeat]);
  assert.equal(h.sent.at(-1), "ZecOne: RESOLVED SCAN_STALE");
  await h.t.onCycle([]);
  assert.equal(h.sent.at(-1), "ZecOne: RESOLVED HEARTBEAT_STALE");
  assert.equal(h.sent.length, 5);
});

test("telegram: distinct stages are separate conditions; one-shot events never resolve", async () => {
  const h = harness();
  const failing = (stage: "sync" | "probe"): SupervisorAlert => ({
    alert: "STAGE_FAILING",
    stage,
    code: "X",
    consecutive: 3,
  });
  await h.t.onCycle([failing("sync"), failing("probe")]);
  assert.equal(h.sent.length, 2);
  await h.t.onCycle([
    { alert: "LOCK_RECOVERED", lock: "w.lock", pid: 1, evidence: "e" },
  ]);
  assert.ok(h.sent.some((s) => /Abandoned watch lock recovered/.test(s)));
  assert.ok(h.sent.some((s) => s.endsWith("RESOLVED STAGE_FAILING")));
  const count = h.sent.length;
  await h.t.onCycle([]);
  assert.equal(h.sent.length, count, "LOCK_RECOVERED has no resolved message");
});

test("telegram: upcoming network upgrades name the blocks remaining", async () => {
  const h = harness();
  await h.t.onCycle([
    {
      alert: "NETWORK_UPGRADE_UNSUPPORTED",
      name: "NU8",
      branchId: "deadbeef",
      activationHeight: 3_600_000,
      blocksUntilActivation: 5000,
      reason: "UNKNOWN_BRANCH",
      knownActivationHeight: null,
    },
  ]);
  assert.match(h.sent[0], /NU8 activates in 5000 blocks at 3600000/);
});

test("telegram: send failures are logged with a code and never thrown", async () => {
  const h = harness(async () => {
    throw Error("TELEGRAM_HTTP_401");
  });
  await h.t.onCycle([scanStale]);
  await h.t.notice("hello");
  assert.deepEqual(
    h.logs.map((l) => l.code),
    ["TELEGRAM_HTTP_401", "TELEGRAM_HTTP_401"],
  );
});

test("telegram: repeated cycle failures are bounded and resolve after recovery", async () => {
  const h = harness();
  await h.t.onCycleFailure("PROCESS_TABLE_UNAVAILABLE");
  h.advance(120);
  await h.t.onCycleFailure("PROCESS_TABLE_UNAVAILABLE");
  assert.equal(h.sent.length, 1, "must not notify on every supervisor cycle");
  assert.match(h.sent[0], /ALERT Supervisor cycle failed/);

  h.advance(3600);
  await h.t.onCycleFailure("PROCESS_TABLE_UNAVAILABLE");
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /STILL Supervisor cycle failed/);

  await h.t.onCycle([]);
  assert.equal(h.sent[2], "ZecOne: RESOLVED SUPERVISOR_CYCLE_FAILED");
});

test("telegram: sender posts to the Bot API only; token and chat id are validated", async () => {
  const token = "123456789:" + "A".repeat(35);
  const calls: { url: string; body: unknown }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await telegramSender(token, "-1001234", fake)("hi");
  assert.equal(
    calls[0].url,
    `https://api.telegram.org/bot${token}/sendMessage`,
  );
  assert.deepEqual(calls[0].body, {
    chat_id: "-1001234",
    text: "hi",
    disable_web_page_preview: true,
  });
  const failing = (async () =>
    new Response("{}", { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    telegramSender(token, "1", failing)("x"),
    /TELEGRAM_HTTP_403/,
  );
  assert.equal(validateTelegramToken(` ${token}\n`), token);
  for (const bad of [
    "",
    "abc",
    "123:short",
    "123456789:" + "A".repeat(35) + "!",
  ])
    assert.throws(() => validateTelegramToken(bad), /TELEGRAM_TOKEN_INVALID/);
  assert.equal(validateTelegramChatId(-1001234), "-1001234");
  assert.throws(
    () => validateTelegramChatId("@channel"),
    /TELEGRAM_CHAT_ID_INVALID/,
  );
});
