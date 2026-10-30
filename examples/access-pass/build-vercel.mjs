import { cp, mkdir, rm } from "node:fs/promises";

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("./dist", import.meta.url), { recursive: true });
await Promise.all(
  ["index.html", "app.js"].map((name) =>
    cp(new URL(`./${name}`, import.meta.url), new URL(`./dist/${name}`, import.meta.url)),
  ),
);
console.log("Access Pass static bundle ready in examples/access-pass/dist");
