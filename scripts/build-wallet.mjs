import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "build", "--webpack"],
  { stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
