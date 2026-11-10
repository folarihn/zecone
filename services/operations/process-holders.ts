import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read Linux process command lines directly from procfs. Minimal production
 * images need not install `ps`, and a vanished process is harmless while the
 * directory is being walked.
 */
export function linuxProcessHolders(
  relevant: RegExp,
  excludePid: number,
  procRoot = "/proc",
): number[] {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    throw Error("PROCESS_TABLE_UNAVAILABLE");
  }

  const holders: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === excludePid) continue;
    try {
      const command = readFileSync(join(procRoot, entry, "cmdline"), "utf8")
        .replace(/\0/g, " ")
        .trim();
      if (command && relevant.test(command)) holders.push(pid);
    } catch {
      // Processes routinely exit between readdir and readFile.
    }
  }
  return holders;
}
