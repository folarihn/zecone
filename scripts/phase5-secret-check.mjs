// Compare known local credentials in memory only. Print paths/counts, never values.
import {readFileSync, existsSync, writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
const secrets = [];
function collect(value, key = "") {
  if (typeof value === "string" && value.length >= 24 && /private.?key|mnemonic|seed|api.?key|^key$|^token$/i.test(key)) secrets.push(Buffer.from(value));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) collect(v, k);
}
for (const path of [".secrets/user/base-sepolia.json", ".secrets/relayer/base-sepolia.json", ".secrets/marketplace-seller/base-sepolia.json", ".secrets/opensea-development-key.json", ".secrets/browser-pairing.json"]) if (existsSync(path)) collect(JSON.parse(readFileSync(path, "utf8")));
for (const path of [".secrets/user/zcash/seed.bin", ".secrets/merchant/zcash/seed.bin"]) if (existsSync(path)) {const seed = readFileSync(path); secrets.push(seed, Buffer.from(seed.toString("hex")), Buffer.from(seed.toString("base64")));}
const tracked = execFileSync("git", ["diff", "--name-only", "HEAD"], {encoding: "utf8"}).trim().split(/\r?\n/);
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {encoding: "utf8"}).trim().split(/\r?\n/);
const files = [...new Set([...tracked, ...untracked])].filter(p => p && existsSync(p));
const exposed = files.filter(p => {const data = readFileSync(p); return secrets.some(s => data.includes(s) || (s.toString().startsWith("0x") && data.includes(s.subarray(2))));});
const result = {at: new Date().toISOString(), filesChecked: files.length, credentialPatternsChecked: secrets.length, exposedFiles: exposed, scope: "Changed/nonignored files only; known local credentials compared in memory. No credential values emitted."};
writeFileSync("docs/phase5-evidence/credential-exposure-check.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (exposed.length || !secrets.length) process.exitCode = 1;
