// Supervised operator loop for the restricted pilot (see
// services/operations/operator-supervisor.ts). Keeps either an SSH loopback
// tunnel (Windows operator) or a strictly local direct connection (VPS), the
// read-only watch worker and operator sync heartbeat together; never signs or
// broadcasts.
//
//   npm run operator:supervise -- --config <protected/operator-supervisor.json>
//
// The config holds paths only (no secret values):
//   { "sshTarget": "root@<vps>", "localPort": 14322, "remotePort": 4322,
//     "watchWorkerConfig": "...", "tokenFile": "...", "mirror": "...",
//     "checkoutAddressFile": "...", "walletJournal": "...",
//     "providerEndpointFile": "...", "alertLog": "...", "cycleSeconds": 120 }
// Secrets are read from their files and passed to child processes only through
// the environment; every logged line is scrubbed of them. Alerts are appended
// to `alertLog` as JSON lines (point any external alerting at that file).
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExclusiveFileLock } from "../services/operations/mainnet-watch-worker.ts";
import {
  TelegramAlerts,
  telegramSender,
  validateTelegramChatId,
  validateTelegramToken,
} from "../services/operations/telegram-alerts.ts";
import {
  parseKnownUpgrades,
  parseScheduledUpgrades,
  unsupportedUpgrades,
} from "../services/operations/consensus-upgrades.ts";
import {
  recoverStaleLock,
  type LockOwnerProbe,
} from "../services/operations/stale-lock.ts";
import {
  DEFAULT_SUPERVISOR_POLICY,
  OperatorSupervisor,
  scrubSecrets,
  syncStepResult,
  validateDirectOperatorBaseUrl,
  validateOperatorTransportConfig,
  validateProtectedOperatorCredential,
  validateWalletEvidenceSource,
  workerStepResult,
  type StepResult,
} from "../services/operations/operator-supervisor.ts";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v || v.startsWith("--"))
    throw Error(`MISSING_${name.toUpperCase().replace(/-/g, "_")}`);
  return v;
}

const config = JSON.parse(readFileSync(resolve(arg("config")), "utf8")) as {
  sshTarget?: string;
  directOperatorBaseUrl?: string;
  localPort?: number;
  remotePort?: number;
  watchWorkerConfig: string;
  tokenFile: string;
  mirror: string;
  checkoutAddressFile: string;
  walletJournal?: string;
  remoteWalletEvidence?: boolean;
  submissionJournal?: string;
  pilotJournal?: string;
  pilotSessionsDirectory?: string;
  providerEndpointFile: string;
  alertLog: string;
  cycleSeconds?: number;
  /** Protected file holding only the Telegram bot token. Set with telegramChatId. */
  telegramBotTokenFile?: string;
  telegramChatId?: string | number;
};
const local = config.localPort ?? 14322;
const remote = config.remotePort ?? 4322;
const transport = validateOperatorTransportConfig(config);
const hasSsh = transport === "ssh";
const hasDirect = transport === "direct";
if (hasSsh && !/^[a-z0-9_.-]+@[A-Za-z0-9.-]+$/.test(config.sshTarget!))
  throw Error("SSH_TARGET_INVALID");
const operatorBaseUrl = hasDirect
  ? validateDirectOperatorBaseUrl(config.directOperatorBaseUrl!)
  : `http://127.0.0.1:${local}`;
const tokenPath = resolve(config.tokenFile);
const tokenStat = statSync(tokenPath);
const operatorToken = validateProtectedOperatorCredential(
  tokenStat,
  readFileSync(tokenPath, "utf8"),
);
const worker = JSON.parse(
  readFileSync(resolve(config.watchWorkerConfig), "utf8"),
) as {
  stateDirectory: string;
  walletDirectory: string;
  publicProbeConfig?: string;
};
const stateDir = resolve(worker.stateDirectory);
const secrets = [
  readFileSync(resolve(config.providerEndpointFile), "utf8").trim(),
  operatorToken,
];
const checkoutAddress = readFileSync(
  resolve(config.checkoutAddressFile),
  "utf8",
).trim();
const remoteWalletEvidence = validateWalletEvidenceSource(config) === "remote";
const settlementPaths = [
  config.submissionJournal,
  config.pilotJournal,
  config.pilotSessionsDirectory,
];
if (settlementPaths.some(Boolean) && !settlementPaths.every(Boolean))
  throw Error("INCOMPLETE_SETTLEMENT_JOURNAL_CONFIG");
const now = () => Math.floor(Date.now() / 1000);
const log = (event: Record<string, unknown>) =>
  process.stdout.write(
    scrubSecrets(
      JSON.stringify({ at: new Date().toISOString(), ...event }),
      secrets,
    ) + "\n",
  );
if (Boolean(config.telegramBotTokenFile) !== (config.telegramChatId != null))
  throw Error("TELEGRAM_CONFIG_INCOMPLETE");
