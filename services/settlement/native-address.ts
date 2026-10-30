import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { DestinationDecoder } from "./refunds.ts";
const exec = promisify(execFile);
export class NativeDestinationDecoder implements DestinationDecoder {
  async validate(destination: string) {
    if (typeof destination !== "string" || destination.length > 512)
      throw Error("invalid_refund_destination");
    try {
      const { stdout } = await exec(
        resolve(
          process.platform === "win32"
            ? "target/debug/zecone-zcash.exe"
            : "target/debug/zecone-zcash",
        ),
        [
          "--wallet",
          resolve(".state/address-validation-unused"),
          "validate-address",
          "--address",
          destination,
        ],
        { windowsHide: true, timeout: 10000, maxBuffer: 4096 },
      );
      const r = JSON.parse(stdout);
      if (
        r.network !== "zcash-testnet" ||
        r.shielded !== true ||
        r.valid !== true
      )
        throw Error();
    } catch {
      throw Error("invalid_refund_destination_or_decoder_unavailable");
    }
  }
}
