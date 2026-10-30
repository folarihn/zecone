import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const page = await readFile(new URL("./index.html", import.meta.url));
const sdk = await readFile(new URL("./zecone-provider.js", import.meta.url));
createServer((req, res) => {
  if (req.url === "/zecone-provider.js") {
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "cross-origin-opener-policy": "unsafe-none",
    });
    return res.end(sdk);
  }
  if (req.url !== "/" && req.url !== "/index.html") {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-opener-policy": "unsafe-none",
  });
  res.end(page);
}).listen(4321, "127.0.0.1", () =>
  console.log("External fixture dApp at http://127.0.0.1:4321"),
);