let telegram: TelegramAlerts | null = null;
if (config.telegramBotTokenFile) {
  const token = validateTelegramToken(
    readFileSync(resolve(config.telegramBotTokenFile), "utf8"),
  );
  secrets.push(token);
  telegram = new TelegramAlerts(
    telegramSender(token, validateTelegramChatId(config.telegramChatId)),
    { now, log },
  );
}

// Processes that can hold the watch profile. The supervisor itself is excluded.
const RELEVANT =
  /zecone-zcash-watch|mainnet-watch-worker\.ts|operator-sync\.ts/;
const probe: LockOwnerProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  holders() {
    const rows =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
            ],
            {
              encoding: "utf8",
              windowsHide: true,
              maxBuffer: 16 * 1024 * 1024,
            },
          )
        : execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
    return rows
      .split(/\r?\n/)
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
      .filter(
        (m): m is RegExpMatchArray =>
          !!m && RELEVANT.test(m[2]) && Number(m[1]) !== process.pid,
      )
      .map((m) => Number(m[1]));
  },
};

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (done) => {
      const child = spawn(command, args, {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ stdout, stderr, code });
      });
    },
  );
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supervisor = new OperatorSupervisor(
  {
    now,
    log,
    alert: (a) => {
      const line = scrubSecrets(
        JSON.stringify({ at: new Date().toISOString(), ...a }),
        secrets,
      );
      appendFileSync(resolve(config.alertLog), line + "\n", { mode: 0o600 });
      process.stderr.write(line + "\n");
    },
    startTunnel() {
      if (hasDirect) {
        // OperatorSupervisor models connectivity as a tunnel handle. On the VPS
        // the listener is already on loopback, so no socket or child is opened.
        return { exited: new Promise<number | null>(() => {}), stop() {} };
      }
      const child = spawn(
        "ssh",
        [
          "-N",
          "-o",
          "BatchMode=yes",
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "ServerAliveInterval=30",
          "-L",
          `127.0.0.1:${local}:127.0.0.1:${remote}`,
          config.sshTarget!,
        ],
        { windowsHide: true, stdio: "ignore" },
      );
      return {
        exited: new Promise((done) => child.on("exit", (code) => done(code))),
        stop: () => child.kill(),
      };
    },
    recoverLocks: () =>
      [
        join(stateDir, "watch-worker", "worker.lock"),
        join(resolve(worker.walletDirectory), "process.lock"),
      ].map((lock) =>
        recoverStaleLock(
          lock,
          join(stateDir, "recovery-evidence"),
          probe,
          now(),
        ),
      ),
    async runWorkerOnce(): Promise<StepResult> {
      const r = await run(
        process.execPath,
        [
          "--experimental-transform-types",
          join(repo, "scripts", "mainnet-watch-worker.ts"),
          "once",
          "--config",
          resolve(config.watchWorkerConfig),
        ],
        {
          ...process.env,
          ZECONE_READ_ONLY: "1",
          ZECONE_GETBLOCK_URL: secrets[0],
        },
        25 * 60_000,
      );
      return workerStepResult(
        scrubSecrets(r.stdout, secrets),
        scrubSecrets(r.stderr, secrets),
        r.code,
      );
    },
    async runSyncOnce(): Promise<StepResult> {
      const r = await run(
        process.execPath,
        [
          "--experimental-transform-types",
          join(repo, "scripts", "operator-sync.ts"),
          "--remote",
          operatorBaseUrl,
          "--token-file",
          tokenPath,
          "--mirror",
          resolve(config.mirror),
          "--watch-worker-config",
          resolve(config.watchWorkerConfig),
          "--checkout-address",
          checkoutAddress,
          ...(remoteWalletEvidence
            ? ["--remote-wallet-evidence"]
            : ["--wallet-journal", resolve(config.walletJournal!)]),
          ...(settlementPaths.every(Boolean)
            ? [
                "--submission-journal",
                resolve(config.submissionJournal!),
                "--pilot-journal",
                resolve(config.pilotJournal!),
                "--pilot-sessions-dir",
                resolve(config.pilotSessionsDirectory!),
              ]
            : []),
          "--once",
        ],
        // Targeted observation exports a candidate's raw-block segment from the
        // sync step, so it needs the same raw-block endpoint as the worker.
        { ...process.env, ZECONE_GETBLOCK_URL: secrets[0] },
        25 * 60_000,
      );
      return syncStepResult(
        scrubSecrets(r.stdout, secrets),
        scrubSecrets(r.stderr, secrets),
        r.code,
      );
    },
    async health() {
      let heartbeatObservedAt: number | null = null;
      try {
        const r = await fetch(`${operatorBaseUrl}/api/v1/health`, {
          signal: AbortSignal.timeout(10_000),
        });
        const j = (await r.json()) as {
          watcher?: { observedAt?: unknown } | null;
        };
        heartbeatObservedAt = Number.isSafeInteger(j.watcher?.observedAt)
          ? (j.watcher!.observedAt as number)
          : null;
      } catch {
        heartbeatObservedAt = null;
      }
      let scanObservedAt: number | null = null;
      try {
        const c = JSON.parse(
          readFileSync(
            join(stateDir, "watch-worker", "checkpoint.json"),
            "utf8",
          ),
        ) as { scanObservedAt?: unknown };
        scanObservedAt = Number.isSafeInteger(c.scanObservedAt)
          ? (c.scanObservedAt as number)
          : null;
      } catch {
        scanObservedAt = null;
      }
      return { heartbeatObservedAt, scanObservedAt };
    },
    async consensusCheck() {
      // Upgrades compiled into the watch binary vs. those the header node schedules.
      const name =
        process.platform === "win32"
          ? "zecone-zcash-watch.exe"
          : "zecone-zcash-watch";
      const binary = [
        process.env.ZECONE_WATCH_BIN,
        join(repo, "services", "zcash-watch", "target", "debug", name),
        join(repo, "target", "debug", name),
        join("/usr/local/bin", name),
      ].find((p): p is string => Boolean(p) && existsSync(p!));
      if (!binary) throw Error("WATCH_BINARY_MISSING");
      const known = parseKnownUpgrades(
        JSON.parse(
          execFileSync(binary, ["--wallet", ".unused", "consensus-info"], {
            encoding: "utf8",
            timeout: 30_000,
            windowsHide: true,
          }),
        ),
      );
      if (!worker.publicProbeConfig) throw Error("PROBE_CONFIG_MISSING");
      const endpoint = (
        JSON.parse(readFileSync(resolve(worker.publicProbeConfig), "utf8")) as {
          zcash?: { headerRpc?: { endpoint?: string } };
        }
      ).zcash?.headerRpc?.endpoint;
      if (!endpoint || new URL(endpoint).protocol !== "https:")
        throw Error("HEADER_RPC_MISSING");
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getblockchaininfo",
          params: [],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw Error("BLOCKCHAIN_INFO_UNAVAILABLE");
      const { tip, upgrades } = parseScheduledUpgrades(
        ((await response.json()) as { result?: unknown }).result,
      );
      return unsupportedUpgrades(known, upgrades, tip);
    },
  },
  DEFAULT_SUPERVISOR_POLICY,
);

