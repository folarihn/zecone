import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxProcessHolders } from "../services/operations/process-holders.ts";

test("linux process holders use procfs without requiring ps", () => {
  const root = mkdtempSync(join(tmpdir(), "zecone-proc-"));
  try {
    for (const [pid, command] of [
      ["101", "node\0mainnet-watch-worker.ts\0"],
      ["202", "node\0unrelated.ts\0"],
      ["303", "zecone-zcash-watch\0--wallet\0x\0"],
    ]) {
      mkdirSync(join(root, pid));
      writeFileSync(join(root, pid, "cmdline"), command);
    }
    assert.deepEqual(
      linuxProcessHolders(/zecone-zcash-watch|mainnet-watch-worker\.ts/, 303, root),
      [101],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linux process holders fail with a stable safe code when procfs is unavailable", () => {
  assert.throws(
    () => linuxProcessHolders(/watch/, 1, join(tmpdir(), "missing-zecone-proc")),
    /PROCESS_TABLE_UNAVAILABLE/,
  );
});
