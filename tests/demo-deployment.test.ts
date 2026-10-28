import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHECKOUT_ADDRESS } from "../services/payments/api.ts";

const base = readFileSync("deploy/demo/compose.yaml", "utf8");
const nginx = readFileSync("deploy/demo/compose.nginx.yaml", "utf8");
const site = readFileSync("deploy/demo/nginx/zecone-demo.conf", "utf8");

test("shared Contabo override keeps demo services loopback-only behind existing Nginx", () => {
  assert.match(nginx, /network_mode:\s*host/g);
  assert.match(nginx, /ZECONE_PAYMENTS_HOST:\s*127\.0\.0\.1/);
  assert.match(nginx, /ACCESS_PASS_HOST:\s*127\.0\.0\.1/);
  assert.match(nginx, /ZECONE_BASE_URL:\s*http:\/\/127\.0\.0\.1:4321/);
  assert.match(nginx, /profiles:\s*\[standalone-caddy\]/);
  assert.doesNotMatch(nginx, /ports:/);

  assert.match(site, /server_name api\.zecone\.xyz/);
  assert.match(site, /proxy_pass http:\/\/127\.0\.0\.1:4321/);
  assert.match(site, /server_name access-api\.zecone\.xyz/);
  assert.match(site, /proxy_pass http:\/\/127\.0\.0\.1:4333/);
  assert.doesNotMatch(site, /proxy_pass\s+https?:\/\/(?!127\.0\.0\.1)/);
});

test("demo base remains non-financial and contains no wallet or relayer mount", () => {
  assert.match(base, /ZECONE_PAYMENTS_MODE:\s*demo/);
  assert.match(base, /ZECONE_OPERATOR_TOKEN:\s*""/);
  assert.match(base, /ZECONE_DEMO_OBSERVER:\s*"1"/);
  assert.doesNotMatch(
    base,
    /keystore|private[_-]?key|relayer[_-]?key|wallet\.db/i,
  );
});

// ---- payments image packaging ----
// The runtime image copies a trimmed subset of the repository. Every module the
// production entrypoint loads at runtime must be inside that subset, and the
// image must carry no wallet, keystore or operator-machine material.

const dockerfile = readFileSync("deploy/demo/Dockerfile", "utf8");

/** Paths the runtime stage copies from the build context (not from the build stage). */
function runtimeCopies(text: string): string[] {
  const runtime = text.slice(text.indexOf(" AS runtime"));
  return [...runtime.matchAll(/^COPY (?!--from)(\S+) \S+$/gm)].map((m) => m[1]);
}
const coveredBy = (copies: string[], file: string) =>
  copies.some((c) => file === c || file.startsWith(c.replace(/\/?$/, "/")));

/** Runtime (value) imports reachable from an entry file; `import type` is erased and skipped. */
function runtimeGraph(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;"']*?\s+from\s+)?["']([^"']+)["']/g,
    )) {
      if (m[1]) continue;
      const spec = m[2];
      if (spec.startsWith("."))
        visit(posix.normalize(posix.join(posix.dirname(file), spec)));
      else if (!spec.startsWith("node:"))
        packages.add(
          spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0],
        );
    }
  };
  visit(entry);
  return { files: [...files].sort(), packages: [...packages].sort() };
}

test("payments image copies every runtime module of the production entrypoint", () => {
  const copies = runtimeCopies(dockerfile);
  const { files, packages } = runtimeGraph("services/payments/server.ts");
  assert.ok(
    files.includes("services/payments/pilot-quote.ts"),
    "graph walks the pilot quote path",
  );
  const missing = files.filter((f) => !coveredBy(copies, f));
  assert.deepEqual(
    missing,
    [],
    `runtime modules missing from deploy/demo/Dockerfile: ${missing.join(", ")}`,
  );
  const deps = JSON.parse(readFileSync("package.json", "utf8"))
    .dependencies as Record<string, string>;
  const notProduction = packages.filter((p) => !(p in deps));
  assert.deepEqual(
    notProduction,
    [],
    `runtime packages not in production dependencies: ${notProduction.join(", ")}`,
  );
  // The trimmed copy stays narrow: no settlement signers, wallets, keystores or tests.
  for (const c of copies)
    assert.doesNotMatch(
      c,
      /^(\.|services\/?$|services\/settlement\/?$|services\/(signer|provisioning|wallet|zcash)|tests|config|\.secrets|\.state)/,
      c,
    );
});

