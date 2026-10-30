import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";

const destination = resolve(process.argv[2] ?? ".secrets/deployment/demo.env");
const secret = randomBytes(32).toString("base64url");
const apiKey = `zk_${"0".repeat(24)}_${secret}`;
const contents = [
  "# Generated demo-only credentials. No wallet, relayer, watcher or mainnet keys.",
  `ZECONE_DEMO_SECRET=${secret}`,
  `ZECONE_API_KEY=${apiKey}`,
  "ZECONE_DEMO_PAYOUT_ADDRESS=0x1111111111111111111111111111111111111111",
  "",
].join("\n");
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const fd = openSync(destination, "wx", 0o600);
try {
  writeFileSync(fd, contents, { encoding: "utf8" });
} finally {
  closeSync(fd);
}
const fingerprint = createHash("sha256").update(secret).digest("hex").slice(0, 12);
console.log(`Created demo-only environment at ${destination}`);
console.log(`Secret fingerprint (not the secret): ${fingerprint}`);
