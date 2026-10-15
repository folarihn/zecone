import {
  senderOrigin,
  validateRequest,
  accountsValid,
  CHAINS,
  idValid,
} from "./policy.js";
// Volatile transport only. Losing this worker must never resume a signing request.
const connections = new Map(),
  logs = [];
function log(origin, method, outcome, code) {
  logs.push({
    time: new Date().toISOString(),
    origin,
    method,
    outcome,
    ...(code === undefined ? {} : { code }),
  });
  if (logs.length > 100) logs.shift(); // Never store params, signatures, cookies or messages.
}
chrome.runtime.onConnect.addListener((port) => {
  let origin;
  try {
    if (port.name !== "zecone-content-v1") throw Error();
    origin = senderOrigin(port.sender, chrome.runtime.id);
  } catch {
    port.disconnect();
    return;
  }
  const key = `${port.sender.tab.id}:${port.sender.documentId}`;
  connections.get(key)?.close();
  const state = {
    port,
    origin,
    accounts: [],
    chainId: "0x14a34",
    pending: new Map(),
    seen: new Set(),
    close: () => {},
  };
  connections.set(key, state);
  function cleanup() {
    for (const p of state.pending.values()) clearTimeout(p.timer);
    state.pending.clear();
    if (connections.get(key) === state) connections.delete(key);
  }
  state.close = () => {
    cleanup();
    port.disconnect();
  };
  const send = (m) => {
    try {
      port.postMessage(m);
    } catch {}
  };
  function finish(id, result, error) {
    const p = state.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    state.pending.delete(id);
    log(origin, p.method, error ? "rejected" : "resolved", error?.code);
    send({ kind: "response", id, ...(error ? { error } : { result }) });
  }
  port.onMessage.addListener((m) => {
    if (m?.kind === "ping") return;
    if (m?.kind === "request") {
      try {
        validateRequest(m);
      } catch (e) {
        if (idValid(m.id))
          send({
            kind: "response",
            id: m.id,
            error: { code: e.code ?? -32602, message: e.message },
          });
        log(
          origin,
          typeof m.method === "string" ? m.method.slice(0, 80) : "invalid",
          "blocked",
          e.code,
        );
        return;
      }
      if (state.seen.has(m.id)) return; // Replay must not replace an outstanding resolver.
      state.seen.add(m.id);
      if (state.seen.size > 512) {
        send({
          kind: "disconnect",
          message: "Reload before creating more requests",
        });
        state.close();
        return;
      }
      log(origin, m.method, "requested");
      const reject = (code, message) => {
        send({ kind: "response", id: m.id, error: { code, message } });
        log(origin, m.method, "rejected", code);
      };
      if (
        state.pending.size >= 8 ||
        (m.method === "eth_requestAccounts" &&
          [...state.pending.values()].some((p) => p.method === m.method))
      ) {
        reject(-32002, "A wallet request is already pending");
        return;
      }
      if (
        !state.accounts.length &&
        ["eth_accounts", "eth_chainId"].includes(m.method)
      ) {
        send({
          kind: "response",
          id: m.id,
          result: m.method === "eth_accounts" ? [] : state.chainId,
        });
        return;
      }
      if (!state.accounts.length && m.method !== "eth_requestAccounts") {
        reject(4100, "Connect and approve account access first");
        return;
      }
      state.pending.set(m.id, {
        method: m.method,
        timer: setTimeout(
          () =>
            finish(m.id, undefined, {
              code: -32002,
              message: "Wallet request expired",
            }),
          300000,
        ),
      });
      send({ kind: "execute", request: m });
    } else if (m?.kind === "wallet") {
      const w = m.message;
      if (w?.kind === "response" && state.pending.has(w.id)) {
        const method = state.pending.get(w.id).method;
        if (w.error) {
          finish(w.id, undefined, {
            code: Number.isInteger(w.error.code) ? w.error.code : -32603,
            message:
              typeof w.error.message === "string"
                ? w.error.message.slice(0, 300)
                : "Local wallet failed",
          });
          return;
        }
        if (["eth_requestAccounts", "eth_accounts"].includes(method)) {
          if (!accountsValid(w.result)) return;
          state.accounts = w.result;
        }
        if (method === "eth_chainId") {
          if (!CHAINS.includes(w.result)) return;
          state.chainId = w.result;
        }
        if (method === "wallet_revokePermissions") state.accounts = [];
        finish(w.id, w.result);
      } else if (w?.kind === "ready" && CHAINS.includes(w.chainId)) {
        state.chainId = w.chainId;
        send({
          kind: "event",
          event: "connect",
          value: { chainId: w.chainId },
        });
      } else if (w?.kind === "event") {
        if (w.event === "accountsChanged" && accountsValid(w.value)) {
          state.accounts = w.value;
          send({ kind: "event", event: w.event, value: w.value });
        } else if (w.event === "chainChanged" && CHAINS.includes(w.value)) {
          state.chainId = w.value;
          send({ kind: "event", event: w.event, value: w.value });
        } else if (w.event === "disconnect") {
          send({
            kind: "disconnect",
            message: "Local wallet disconnected or session expired",
          });
          state.close();
        }
      }
    } else if (m?.kind === "closed") {
      send({ kind: "disconnect", message: "Local approval window closed" });
      state.close();
    }
  });
  port.onDisconnect.addListener(cleanup);
});
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  // Only the packaged extension action may inspect transport metadata or disconnect.
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("popup.html")
  )
    return;
  if (m?.kind === "open-wallet") {
    chrome.tabs.create({ url: "http://127.0.0.1:3210" });
    reply({ ok: true });
  }
  if (m?.kind === "status")
    reply({
      connections: [...connections].map(([id, s]) => ({
        id,
        origin: s.origin,
        account: s.accounts[0] ?? null,
        chainId: s.chainId,
        pending: s.pending.size,
      })),
      logs,
    });
  if (m?.kind === "disconnect" && typeof m.id === "string") {
    const s = connections.get(m.id);
    s?.port.postMessage({
      kind: "disconnect",
      message: "Disconnected in extension",
    });
    s?.close();
    reply({ ok: true });
  }
});
