import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
const exec = promisify(execFile);
let tail: Promise<unknown> = Promise.resolve();
// Share the user-wallet process queue across the historical wallet and marketplace.
// The Rust filesystem lock remains the cross-process authority.
export function userWalletNative<T>(
  args: string[],
  deadline?: number,
): Promise<T> {
  const result = tail.then(async () => {
    if (deadline !== undefined && Date.now() >= deadline)
      throw Error("Native approval expired while queued");
    const { stdout } = await exec(
      resolve(
        process.platform === "win32"
          ? "target/debug/zecone-zcash.exe"
          : "target/debug/zecone-zcash",
      ),
      ["--wallet", resolve(".secrets/user/zcash"), ...args],
      { windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as T;
  });
  tail = result.catch(() => {});
  return result;
}
