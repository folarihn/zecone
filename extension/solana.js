// Wallet Standard foundation, separate from EIP-1193. No keys or network RPCs.
// Discovery protocol: @wallet-standard/wallet registerWallet (1.1.1).
(() => {
  if (window !== window.top) return;
  const local = "http://127.0.0.1:3210";
  const listeners = new Set();
  let accounts = [],
    pending = false;
  const fail = (code, message) => Object.assign(new Error(message), { code });
  function emit() {
    for (const fn of [...listeners]) {
      try {
        fn({ accounts: [...accounts] });
      } catch {}
    }
  }
  function request(method) {
    if (pending)
      return Promise.reject(fail(-32002, "A Solana approval is already open."));
    pending = true;
    const channel = crypto.randomUUID();
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
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(closed);
        window.removeEventListener("message", receive);
        pending = false;
        error
          ? reject(
              fail(error.code || 4100, error.message || "Request rejected"),
            )
          : resolve(result);
      };
      const receive = (e) => {
        const m = e.data;
        if (
          e.source !== popup ||
          e.origin !== local ||
          m?.protocol !== "zecone:solana:1" ||
          m.channel !== channel
        )
          return;
        if (m.kind === "ready")
          popup.postMessage(
            { protocol: "zecone:solana:1", channel, kind: "request", method },
            local,
          );
        else if (m.kind === "response") finish(m.error, m.result);
      };
      const timer = setTimeout(
        () => finish({ code: 4001, message: "Approval expired" }),
        120000,
      );
      const closed = setInterval(() => {
        if (popup.closed) finish({ code: 4001, message: "Approval closed" });
      }, 500);
      window.addEventListener("message", receive);
    });
  }
  async function connect(input) {
    if (input?.silent) return { accounts: [] };
    const a = await request("connect");
    if (
      !a ||
      typeof a.address !== "string" ||
      !Array.isArray(a.publicKey) ||
      a.publicKey.length !== 32 ||
      a.publicKey.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    )
      throw fail(4100, "Invalid account response");
    accounts = [
      Object.freeze({
        address: a.address,
        publicKey: new Uint8Array(a.publicKey),
        chains: ["solana:devnet"],
        features: ["solana:signMessage", "solana:signTransaction"],
      }),
    ];
    emit();
    return { accounts: [...accounts] };
  }
  async function rejectSigning(method, inputs) {
    if (inputs.length !== 1 || !accounts.includes(inputs[0]?.account))
      throw fail(4100, "Select the connected devnet account.");
    if (method === "signTransaction" && inputs[0].chain !== "solana:devnet")
      throw fail(4901, "Solana devnet only.");
    const bytes =
      inputs[0][method === "signMessage" ? "message" : "transaction"];
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length === 0 ||
      bytes.length > 1232
    )
      throw fail(-32602, "Invalid signing request");
    // This backend supports review/rejection only. Never return synthetic signatures.
    await request(method);
    throw fail(4200, "Browser signing is disabled in Phase 7A validation.");
  }
  const wallet = Object.freeze({
    version: "1.0.0",
    name: "ZecOne",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzEyMTIxMiIvPjx0ZXh0IHg9IjgiIHk9IjI0IiBmaWxsPSIjZmZmIiBmb250LXNpemU9IjI0Ij5aPC90ZXh0Pjwvc3ZnPg==",
    chains: Object.freeze(["solana:devnet"]),
    get accounts() {
      return [...accounts];
    },
    features: Object.freeze({
      "standard:connect": Object.freeze({ version: "1.0.0", connect }),
      "standard:disconnect": Object.freeze({
        version: "1.0.0",
        disconnect: async () => {
          await request("disconnect");
          accounts = [];
          emit();
        },
      }),
      "standard:events": Object.freeze({
        version: "1.0.0",
        on: (event, listener) => {
          if (event !== "change") throw fail(4200, "Unsupported event");
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
      "solana:signMessage": Object.freeze({
        version: "1.0.0",
        signMessage: (...inputs) => rejectSigning("signMessage", inputs),
      }),
      "solana:signTransaction": Object.freeze({
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signTransaction: (...inputs) =>
          rejectSigning("signTransaction", inputs),
      }),
    }),
  });
  const register = ({ register }) => register(wallet);
  window.addEventListener("wallet-standard:app-ready", (e) =>
    register(e.detail),
  );
  window.dispatchEvent(
    new CustomEvent("wallet-standard:register-wallet", { detail: register }),
  );
})();
