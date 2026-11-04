import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import type { PilotReview } from "./mainnet-pilot-session.ts";

const escapeHtml = (value: unknown) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const headers = {
  "cache-control": "no-store, max-age=0",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function reply(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    ...headers,
    "content-type": "text/html; charset=utf-8",
  });
  res.end(body);
}

function page(review: PilotReview, actionPath: string) {
  const rows: [string, unknown][] = [
    ["Network", `Base (${review.chainId})`],
    ["Recipient", review.recipient],
    ["Payout (wei)", review.amount],
    ["Maximum debit (wei)", review.maximumDestinationDebit],
    ["Fee cap (wei)", review.feeCap],
    ["Nonce", review.nonce],
    ["Gas limit", review.gas],
    ["Gas price (wei)", review.gasPrice],
    ["Prepared block", `${review.blockNumber} · ${review.blockHash}`],
    ["Prepared digest", review.preparedDigest],
    ["Terms digest", review.termsDigest],
    ["Quote digest", review.quoteDigest],
    ["Source commitment", review.sourceCommitment],
    ["Expires", new Date(review.expires * 1000).toISOString()],
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ZecOne exact payout approval</title><style>
  body{font:16px system-ui;background:#08110d;color:#effff6;margin:0;padding:32px}main{max-width:860px;margin:auto;background:#102019;padding:28px;border:1px solid #315844;border-radius:16px}h1{margin-top:0}dl{display:grid;grid-template-columns:220px 1fr;gap:12px}dt{color:#9cc9af}dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,monospace}.warn{padding:14px;background:#2d2410;border:1px solid #8f6d20;border-radius:10px}button{width:100%;margin-top:24px;padding:16px;font-weight:700;font-size:18px;background:#57e389;color:#06140b;border:0;border-radius:10px;cursor:pointer}small{display:block;margin-top:16px;color:#9cc9af}
  </style></head><body><main><h1>Review one exact payout</h1><p class="warn">One click authorizes signing and one broadcast of only the transaction below. Any changed price, nonce, recipient, amount, fee, digest or expiry aborts.</p><dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl><form method="post" action="${escapeHtml(actionPath)}"><button type="submit">SIGN &amp; BROADCAST THIS EXACT TRANSACTION</button></form><small>Local operator page · keys never enter the browser · duplicate clicks are rejected</small></main></body></html>`;
}

export async function waitForOneClickApproval(
  review: PilotReview,
  exactText: string,
  options: {
    now?: () => number;
    open?: (url: string) => void;
    onListening?: (url: string) => void;
  } = {},
) {
  if (review.action !== "SIGN_AND_BROADCAST")
    throw Error("PILOT_ONE_CLICK_ACTION_REQUIRED");
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  if (review.expires <= now()) throw Error("PILOT_ONE_CLICK_APPROVAL_EXPIRED");
  const token = randomBytes(32).toString("hex"),
    path = `/review/${token}`;
  let settled = false,
    expectedHost = "";
  return await new Promise<string>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(exactText);
    };
    const server = createServer((req, res) => {
      const local =
        req.socket.remoteAddress === "127.0.0.1" ||
        req.socket.remoteAddress === "::ffff:127.0.0.1";
      if (!local || req.headers.host !== expectedHost || req.url !== path)
        return reply(res, 404, "Not found");
      if (req.method === "GET") return reply(res, 200, page(review, path));
      if (req.method !== "POST") return reply(res, 405, "Method not allowed");
      const expectedOrigin = `http://${expectedHost}`;
      if (req.headers.origin && req.headers.origin !== expectedOrigin)
        return reply(res, 403, "Origin rejected");
      if (settled) return reply(res, 409, "Approval already used");
      if (review.expires <= now()) {
        reply(res, 410, "Approval expired");
        return finish(Error("PILOT_ONE_CLICK_APPROVAL_EXPIRED"));
      }
      reply(
        res,
        200,
        "<!doctype html><title>ZecOne approved</title><p>Exact payout approved. Return to the operator console.</p>",
      );
      finish();
    });
    server.requestTimeout = 5_000;
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return finish(Error("PILOT_ONE_CLICK_LISTEN_FAILED"));
      expectedHost = `127.0.0.1:${address.port}`;
      const url = `http://${expectedHost}${path}`;
      options.onListening?.(url);
      if (options.open) options.open(url);
      else {
        const child = spawn(
          "rundll32.exe",
          ["url.dll,FileProtocolHandler", url],
          {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          },
        );
        child.on("error", () =>
          finish(Error("PILOT_ONE_CLICK_BROWSER_OPEN_FAILED")),
        );
        child.unref();
      }
    });
    const timer = setTimeout(
      () => finish(Error("PILOT_ONE_CLICK_APPROVAL_EXPIRED")),
      Math.max(1, review.expires - now()) * 1000,
    );
    timer.unref();
    server.on("error", () => finish(Error("PILOT_ONE_CLICK_LISTEN_FAILED")));
  });
}
