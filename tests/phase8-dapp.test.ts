// Public provider fixtures only. No keys, backend journals or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
function harness(file: string) {
  const handlers = new Map<string, Set<Function>>(),
    popups: any[] = [],
    events: any[] = [],
    timers = new Map<number, Function>();
  let serial = 0,
    wallet: any;
  const win: any = {
    addEventListener: (name: string, fn: Function) => {
      const s = handlers.get(name) ?? new Set();
      s.add(fn);
      handlers.set(name, s);
    },
    removeEventListener: (name: string, fn: Function) =>
      handlers.get(name)?.delete(fn),
    dispatchEvent: (e: any) => {
      events.push(e);
      if (e.type === "wallet-standard:register-wallet")
        e.detail({ register: (w: any) => (wallet = w) });
      for (const fn of handlers.get(e.type) ?? []) fn(e);
    },
    postMessage: () => {},
    open: (url: string) => {
      const p = {
        url,
        closed: false,
        close() {
          this.closed = true;
        },
        postMessage() {},
      };
      popups.push(p);
      return p;
    },
  };
  win.top = win;
  const context = createContext({
    window: win,
    location: { origin: "https://fixture.invalid" },
    crypto: { randomUUID },
    Uint8Array,
    CustomEvent: class {
      type: string;
      detail: any;
      constructor(type: string, o: any) {
        this.type = type;
        this.detail = o.detail;
      }
    },
    setTimeout: (fn: Function) => {
      timers.set(++serial, fn);
      return serial;
    },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: Function) => {
      timers.set(++serial, fn);
      return serial;
    },
    clearInterval: (id: number) => timers.delete(id),
  });
  const inject = () => runInContext(readFileSync(file, "utf8"), context);
  inject();
  return {
    inject,
    events,
    popups,
    win,
    get wallet() {
      return wallet;
    },
    send: (p: any, kind: string, rest: any = {}) => {
      const data = {
        protocol: "zecone:solana:1",
        channel: p.url.split("#")[1],
        kind,
        ...rest,
      };
      for (const fn of [...(handlers.get("message") ?? [])])
        fn({ source: p, origin: "http://127.0.0.1:3210", data });
    },
    expire: () => {
      for (const f of [...timers.values()]) f();
    },
  };
}
test("8D0 duplicate MAIN-world injection preserves one EVM provider identity and one Solana registration", () => {
  const e = harness("extension/inpage.js");
  e.inject();
  assert.equal(
    e.events.filter((x) => x.type === "eip6963:announceProvider").length,
    1,
  );
  const s = harness("extension/solana.js"),
    original = s.wallet;
  s.inject();
  assert.equal(s.wallet, original);
  assert.equal(s.events.length, 1);
});
test("8D0 Solana disconnect cancels a resolved-but-not-delivered approval instead of restoring accounts", async () => {
  const h = harness("extension/solana.js");
  const connecting = h.wallet.features["standard:connect"].connect();
  const rejected = assert.rejects(connecting, { code: 4001 });
  h.send(h.popups[0], "response", {
    result: { address: "1".repeat(32), publicKey: Array(32).fill(0) },
  });
  const disconnect = h.wallet.features["standard:disconnect"].disconnect();
  h.send(h.popups[1], "response", { result: null });
  await disconnect;
  await rejected;
  assert.equal(h.wallet.accounts.length, 0);
});
test("8D0 Solana public-key byte/address binding agrees with SDK encoding and rejects substitution", async () => {
  for (const wrong of [false, true]) {
    const h = harness("extension/solana.js"),
      bytes = Array(32).fill(3),
      address = getBase58Decoder().decode(new Uint8Array(bytes));
    const p = h.wallet.features["standard:connect"].connect();
    h.send(h.popups[0], "response", {
      result: { address: wrong ? "1".repeat(32) : address, publicKey: bytes },
    });
    if (wrong) {
      await assert.rejects(p, { code: 4100 });
      assert.equal(h.wallet.accounts.length, 0);
    } else {
      assert.equal((await p).accounts[0].address, address);
      h.win.dispatchEvent({ type: "pagehide" });
      assert.equal(h.wallet.accounts.length, 0);
    }
  }
});
test("8D0 stale Solana approval is closed and its later response cannot disclose an account", async () => {
  const h = harness("extension/solana.js"),
    p = h.wallet.features["standard:connect"].connect();
  const rejected = assert.rejects(p, { code: 4001 });
  h.expire();
  await rejected;
  h.send(h.popups[0], "response", {
    result: { address: "1".repeat(32), publicKey: Array(32).fill(0) },
  });
  assert.equal(h.wallet.accounts.length, 0);
  assert.equal(h.popups[0].closed, true);
  const pending = harness("extension/solana.js"),
    next = pending.wallet.features["standard:connect"].connect();
  const cancelled = assert.rejects(next, { code: 4001 });
  pending.send(pending.popups[0], "event", { event: "disconnect" });
  await cancelled;
  pending.send(pending.popups[0], "response", {
    result: { address: "1".repeat(32), publicKey: Array(32).fill(0) },
  });
  assert.equal(pending.wallet.accounts.length, 0);
});