test(
  "payments image boots the pilot entrypoint offline and holds no signing material",
  {
    skip:
      !process.env.ZECONE_PAYMENTS_IMAGE &&
      "set ZECONE_PAYMENTS_IMAGE to a built deploy/demo image",
  },
  () => {
    const image = process.env.ZECONE_PAYMENTS_IMAGE!;
    const docker = (...args: string[]) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
    // Synthetic, throwaway values only: a fresh public key, random tokens, example URLs.
    const { publicKey } = generateKeyPairSync("ed25519");
    const env = {
      ZECONE_PAYMENTS_MODE: "monitor",
      ZECONE_WATCH_SOURCE: "operator",
      ZECONE_MONITOR_AUTHORIZED: "I_UNDERSTAND_NO_AUTOMATIC_PAYOUT",
      ZECONE_CHECKOUT_ADDRESS: DEFAULT_CHECKOUT_ADDRESS,
      ZECONE_PILOT_MERCHANT_OWNER: "0x4b5750d7675f14eB844B74477015302Bf31AE2dB",
      ZECONE_RELAYER_ADDRESS: "0x0BccE2De6b41522a68e7A7915C6947CFE37B9f18",
      ZECONE_PILOT_MAX_AMOUNT_USD: "0.01",
      ZECONE_PILOT_MAX_PAYOUT_WEI: "300000000000000",
      ZECONE_QUOTE_TTL_SECONDS: "300",
      ZECONE_PILOT_QUOTE_AUTHORITY: "synthetic-smoke-authority",
      ZECONE_PILOT_QUOTE_PUBLIC_KEY_B64: (
        publicKey.export({ format: "der", type: "spki" }) as Buffer
      ).toString("base64"),
      ZECONE_BASE_PAYOUT_RPCS:
        "https://rpc-a.example.test,https://rpc-b.example.test",
      ZECONE_OPERATOR_PORT: "4322",
      ZECONE_OPERATOR_TOKEN: randomBytes(32).toString("hex"),
      ZECONE_DEMO_SECRET: randomBytes(24).toString("hex"),
      ZECONE_PUBLIC_URL: "https://zecone.example.test",
      ZECONE_ALLOW_HTTP_WEBHOOKS: "0",
      ZECONE_PAYMENTS_HOST: "127.0.0.1",
      ZECONE_PAYMENTS_DB: "/var/lib/zecone/payments/smoke.sqlite",
    };
    const dir = mkdtempSync(join(tmpdir(), "zecone-image-smoke-"));
    const envFile = join(dir, "smoke.env");
    writeFileSync(
      envFile,
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    const name = `zecone-payments-smoke-${randomBytes(4).toString("hex")}`;
    try {
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "none",
        "--env-file",
        envFile,
        image,
        "services/payments/server.ts",
      );
      const probe =
        "fetch('http://127.0.0.1:4321/api/v1/health').then(r=>r.json()).then(j=>process.stdout.write(JSON.stringify(j)))";
      let health: Record<string, unknown> | null = null;
      for (let i = 0; i < 40 && !health; i++) {
        try {
          health = JSON.parse(docker("exec", name, "node", "-e", probe));
        } catch {
          if (
            docker("inspect", "-f", "{{.State.Running}}", name).trim() !==
            "true"
          )
            // Container stderr arrives on `docker logs` stderr, so capture both streams.
            assert.fail(
              `entrypoint exited: ${spawnSync("docker", ["logs", "--tail", "20", name], { encoding: "utf8" }).stderr.slice(-1500)}`,
            );
          execFileSync(process.execPath, ["-e", "setTimeout(()=>{},500)"]);
        }
      }
      assert.ok(health, "health endpoint answered inside the container");
      assert.equal(health.mode, "monitor");
      assert.equal(health.realPayments, "restricted-pilot");
      assert.equal(health.livePayoutEnabled, false);
      assert.equal(health.zcashBroadcastEnabled, false);
    } finally {
      try {
        docker("rm", "-f", name);
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
    // Names that would indicate wallet, keystore or operator-machine material anywhere app-owned.
    const found = docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "sh",
      image,
      "-c",
      "find /app /var/lib/zecone /home /root /tmp /etc -xdev -path /app/node_modules -prune -o '(' " +
        "-iname '*keystore*' -o -iname '*.age' -o -iname '*.pem' -o -iname '*.key' -o -iname '*passphrase*' -o -iname '*mnemonic*' " +
        "-o -iname 'seed*.txt' -o -iname '*.sqlite*' -o -iname '*.db' -o -iname '*.wallet' -o -iname '.env*' -o -iname '*operator-token*' " +
        "-o -iname '*watch-worker*.json' -o -iname '*profiles.production*' -o -iname '*readonly.production*' ')' -print 2>/dev/null; " +
        "grep -rlE 'BEGIN [A-Z ]*PRIVATE KEY|secret-extended-key-main1' /app --exclude-dir=node_modules 2>/dev/null; true",
    ).trim();
    assert.equal(found, "", `unexpected sensitive files in image:\n${found}`);
  },
);