async function main() {
  // `--telegram-test`: send one message and exit. Takes no lock and starts nothing,
  // so it is safe while the real supervisor runs.
  if (process.argv.includes("--telegram-test")) {
    if (!telegram) throw Error("TELEGRAM_NOT_CONFIGURED");
    const failures: Record<string, unknown>[] = [];
    await new TelegramAlerts(
      telegramSender(
        validateTelegramToken(
          readFileSync(resolve(config.telegramBotTokenFile!), "utf8"),
        ),
        validateTelegramChatId(config.telegramChatId),
      ),
      { now, log: (e) => failures.push(e) },
    ).notice(
      "Test message from the operator supervisor. Alerts are connected.",
    );
    if (failures.length)
      throw Error(String(failures[0].code ?? "TELEGRAM_SEND_FAILED"));
    log({ event: "TELEGRAM_TEST_SENT" });
    return;
  }
  // One supervisor at a time; its own lock is recovered only under the same rules.
  const own = join(stateDir, "operator-supervisor.lock");
  const pre = recoverStaleLock(
    own,
    join(stateDir, "recovery-evidence"),
    { alive: probe.alive, holders: () => [] },
    now(),
  );
  if (pre.action === "refused")
    throw Error(`SUPERVISOR_ALREADY_RUNNING_${pre.reason}`);
  const lock = new ExclusiveFileLock(own);
  lock.acquire();
  const cycle = Math.max(75, config.cycleSeconds ?? 120) * 1000;
  let stopping = false;
  const stop = () => {
    stopping = true;
    supervisor.stop();
    lock.release();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await telegram?.notice("Operator supervisor started.");
  while (!stopping) {
    const started = Date.now();
    try {
      const report = await supervisor.cycle();
      await telegram?.onCycle(report.alerts);
    } catch (e) {
      log({
        event: "CYCLE_FAILED",
        code:
          e instanceof Error && /^[A-Z0-9_]{1,96}$/.test(e.message)
            ? e.message
            : "SUPERVISOR_CYCLE_FAILED",
      });
      await telegram?.notice(
        `Supervisor cycle failed (${e instanceof Error && /^[A-Z0-9_]{1,96}$/.test(e.message) ? e.message : "SUPERVISOR_CYCLE_FAILED"}).`,
      );
    }
    await new Promise((r) =>
      setTimeout(r, Math.max(1_000, cycle - (Date.now() - started))),
    );
  }
}

main().catch((e: unknown) => {
  process.stderr.write(
    JSON.stringify({
      error:
        e instanceof Error && /^[A-Z0-9_]{1,96}$/.test(e.message)
          ? e.message
          : "SUPERVISOR_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
});
