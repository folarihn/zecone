// Localhost-only deployment health service. It exposes no wallet, approval,
// signing, execution, refund, configuration, or administrative endpoint.
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { inspectMainnetConfiguration } from "../services/settlement/mainnet-config-validation.ts";
import { MainnetExecutionLease } from "../services/settlement/mainnet-operator-lease.ts";
import {
  MainnetSubmissionJournal,
  pauseMainnetSubmissionJournal,
} from "../services/settlement/mainnet-submitter.ts";

const integer = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw Error("INVALID_INTEGER_CONFIG");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw Error("INVALID_INTEGER_CONFIG");
  return parsed;
};
const finiteCode = (error: unknown) =>
  error instanceof Error && /^[A-Z0-9_]{1,96}$/.test(error.message)
    ? error.message
    : "READ_ONLY_SERVICE_FAILED";
const log = (event: string, detail: Record<string, unknown> = {}) =>
  process.stdout.write(
    JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + "\n",
  );

if (process.env.ZECONE_READ_ONLY !== "1")
  throw Error("READ_ONLY_MODE_REQUIRED");
const state = resolve(process.env.ZECONE_STATE ?? "/var/lib/zecone"),
  config = resolve(process.env.ZECONE_CONFIG ?? "/etc/zecone"),
  host = process.env.ZECONE_HEALTH_HOST ?? "127.0.0.1",
  port = integer(process.env.ZECONE_HEALTH_PORT, 3410),
  minimumFree = BigInt(
    integer(process.env.ZECONE_MIN_FREE_BYTES, 5 * 1024 * 1024 * 1024),
  ),
  marker = join(state, ".zecone-readonly-v1"),
  profilesFile = join(config, "mainnet-profiles.json"),
  readOnlyFile = join(config, "mainnet-readonly.json");

mkdirSync(state, { recursive: true, mode: 0o700 });
if (!existsSync(marker)) {
  const existing = readdirSync(state).filter((name) => name !== ".keep");
  if (existing.length) throw Error("NONEMPTY_UNINITIALIZED_STATE_REFUSED");
  writeFileSync(marker, "ZECONE_VPS_READ_ONLY_V1\n", {
    flag: "wx",
    mode: 0o600,
  });
} else if (readFileSync(marker, "utf8") !== "ZECONE_VPS_READ_ONLY_V1\n") {
  throw Error("INVALID_DEPLOYMENT_STATE_MARKER");
}

const profiles = JSON.parse(readFileSync(profilesFile, "utf8")),
  readOnly = JSON.parse(readFileSync(readOnlyFile, "utf8")),
  configuration = inspectMainnetConfiguration({ profiles, readOnly }),
  lease = new MainnetExecutionLease(join(state, "operator-control.sqlite"));

for (const network of ["base", "solana"]) {
  const journalFile = join(state, `${network}-submissions.sqlite`);
  if (!existsSync(journalFile)) {
    const journal = new MainnetSubmissionJournal(journalFile, {
      perTransaction: "1",
      daily: "1",
      confirmations: 1,
    });
    journal.close();
  }
  pauseMainnetSubmissionJournal(journalFile, "VPS_READ_ONLY_MODE");
}
lease.pause("VPS_READ_ONLY_MODE");

function health() {
  const fs = statfsSync(state),
    freeBytes = BigInt(fs.bavail) * BigInt(fs.bsize),
    disk = freeBytes >= minimumFree ? "PASS" : "LOW_DISK";
  return {
    ok: disk === "PASS",
    mode: "READ_ONLY",
    executionAvailable: false,
    signingAvailable: false,
    broadcastAvailable: false,
    refundsAvailable: false,
    operatorPaused: lease.status().paused,
    configurationStatus: configuration.configurationReady
      ? "CONFIGURED_READ_ONLY"
      : "OPERATOR_SETUP_REQUIRED",
    disk,
    freeBytes: freeBytes.toString(),
  } as const;
}

const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (request.method !== "GET") {
    response
      .writeHead(405)
      .end(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }));
    return;
  }
  if (request.url !== "/healthz" && request.url !== "/readyz") {
    response.writeHead(404).end(JSON.stringify({ error: "NOT_FOUND" }));
    return;
  }
  const body = health();
  response.writeHead(body.ok ? 200 : 503).end(JSON.stringify(body));
});

let closing = false;
const close = (signal: string) => {
  if (closing) return;
  closing = true;
  server.close(() => {
    lease.close();
    log("READ_ONLY_SERVICE_STOPPED", { signal });
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 25_000).unref();
};
process.on("SIGTERM", () => close("SIGTERM"));
process.on("SIGINT", () => close("SIGINT"));
process.on("uncaughtException", (error) => {
  log("READ_ONLY_SERVICE_ERROR", { code: finiteCode(error) });
  close("UNCAUGHT_EXCEPTION");
});
process.on("unhandledRejection", (error) => {
  log("READ_ONLY_SERVICE_ERROR", { code: finiteCode(error) });
  close("UNHANDLED_REJECTION");
});

server.listen(port, host, () =>
  log("READ_ONLY_SERVICE_READY", {
    host,
    port,
    executionAvailable: false,
    configurationStatus: configuration.configurationReady
      ? "CONFIGURED_READ_ONLY"
      : "OPERATOR_SETUP_REQUIRED",
  }),
);
