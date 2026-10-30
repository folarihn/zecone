import { mkdirSync, readdirSync, copyFileSync } from "node:fs";
const destination = "dist/extension";
mkdirSync(destination, { recursive: true });
for (const file of readdirSync("extension"))
  if (/\.(js|json|html|css|svg|png)$/.test(file))
    copyFileSync(`extension/${file}`, `${destination}/${file}`);
console.log("Unpacked extension: dist/extension (no credentials included)");
