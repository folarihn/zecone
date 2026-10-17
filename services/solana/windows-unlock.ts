// Windows DPAPI CurrentUser protects only new Phase 7C age unlock material.
// No credential migration. Same-user malware is explicitly outside this boundary.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SolanaError } from "./network.ts";

async function dpapi(input: Buffer, protect: boolean): Promise<Buffer> {
  if (process.platform !== "win32")
    throw new SolanaError("WINDOWS_DPAPI_REQUIRED");
  const operation = protect ? "Protect" : "Unprotect";
  const script = `Add-Type -AssemblyName System.Security; $ErrorActionPreference='Stop'; try { $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r)); [Array]::Clear($v,0,$v.Length); [Array]::Clear($r,0,$r.Length) } catch { exit 1 }`;
  return new Promise((yes, no) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      no(new SolanaError("DPAPI_FAILED"));
    }, 15000);
    child.on("error", () => {
      clearTimeout(timer);
      no(new SolanaError("DPAPI_FAILED"));
    });
    child.stdout.on("data", (b) => {
      output += b;
      if (output.length > 8192) child.kill();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !output || output.length > 8192)
        return no(new SolanaError("DPAPI_FAILED"));
      yes(Buffer.from(output, "base64"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input.toString("base64"));
  });
}
export class WindowsUnlock {
  constructor(readonly root = ".secrets/phase7c-unlock") {}
  private file(label: string) {
    if (!/^(relayer|recipient-[a-f0-9-]{36})$/.test(label))
      throw new SolanaError("INVALID_ACCOUNT_LABEL");
    return join(this.root, `${label}.dpapi`);
  }
  async create(label: string) {
    const secret = randomBytes(32);
    try {
      const sealed = await dpapi(secret, true);
      mkdirSync(this.root, { recursive: true });
      writeFileSync(this.file(label), sealed, { flag: "wx", mode: 0o600 });
      return secret.toString("base64");
    } finally {
      secret.fill(0);
    }
  }
  async unlock(label: string, explicit: boolean) {
    if (!explicit) throw new SolanaError("APPROVAL_REQUIRED");
    const sealed = readFileSync(this.file(label));
    if (sealed.length > 4096) throw new SolanaError("DPAPI_FAILED");
    const secret = await dpapi(sealed, false);
    try {
      if (secret.length !== 32) throw new SolanaError("DPAPI_FAILED");
      return secret.toString("base64");
    } finally {
      secret.fill(0);
    }
  }
}
