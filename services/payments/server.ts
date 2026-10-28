// ZecOne Merchant Payment API — standalone HTTP listener.
//
// This process NEVER loads spending keys, relayer keys, or operator signing
// credentials. Live payout and Zcash broadcast are disabled and cannot be
// enabled from this surface (see api.ts). Configuration: .env.example.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configFromEnv, createPaymentsApp } from "./api.ts";
import { watcherFromWorkerConfig } from "./watch-bridge.ts";

const PORT = Number(process.env.ZECONE_PAYMENTS_PORT ?? 4321);
const HOST = process.env.ZECONE_PAYMENTS_HOST ?? "127.0.0.1";

const config = configFromEnv();
if (config.mode !== "demo" && config.mode !== "monitor") {
  console.error("[zecone-payments] refusing to start: live mode is disabled in this build (ZECONE_PAYMENTS_MODE must be demo or monitor).");
  process.exit(1);
}
if (config.mode === "monitor") {
  // Read-only mainnet monitoring: real deposits are observed, nothing is ever paid out.
  const ack = process.env.ZECONE_MONITOR_AUTHORIZED === "I_UNDERSTAND_NO_AUTOMATIC_PAYOUT";
  const workerConfig = process.env.ZECONE_WATCH_WORKER_CONFIG;
  const operatorFed = process.env.ZECONE_WATCH_SOURCE === "operator";
  if (operatorFed) {
    // Restricted pilot on a public host: no viewing key or wallet here. The operator
    // machine pushes verified watcher results through the loopback operator listener.
    if (!ack || !config.pilot || !process.env.ZECONE_OPERATOR_PORT) {
      console.error(
        "[zecone-payments] operator-fed monitor mode needs ZECONE_MONITOR_AUTHORIZED, ZECONE_PILOT_MERCHANT_OWNER (+ relayer, payout limit, Base RPCs), ZECONE_OPERATOR_TOKEN and ZECONE_OPERATOR_PORT.",
      );
      process.exit(1);
    }
    config.monitor = {
      authorized: true,
      source: "operator",
      minimumConfirmations: 20,
      intervalSeconds: 120,
      maxSnapshotAgeSeconds: Number(process.env.ZECONE_WATCH_MAX_AGE_SECONDS ?? 900),
    };
  } else if (!ack || !workerConfig) {
    console.error(
      "[zecone-payments] monitor mode needs ZECONE_MONITOR_AUTHORIZED=I_UNDERSTAND_NO_AUTOMATIC_PAYOUT and ZECONE_WATCH_WORKER_CONFIG (the mainnet watch worker config).",
    );
    process.exit(1);
  }
  if (!operatorFed) try {
    const w = watcherFromWorkerConfig(workerConfig!, config.checkoutAddress);
    config.monitor = {
      authorized: true,
      source: w.source,
      lock: w.lock,
      minimumConfirmations: w.minimumConfirmations,
      intervalSeconds: Math.max(60, Number(process.env.ZECONE_WATCH_INTERVAL_SECONDS ?? 120)),
      maxSnapshotAgeSeconds: Number(process.env.ZECONE_WATCH_MAX_AGE_SECONDS ?? 900),
    };
  } catch (e) {
    console.error(`[zecone-payments] watcher configuration invalid: ${(e as Error).message}`);
    process.exit(1);
  }
}
mkdirSync(dirname(config.dbPath), { recursive: true });
const app = createPaymentsApp(config);
app.start();

const server = createServer((req, res) => void app.handle(req, res));
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(
    e.code === "EADDRINUSE"
      ? `[zecone-payments] port ${PORT} on ${HOST} is already in use. Stop the other process or set ZECONE_PAYMENTS_PORT (and ZECONE_BASE_URL for the web app and examples).`
      : `[zecone-payments] cannot listen on ${HOST}:${PORT}: ${e.message}`,
  );
  app.close();
  process.exit(1);
});
// Operator listener: loopback only and never proxied by the public Nginx site.
// Reached from the operator machine through an SSH tunnel.
const OPERATOR_PORT = Number(process.env.ZECONE_OPERATOR_PORT ?? 0);
const operatorServer = OPERATOR_PORT && config.pilot ? createServer((req, res) => void app.handleOperator(req, res)) : null;
if (operatorServer) {
  if (OPERATOR_PORT === PORT) {
    console.error("[zecone-payments] ZECONE_OPERATOR_PORT must differ from the public port");
    process.exit(1);
  }
  operatorServer.listen(OPERATOR_PORT, "127.0.0.1", () =>
    console.log(`[zecone-payments] operator listener http://127.0.0.1:${OPERATOR_PORT} (loopback only)`),
  );
}
server.listen(PORT, HOST, () => {
  console.log(
    `[zecone-payments] http://${HOST}:${PORT} (${config.mode} mode; no keys or broadcast in this process${config.pilot ? "; RESTRICTED PILOT: real orders for one approved merchant, operator-approved settlement" : config.mode === "monitor" ? "; real deposits observed read-only" : "; simulated checkouts"})`,
  );
  console.log(`[zecone-payments] hosted checkout base: ${config.publicCheckoutBaseUrl}`);
  console.log(
    `[zecone-payments] demo observer: ${config.demoObserver.enabled ? `replays recorded mainnet evidence ${config.demoObserver.startAfterSeconds}s after a demo payment is created` : "disabled"}`,
  );
  if (app.demoApiKey && HOST === "127.0.0.1")
    console.log(`[zecone-payments] demo storefront key (loopback only, demo): ${app.demoApiKey}`);
  if (!config.operatorToken) console.log("[zecone-payments] operator endpoints disabled (ZECONE_OPERATOR_TOKEN unset)");
});

const shutdown = () => {
  server.close();
  operatorServer?.close();
  app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
