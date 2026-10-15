// ISOLATED world: webpage scripts cannot access this popup reference or channel.
(() => {
  "use strict";
  if (window.top !== window || !location.origin.startsWith("https://")) return;
  const WALLET = "http://127.0.0.1:3210";
  let port = null,
    popup = null,
    ready = false,
    channel = "",
    lastPing = 0;
  const queue = new Map();
  const publish = (message) =>
    window.postMessage(
      { ...message, protocol: "zecone:extension:1", direction: "response" },
      location.origin,
    );
  const postWallet = (message) =>
    popup?.postMessage({ protocol: "zecone:2", channel, ...message }, WALLET);
  function reset(message) {
    queue.clear();
    ready = false;
    popup?.close();
    popup = null;
    channel = "";
    publish({ kind: "disconnect", message });
  }
  function connect() {
    if (port) return;
    port = chrome.runtime.connect({ name: "zecone-content-v1" });
    const current = port;
    port.onDisconnect.addListener(() => {
      if (port === current) {
        port = null;
        reset(
          "Extension transport restarted or disconnected. Reconnect explicitly.",
        );
      }
    });
    port.onMessage.addListener((m) => {
      if (m.kind === "execute") {
        if (!popup || popup.closed) {
          channel = crypto.randomUUID();
          ready = false;
          popup = window.open(
            `${WALLET}/connect#${channel}`,
            "_blank",
            "popup,width=580,height=820",
          );
          if (!popup) {
            current.postMessage({
              kind: "wallet",
              message: {
                kind: "response",
                id: m.request.id,
                error: {
                  code: 4900,
                  message: "Allow the local ZecOne approval popup",
                },
              },
            });
            return;
          }
        }
        queue.set(m.request.id, m.request);
        if (ready) postWallet(m.request);
        else postWallet({ kind: "hello" });
      } else if (m.kind === "disconnect") reset(m.message);
      else {
        if (m.kind === "response") queue.delete(m.id);
        publish(m);
      }
    });
  }
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (
      e.source === window &&
      e.origin === location.origin &&
      m?.protocol === "zecone:extension:1" &&
      m.direction === "request"
    ) {
      // Only this projection is sent; a webpage cannot claim wallet/approved/origin.
      try {
        connect();
        port.postMessage({
          kind: "request",
          id: m.id,
          method: m.method,
          params: m.params,
        });
      } catch {
        reset("Extension unavailable. Reload the website.");
      }
    } else if (
      popup &&
      e.source === popup &&
      e.origin === WALLET &&
      m?.protocol === "zecone:2" &&
      m.channel === channel &&
      port
    ) {
      if (
        m.kind === "ready" &&
        !ready &&
        ["0x14a34", "0xaa36a7", "0xb626"].includes(m.chainId)
      ) {
        ready = true;
        port.postMessage({ kind: "wallet", message: m });
        for (const request of queue.values()) postWallet(request);
      } else if (m.kind === "response" && queue.has(m.id))
        port.postMessage({ kind: "wallet", message: m });
      else if (m.kind === "event")
        port.postMessage({ kind: "wallet", message: m });
    }
  });
  setInterval(() => {
    if (popup?.closed) {
      port?.postMessage({ kind: "closed" });
      reset("Local approval window closed");
    } else if (popup && !ready && queue.size) postWallet({ kind: "hello" });
    if (popup && port && Date.now() - lastPing > 20000) {
      port.postMessage({ kind: "ping" });
      lastPing = Date.now();
    }
  }, 300);
  window.addEventListener("pagehide", () => {
    popup?.close();
    port?.disconnect();
  });
})();
