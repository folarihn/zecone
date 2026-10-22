import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  MainnetWatchJournal,
  MainnetWatchScanner,
  observeMainnetWatch,
  type MainnetOrderBinding,
} from "../services/settlement/mainnet-watch.ts";

const exec = promisify(execFile);

function args() {
  const [command, ...rest] = process.argv.slice(2),
    values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--") || !rest[i + 1])
      throw Error("INVALID_ARGUMENTS");
    values.set(rest[i].slice(2), rest[++i]);
  }
  return { command, values };
}

function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value || value.startsWith("--"))
    throw Error(`${key.toUpperCase()}_REQUIRED`);
  return value;
}

function binding(file: string): MainnetOrderBinding {
  const value = JSON.parse(readFileSync(file, "utf8")) as MainnetOrderBinding;
  if (!value || typeof value !== "object") throw Error("BINDING_FILE_INVALID");
  return value;
}

async function execute() {
  const { command, values } = args();
  if (command === "import") {
    const wallet = resolve(required(values, "wallet")),
      ufvk = resolve(required(values, "ufvk")),
      birthday = required(values, "birthday"),
      server = required(values, "server"),
      peer = required(values, "peer");
    if (!/^[0-9]{1,9}$/.test(birthday)) throw Error("INVALID_BIRTHDAY");
    try {
      const { stdout } = await exec(
        resolve(
          `target/debug/zecone-zcash-watch${process.platform === "win32" ? ".exe" : ""}`,
        ),
        [
          "--wallet",
          wallet,
          "import-mainnet",
          "--ufvk-file",
          ufvk,
          "--birthday",
          birthday,
          "--server",
          server,
          "--peer",
          peer,
        ],
        { windowsHide: true, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      );
      process.stdout.write(stdout);
    } catch {
      throw Error("MAINNET_WATCH_IMPORT_FAILED");
    }
    return;
  }
  const journal = new MainnetWatchJournal(resolve(required(values, "journal")));
  try {
    if (command === "bind") {
      journal.bind(binding(required(values, "binding")));
      process.stdout.write(JSON.stringify({ bound: true }) + "\n");
      return;
    }
    if (command === "status") {
      process.stdout.write(
        JSON.stringify(journal.status(required(values, "order")), null, 2) +
          "\n",
      );
      return;
    }
    if (command !== "observe") throw Error("UNKNOWN_COMMAND");
    const order = binding(required(values, "binding"));
    const scanner = new MainnetWatchScanner(
      required(values, "wallet"),
      required(values, "server"),
      required(values, "peer"),
    );
    const observation = await observeMainnetWatch(journal, scanner, order);
    process.stdout.write(JSON.stringify(observation, null, 2) + "\n");
  } finally {
    journal.close();
  }
}

execute().catch((e: unknown) => {
  process.stderr.write(
    JSON.stringify({ error: e instanceof Error ? e.message : "FAILED" }) + "\n",
  );
  process.exitCode = 1;
});
