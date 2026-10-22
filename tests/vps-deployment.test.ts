// Disposable state and localhost health checks only. No provider, key, or transaction access.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function start(root: string, port: number) {
  const child = spawn(
    process.execPath,
    ["--experimental-transform-types", "scripts/vps-readonly-service.ts"],
    {
      cwd: resolve("."),
      windowsHide: true,
      env: {
        ...process.env,
        ZECONE_READ_ONLY: "1",
        ZECONE_STATE: join(root, "state"),
        ZECONE_CONFIG: join(root, "config"),
        ZECONE_HEALTH_HOST: "127.0.0.1",
        ZECONE_HEALTH_PORT: String(port),
        ZECONE_MIN_FREE_BYTES: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout!.on("data", (value) => (output += String(value)));
  child.stderr!.on("data", (value) => (output += String(value)));
  for (let i = 0; i < 400; i++) {
    if (output.includes("READ_ONLY_SERVICE_READY")) return child;
    if (child.exitCode !== null) throw Error(`service exited: ${output}`);
    await new Promise((done) => setTimeout(done, 50));
  }
  child.kill("SIGTERM");
  throw Error(`service startup timeout: ${output}`);
}

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await once(child, "exit");
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

test(
  "VPS read-only service persists fail-closed controls across restart and exposes health only",
  { timeout: 60_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "zecone-vps-")),
      config = join(root, "config"),
      state = join(root, "state"),
      port = await freePort();
    mkdirSync(config, { recursive: true });
    mkdirSync(join(state, "lost+found"), { recursive: true });
    writeFileSync(
      join(state, ".zecone-filesystem-uuid"),
      "ZECONE_STATE_FS_UUID=11111111-2222-3333-4444-555555555555\n",
    );
    copyFileSync(
      "deploy/config/mainnet-profiles.json",
      join(config, "mainnet-profiles.json"),
    );
    copyFileSync(
      "deploy/config/mainnet-readonly.json",
      join(config, "mainnet-readonly.json"),
    );
    let child = await start(root, port);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`),
        health = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(
        {
          mode: health.mode,
          executionAvailable: health.executionAvailable,
          signingAvailable: health.signingAvailable,
          broadcastAvailable: health.broadcastAvailable,
          refundsAvailable: health.refundsAvailable,
          operatorPaused: health.operatorPaused,
        },
        {
          mode: "READ_ONLY",
          executionAvailable: false,
          signingAvailable: false,
          broadcastAvailable: false,
          refundsAvailable: false,
          operatorPaused: true,
        },
      );
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}/healthz`, { method: "POST" }))
          .status,
        405,
      );
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}/operator`)).status,
        404,
      );
    } finally {
      await stop(child);
    }
    assert.ok(existsSync(join(state, "operator-control.sqlite")));
    assert.ok(existsSync(join(state, "base-submissions.sqlite")));
    assert.ok(existsSync(join(state, "solana-submissions.sqlite")));
    child = await start(root, port);
    try {
      const health = await (
        await fetch(`http://127.0.0.1:${port}/readyz`)
      ).json();
      assert.equal(health.operatorPaused, true);
      assert.equal(health.executionAvailable, false);
    } finally {
      await stop(child);
    }
  },
);

test("container package has no key mount, public port, or executable startup", () => {
  const compose = readFileSync("deploy/compose.yaml", "utf8"),
    dockerfile = readFileSync("deploy/Dockerfile", "utf8"),
    operator = readFileSync("deploy/zecone-vps", "utf8"),
    unit = readFileSync("deploy/systemd/zecone-docker.service", "utf8");
  assert.match(compose, /network_mode: host/);
  assert.doesNotMatch(compose, /init: true/);
  assert.match(compose, /ZECONE_HEALTH_HOST: "127\.0\.0\.1"/);
  assert.doesNotMatch(compose, /^    ports:/m);
  assert.doesNotMatch(compose, /0\.0\.0\.0/);
  assert.match(compose, /ZECONE_CONTAINER_UID:-10001/);
  assert.match(compose, /ZECONE_CONTAINER_GID:-10001/);
  assert.match(compose, /ZECONE_REQUIRED_STATE_FS_UUID/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \["ALL"\]/);
  assert.match(compose, /no-new-privileges:true/);
  assert.doesNotMatch(compose, /private.?key|seed|passphrase|signer.*volume/i);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /FROM rust:1\.89-bookworm/);
  assert.match(dockerfile, /CARGO_BUILD_JOBS=2/);
  assert.match(dockerfile, /ZECONE_READ_ONLY=1/);
  assert.doesNotMatch(dockerfile, /mainnet-operator\.ts execute/);
  assert.match(operator, /ZECONE_ALLOW_EXECUTION:-0/);
  assert.match(operator, /\/run\/zecone-docker\/docker\.sock/);
  assert.match(operator, /CONTAINER_UID="\$\{ZECONE_CONTAINER_UID:-10001\}"/);
  assert.match(operator, /ZECONE_\[A-Z0-9_\]\+/);
  assert.doesNotMatch(operator, /source .*\.env/);
  assert.match(operator, /required ZecOne state filesystem is not mounted/);
  assert.match(
    operator,
    /install -d -o "\$CONTAINER_UID" -g "\$CONTAINER_GID" -m 0700 "\$STATE" "\$LOGS"/,
  );
  assert.match(
    operator,
    /install -d -o root -g "\$CONTAINER_GID" -m 0750 "\$CONFIG"/,
  );
  assert.match(operator, /install -o root -g "\$CONTAINER_GID" -m 0640/);
  assert.match(operator, /\.backup/);
  assert.match(operator, /age -R/);
  assert.match(operator, /PRAGMA integrity_check/);
  assert.match(unit, /--host=unix:\/\/\/run\/zecone-docker\/docker\.sock/);
  assert.doesNotMatch(unit, /--host=tcp/);
  assert.match(unit, /--bridge=none/);
  assert.match(unit, /--iptables=false/);
  assert.match(unit, /--ip-forward=false/);
  assert.match(unit, /--ip-masq=false/);
  assert.match(
    unit,
    /Conflicts=docker\.service docker\.socket containerd\.service/,
  );
});

test("required dedicated state filesystem marker fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "zecone-vps-mount-")),
    config = join(root, "config"),
    state = join(root, "state"),
    port = await freePort();
  mkdirSync(config, { recursive: true });
  mkdirSync(state, { recursive: true });
  copyFileSync(
    "deploy/config/mainnet-profiles.json",
    join(config, "mainnet-profiles.json"),
  );
  copyFileSync(
    "deploy/config/mainnet-readonly.json",
    join(config, "mainnet-readonly.json"),
  );
  const child = spawn(
    process.execPath,
    ["--experimental-transform-types", "scripts/vps-readonly-service.ts"],
    {
      cwd: resolve("."),
      windowsHide: true,
      env: {
        ...process.env,
        ZECONE_READ_ONLY: "1",
        ZECONE_STATE: state,
        ZECONE_CONFIG: config,
        ZECONE_HEALTH_HOST: "127.0.0.1",
        ZECONE_HEALTH_PORT: String(port),
        ZECONE_REQUIRED_STATE_FS_UUID: "11111111-2222-3333-4444-555555555555",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForExit(child);
  assert.notEqual(child.exitCode, 0);
  assert.equal(existsSync(join(state, ".zecone-readonly-v1")), false);
});
