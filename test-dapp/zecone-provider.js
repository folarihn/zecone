// Public, dependency-free EIP-1193 connector. It does not inject into other sites.
export class ZecOneProvider {
  constructor() {
    this.origin = "http://127.0.0.1:3210";
    this.channel = crypto.randomUUID();
    this.events = new Map();
    this.pending = new Map();
    this.popup = null;
    this.ready = false;
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (
        e.origin !== this.origin ||
        e.source !== this.popup ||
        !m ||
        m.channel !== this.channel ||
        m.protocol !== "zecone:2"
      )
        return;
      if (m.kind === "ready") {
        this.ready = true;
        this.emit("connect", { chainId: "0x14a34" });
        for (const p of this.pending.values()) this.send(p);
        return;
      }
      if (m.kind === "event") {
        if (m.event === "disconnect") {
          const error = Object.assign(
            new Error(m.value?.message || "Wallet disconnected"),
            { code: m.value?.code || 4900 },
          );
          for (const p of this.pending.values()) {
            clearTimeout(p.timeout);
            p.reject(error);
          }
          this.pending.clear();
          this.ready = false;
          this.popup?.close();
          this.popup = null;
          this.emit("disconnect", error);
        } else if (m.event === "accountsChanged") this.emit(m.event, m.value);
        return;
      }
      if (m.kind !== "response") return;
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timeout);
      this.pending.delete(m.id);
      if (m.error)
        p.reject(
          Object.assign(new Error(m.error.message), { code: m.error.code }),
        );
      else p.resolve(m.result);
    });
    this.timer = setInterval(() => {
      if (this.popup?.closed) {
        this.popup = null;
        this.ready = false;
        for (const p of this.pending.values()) {
          clearTimeout(p.timeout);
          p.reject(
            Object.assign(new Error("Wallet disconnected"), { code: 4900 }),
          );
        }
        this.pending.clear();
        this.emit("accountsChanged", []);
        this.emit("disconnect", {
          code: 4900,
          message: "Wallet window closed",
        });
      }
    }, 500);
  }
  on(event, listener) {
    const set = this.events.get(event) || new Set();
    set.add(listener);
    this.events.set(event, set);
    return this;
  }
  removeListener(event, listener) {
    this.events.get(event)?.delete(listener);
    return this;
  }
  emit(event, value) {
    for (const f of this.events.get(event) || []) f(value);
  }
  send(p) {
    this.popup?.postMessage(
      {
        protocol: "zecone:2",
        kind: "request",
        channel: this.channel,
        id: p.id,
        method: p.method,
        params: p.params,
      },
      this.origin,
    );
  }
  request({ method, params = [] } = {}) {
    if (
      typeof method !== "string" ||
      (!Array.isArray(params) && (!params || typeof params !== "object"))
    )
      return Promise.reject(
        Object.assign(new Error("Invalid request"), { code: -32602 }),
      );
    // EIP-1193 permits method parameters as either an array or an object. The
    // supported one-object RPC methods are normalized to their JSON-RPC tuple.
    if (!Array.isArray(params)) params = [params];
    if (!this.popup || this.popup.closed) {
      this.ready = false;
      this.popup = window.open(
        `${this.origin}/connect#${this.channel}`,
        "_blank",
        "popup,width=580,height=820",
      );
      if (!this.popup)
        return Promise.reject(
          Object.assign(new Error("Allow the ZecOne popup"), { code: 4900 }),
        );
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID(),
        p = {
          id,
          method,
          params,
          resolve,
          reject,
          timeout: setTimeout(() => {
            this.pending.delete(id);
            reject(
              Object.assign(new Error("Wallet request timed out"), {
                code: -32002,
              }),
            );
          }, 300000),
        };
      this.pending.set(id, p);
      if (this.ready) this.send(p);
      else {
        const hello = setInterval(() => {
          if (!this.pending.has(id) || this.ready) clearInterval(hello);
          else
            this.popup?.postMessage(
              { protocol: "zecone:2", kind: "hello", channel: this.channel },
              this.origin,
            );
        }, 300);
      }
    });
  }
}
export const provider = new ZecOneProvider();
const info = Object.freeze({
  uuid: crypto.randomUUID(),
  name: "ZecOne local testnet",
  icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="%231c4e42"/><text x="18" y="45" font-size="40" fill="white">Z</text></svg>',
  rdns: "local.zecone.wallet",
});
const announce = () =>
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info, provider }),
    }),
  );
window.addEventListener("eip6963:requestProvider", announce);
announce();
