// MAIN world is public. This facade has no signing or extension authority.
(() => {
  "use strict";
  if (window.top !== window || !location.origin.startsWith("https://")) return;
  const installed = Symbol.for("zecone.eip6963.installed");
  if (window[installed]) return;
  Object.defineProperty(window, installed, { value: true });
  const pending = new Map(),
    listeners = new Map();
  const error = (code, message) => Object.assign(new Error(message), { code });
  const emit = (name, value) => {
    for (const fn of [...(listeners.get(name) ?? [])]) {
      try {
        fn(value);
      } catch {}
    }
  };
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (
      e.source !== window ||
      e.origin !== location.origin ||
      m?.protocol !== "zecone:extension:1" ||
      m.direction !== "response"
    )
      return;
    if (m.kind === "response" && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error
        ? p.reject(error(m.error.code, m.error.message))
        : p.resolve(m.result);
    } else if (m.kind === "event") emit(m.event, m.value);
    else if (m.kind === "disconnect") {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(error(4900, m.message));
      }
      pending.clear();
      emit("accountsChanged", []);
      emit("disconnect", error(4900, m.message));
    }
  });
  const provider = Object.freeze({
    isZecOne: true,
    request(input) {
      if (
        !input ||
        typeof input !== "object" ||
        typeof input.method !== "string" ||
        Object.keys(input).some((k) => !["method", "params"].includes(k))
      )
        return Promise.reject(error(-32602, "Invalid request"));
      let params = input.params ?? [];
      if (!Array.isArray(params)) params = [params];
      try {
        params = JSON.parse(JSON.stringify(params));
        if (JSON.stringify(params).length > 16000) throw Error();
      } catch {
        return Promise.reject(error(-32602, "Invalid request size or JSON"));
      }
      if (pending.size >= 8)
        return Promise.reject(error(-32002, "Too many outstanding requests"));
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pending.set(id, {
          resolve,
          reject,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(error(-32002, "Wallet request expired"));
          }, 301000),
        });
        window.postMessage(
          {
            protocol: "zecone:extension:1",
            direction: "request",
            kind: "request",
            id,
            method: input.method,
            params,
          },
          location.origin,
        );
      });
    },
    on(event, fn) {
      if (typeof fn !== "function")
        throw error(-32602, "Listener must be a function");
      const set = listeners.get(event) ?? [];
      set.push(fn);
      listeners.set(event, set);
      return provider;
    },
    removeListener(event, fn) {
      const list = listeners.get(event) ?? [];
      const i = list.lastIndexOf(fn);
      if (i >= 0) list.splice(i, 1);
      return provider;
    },
  });
  const info = Object.freeze({
    uuid: crypto.randomUUID(),
    name: "ZecOne Testnet",
    rdns: "local.zecone.wallet",
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='16' fill='%231c4e42'/><text x='18' y='45' font-size='40' fill='white'>Z</text></svg>",
  });
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({ info, provider }),
      }),
    );
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
