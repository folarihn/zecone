// MV3 MAIN-world injection. Public/untrusted code; no extension privilege, keys,
// HTTP signer calls or claimed secret channel. Browser-authenticated popup origin
// plus local session and visible approval form the authority boundary.
(() => {
  "use strict";
  if (
    window.top !== window ||
    !["https://opensea.io", "https://www.opensea.io"].includes(location.origin)
  )
    return;
  const WALLET = "http://127.0.0.1:3210",
    channel = crypto.randomUUID();
  const pending = new Map(),
    listeners = new Map();
  const methods = new Set([
    "eth_requestAccounts",
    "eth_accounts",
    "eth_chainId",
    "wallet_revokePermissions",
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "personal_sign",
    "eth_signTypedData_v4",
    "eth_sendTransaction",
  ]);
  const chains = new Set(["0x14a34", "0xaa36a7", "0xb626"]);
  let popup = null,
    ready = false,
    chainId = "0x14a34";
  const error = (code, message) => Object.assign(new Error(message), { code });
  const emit = (event, value) => {
    for (const fn of listeners.get(event) || []) {
      try {
        fn(value);
      } catch {}
    }
  };
  const post = (value) =>
    popup?.postMessage({ protocol: "zecone:2", channel, ...value }, WALLET);
  const disconnect = (message) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error(4900, message));
    }
    pending.clear();
    ready = false;
    popup?.close();
    popup = null;
    emit("accountsChanged", []);
    emit("disconnect", error(4900, message));
  };
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (
      !popup ||
      e.source !== popup ||
      e.origin !== WALLET ||
      !m ||
      typeof m !== "object" ||
      m.protocol !== "zecone:2" ||
      m.channel !== channel
    )
      return;
    if (m.kind === "ready") {
      if (!chains.has(m.chainId)) return;
      if (ready) return;
      ready = true;
      chainId = m.chainId;
      emit("connect", { chainId });
      for (const p of pending.values()) post(p.message);
    } else if (m.kind === "event") {
      if (m.event === "disconnect")
        disconnect("Local wallet permission revoked or session expired");
      else if (
        m.event === "accountsChanged" &&
        Array.isArray(m.value) &&
        m.value.every(
          (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a),
        )
      )
        emit(m.event, m.value);
      else if (m.event === "chainChanged" && chains.has(m.value)) {
        chainId = m.value;
        emit(m.event, m.value);
      }
    } else if (m.kind === "response" && typeof m.id === "string") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error)
        p.reject(
          error(
            Number.isInteger(m.error.code) ? m.error.code : -32603,
            typeof m.error.message === "string"
              ? m.error.message.slice(0, 300)
              : "Wallet request failed",
          ),
        );
      else p.resolve(m.result);
    }
  });
  setInterval(() => {
    if (popup?.closed) disconnect("Wallet window closed");
    else if (popup && !ready && pending.size) post({ kind: "hello" });
  }, 300);
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
      const method = input.method;
      if (!methods.has(method))
        return Promise.reject(error(4200, "Unsupported wallet method"));
      let params = input.params ?? [];
      if (!Array.isArray(params)) {
        if (!params || typeof params !== "object")
          return Promise.reject(error(-32602, "Invalid parameters"));
        params = [params];
      }
      try {
        if (JSON.stringify(params).length > 16000) throw Error();
      } catch {
        return Promise.reject(error(-32602, "Request too large or not JSON"));
      }
      if (pending.size >= 8)
        return Promise.reject(
          error(-32002, "Too many outstanding wallet requests"),
        );
      if (!popup || popup.closed) {
        if (method === "eth_accounts") return Promise.resolve([]);
        if (method === "eth_chainId") return Promise.resolve(chainId);
        if (method !== "eth_requestAccounts")
          return Promise.reject(
            error(4100, "Connect and approve account access first"),
          );
        ready = false;
        popup = window.open(
          `${WALLET}/connect#${channel}`,
          "_blank",
          "popup,width=580,height=820",
        );
        if (!popup)
          return Promise.reject(
            error(4900, "Allow the local ZecOne approval popup"),
          );
      }
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID(),
          message = { kind: "request", id, method, params };
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(error(-32002, "Wallet request expired"));
        }, 300000);
        pending.set(id, { resolve, reject, timer, message });
        if (ready) post(message);
        else post({ kind: "hello" });
      });
    },
    on(event, fn) {
      if (typeof fn !== "function")
        throw error(-32602, "Listener must be a function");
      const s = listeners.get(event) || new Set();
      s.add(fn);
      listeners.set(event, s);
      return provider;
    },
    removeListener(event, fn) {
      listeners.get(event)?.delete(fn);
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
  // Do not replace another wallet's window.ethereum or impersonate MetaMask.
})();
