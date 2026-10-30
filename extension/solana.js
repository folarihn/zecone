// Connection-only Wallet Standard. No advertised signing or send features.
(() => {
  if (window !== window.top) return;
  const installed = Symbol.for("zecone.wallet-standard.installed");
  if (window[installed]) return;
  Object.defineProperty(window, installed, { value: true });
  const local = "http://127.0.0.1:3210",
    listeners = new Set();
  let accounts = [],
    pending = false,
    connection = null,
    generation = 0,
    cancel = null;
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const emit = () => {
    for (const fn of [...listeners])
      try {
        fn({ accounts: [...accounts] });
      } catch {}
  };
  function clear() {
    generation++;
    cancel?.();
    cancel = null;
    const old = connection;
    connection = null;
    old?.cleanup();
    old?.popup.close();
    accounts = [];
    emit();
  }
  function request(method) {
    if (pending)
      return Promise.reject(fail(-32002, "A Solana approval is already open."));
    pending = true;
    const epoch = generation,
      channel = crypto.randomUUID();
    const popup = window.open(
      `${local}/solana-connect#${channel}`,
      "_blank",
      "popup,width=520,height=700",
    );
    if (!popup) {
      pending = false;
      return Promise.reject(fail(4001, "Allow the local wallet popup."));
    }
    return new Promise((resolve, reject) => {
      let settled = false,
        posted = false;
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(closed);
        window.removeEventListener("message", receive);
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending = false;
        cancel = null;
        if (epoch !== generation)
          error = { code: 4001, message: "Connection cancelled" };
        if (error || method !== "connect") {
          cleanup();
          popup.close();
        } else connection = { popup, cleanup, expires: Date.now() + 300000 };
        error
          ? reject(
              fail(
                Number.isInteger(error.code) ? error.code : 4100,
                "Wallet request rejected or expired",
              ),
            )
          : resolve(result);
      };
      const receive = (e) => {
        const m = e.data;
        if (
          e.source !== popup ||
          e.origin !== local ||
          m?.protocol !== "zecone:solana:1" ||
          m.channel !== channel ||
          epoch !== generation
        )
          return;
        if (m.kind === "ready" && !posted && !settled) {
          posted = true;
          popup.postMessage(
            { protocol: "zecone:solana:1", channel, kind: "request", method },
            local,
          );
        } else if (m.kind === "response") finish(m.error, m.result);
        else if (m.kind === "event" && m.event === "disconnect") clear();
      };
      const timer = setTimeout(() => finish({ code: 4001 }), 120000);
      const closed = setInterval(() => {
        if (
          popup.closed ||
          (connection?.popup === popup && Date.now() >= connection.expires)
        ) {
          if (!settled) finish({ code: 4001 });
          else clear();
        }
      }, 500);
      cancel = () => finish({ code: 4001 });
      window.addEventListener("message", receive);
    });
  }
  function account(a) {
    if (
      !a ||
      typeof a.address !== "string" ||
      !Array.isArray(a.publicKey) ||
      a.publicKey.length !== 32 ||
      a.publicKey.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    )
      throw fail(4100, "Invalid account response");
    // Base58 encoding only; checks address/bytes identity, not signing authority.
    const alphabet =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n,
      encoded = "",
      zeros = 0;
    for (const byte of a.publicKey) n = n * 256n + BigInt(byte);
    while (n > 0n) {
      encoded = alphabet[Number(n % 58n)] + encoded;
      n /= 58n;
    }
    while (zeros < 32 && a.publicKey[zeros] === 0) zeros++;
    if ("1".repeat(zeros) + encoded !== a.address)
      throw fail(4100, "Account identity mismatch");
    return Object.freeze({
      address: a.address,
      publicKey: new Uint8Array(a.publicKey),
      chains: Object.freeze(["solana:devnet"]),
      features: Object.freeze([]),
    });
  }
  async function connect(input) {
    if (
      input !== undefined &&
      (!input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((k) => k !== "silent") ||
        (input.silent !== undefined && typeof input.silent !== "boolean"))
    )
      throw fail(-32602, "Invalid connect request");
    if (
      connection &&
      (connection.popup.closed || Date.now() >= connection.expires)
    )
      clear();
    if (input?.silent || accounts.length) return { accounts: [...accounts] };
    const epoch = generation;
    const a = await request("connect");
    if (epoch !== generation) throw fail(4001, "Connection cancelled");
    try {
      accounts = [account(a)];
    } catch (e) {
      clear();
      throw e;
    }
    emit();
    return { accounts: [...accounts] };
  }
  const wallet = Object.freeze({
    version: "1.0.0",
    name: "ZecOne",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzEyMTIxMiIvPjx0ZXh0IHg9IjgiIHk9IjI0IiBmaWxsPSIjZmZmIiBmb250LXNpemU9IjI0Ij5aPC90ZXh0Pjwvc3ZnPg==",
    chains: Object.freeze(["solana:devnet"]),
    get accounts() {
      if (
        connection &&
        (connection.popup.closed || Date.now() >= connection.expires)
      )
        clear();
      return [...accounts];
    },
    features: Object.freeze({
      "standard:connect": Object.freeze({ version: "1.0.0", connect }),
      "standard:disconnect": Object.freeze({
        version: "1.0.0",
        disconnect: async () => {
          clear();
          await request("disconnect");
        },
      }),
      "standard:events": Object.freeze({
        version: "1.0.0",
        on: (event, listener) => {
          if (event !== "change" || typeof listener !== "function")
            throw fail(-32602, "Invalid event subscription");
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
    }),
  });
  const register = (api) => {
    if (typeof api?.register === "function") api.register(wallet);
  };
  window.addEventListener("wallet-standard:app-ready", (e) =>
    register(e.detail),
  );
  window.addEventListener("pagehide", clear);
  window.dispatchEvent(
    new CustomEvent("wallet-standard:register-wallet", { detail: register }),
  );
})();
