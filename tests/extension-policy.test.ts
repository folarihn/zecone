import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import {
  senderOrigin,
  validateRequest,
  accountsValid,
  CHAINS,
  idValid,
} from "../extension/policy.js";
const sender = {
  id: "zecone",
  frameId: 0,
  tab: { id: 1 },
  documentId: "document-1",
  origin: "https://opensea.io",
  url: "https://opensea.io/collection/test",
};
test("extension runtime origin comes from the browser sender, never a payload", () => {
  assert.equal(senderOrigin(sender, "zecone"), "https://opensea.io");
  for (const change of [
    { id: "other" },
    { frameId: 1 },
    { tab: undefined },
    { documentId: "" },
    { origin: "https://opensea.io.evil.example" },
    { url: "https://opensea.io.evil.example/", origin: "https://opensea.io" },
    { url: "http://opensea.io/" },
    { url: "https://www.opensea.io/" },
  ])
    assert.throws(() => senderOrigin({ ...sender, ...change }, "zecone"));
});
test("extension schema rejects forged authority, oversized data and malformed identity", () => {
  const base = {
    kind: "request",
    id: randomUUID(),
    method: "eth_requestAccounts",
    params: [],
  };
  assert.doesNotThrow(() => validateRequest(base));
  for (const change of [
    { origin: sender.origin },
    { approved: true },
    { kind: "wallet" },
    { id: "replay" },
    { params: null },
    { params: ["x".repeat(17001)] },
  ])
    assert.throws(() => validateRequest({ ...base, ...change }));
});
test("extension denies unimplemented, Zcash, key export and raw signing RPCs", () => {
  for (const method of [
    "wallet_requestPermissions",
    "wallet_getPermissions",
    "eth_sign",
    "eth_sendRawTransaction",
    "zcash_getBalance",
    "zcash_listTransactions",
    "zcash_exportViewingKey",
    "zcash_exportSpendingKey",
    "wallet_exportPrivateKey",
    "zecone_payWithZec",
    "readDatabase",
  ])
    assert.throws(
      () =>
        validateRequest({
          kind: "request",
          id: randomUUID(),
          method,
          params: [],
        }),
      { code: 4200 },
    );
});
test("extension validates parameter shapes before routing approvals", () => {
  const request = (method: string, params: unknown[]) => ({
    kind: "request",
    id: randomUUID(),
    method,
    params,
  });
  for (const method of [
    "eth_requestAccounts",
    "eth_accounts",
    "eth_chainId",
    "net_version",
    "eth_blockNumber",
  ])
    assert.throws(() => validateRequest(request(method, [{}])), {
      code: -32602,
    });
  for (const method of [
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "eth_sendTransaction",
  ]) {
    for (const params of [[], [null], ["0x1"], [[]]])
      assert.throws(() => validateRequest(request(method, params)), {
        code: -32602,
      });
  }
  for (const method of [
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
  ])
    assert.throws(
      () => validateRequest(request(method, [{ chainId: 84532 }])),
      { code: -32602 },
    );
  assert.throws(
    () => validateRequest(request("eth_sendTransaction", [{ chainId: 84532 }])),
    { code: -32602 },
  );
  assert.doesNotThrow(() =>
    validateRequest(
      request("wallet_switchEthereumChain", [{ chainId: "0x14A34" }]),
    ),
  );
  assert.doesNotThrow(() =>
    validateRequest(request("eth_sendTransaction", [{}])),
  );
  assert.doesNotThrow(() =>
    validateRequest(request("eth_sendTransaction", [{ chainId: "0x14a34" }])),
  );
});
test("extension blocks mainnet chain selection and transactions before opening approvals", () => {
  for (const method of [
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "eth_sendTransaction",
  ])
    assert.throws(
      () =>
        validateRequest({
          kind: "request",
          id: randomUUID(),
          method,
          params: [{ chainId: "0x1" }],
        }),
      { code: 4901 },
    );
});
test("extension package has isolated transport, no secret or broad permission capability", () => {
  const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
  assert.equal(manifest.manifest_version, 3);
  for (const key of [
    "permissions",
    "host_permissions",
    "externally_connectable",
    "web_accessible_resources",
  ])
    assert.equal(manifest[key], undefined);
  assert.deepEqual(
    manifest.content_scripts.map((s: any) => s.world),
    ["MAIN", "ISOLATED"],
  );
  for (const script of manifest.content_scripts) {
    assert.equal(script.all_frames, false);
    assert.deepEqual(script.matches, ["https://*/*"]);
  }
  for (const file of [
    "background.js",
    "content.js",
    "inpage.js",
    "popup.js",
    "policy.js",
  ])
    assert.doesNotMatch(
      readFileSync(`extension/${file}`, "utf8"),
      /privateKeyToAccount|mnemonicToAccount|\.secrets|fetch\(|XMLHttpRequest|importScripts\(|eval\(/,
    );
});
test("extension accepts only a single public EVM account projection", () => {
  assert.equal(accountsValid([]), true);
  assert.equal(accountsValid(["0x" + "11".repeat(20)]), true);
  for (const v of [
    ["0x" + "11".repeat(20), "0x" + "22".repeat(20)],
    { balance: 1 },
    ["secret"],
    [1],
    null,
  ])
    assert.equal(accountsValid(v), false);
});

function workerHarness() {
  let connected: Function = () => {},
    ui: Function = () => {};
  const timers = new Map<number, Function>();
  let sequence = 0;
  const chrome = {
    runtime: {
      id: "zecone",
      getURL: (p: string) => `chrome-extension://zecone/${p}`,
      onConnect: { addListener: (f: Function) => (connected = f) },
      onMessage: { addListener: (f: Function) => (ui = f) },
    },
  };
  runInNewContext(
    readFileSync("extension/background.js", "utf8").replace(
      /import\s*\{[\s\S]*?\}\s*from "\.\/policy\.js";/,
      "",
    ),
    {
      chrome,
      senderOrigin,
      validateRequest,
      accountsValid,
      CHAINS,
      idValid,
      Date,
      Map,
      Set,
      Error,
      setTimeout: (f: Function) => {
        timers.set(++sequence, f);
        return sequence;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  const makePort = (source = sender) => {
    const sent: any[] = [];
    let receive: Function = () => {},
      closed: Function = () => {},
      disconnected = false;
    const port = {
      name: "zecone-content-v1",
      sender: source,
      postMessage: (m: any) => sent.push(m),
      disconnect: () => {
        disconnected = true;
        closed();
      },
      onMessage: { addListener: (f: Function) => (receive = f) },
      onDisconnect: { addListener: (f: Function) => (closed = f) },
    };
    connected(port);
    return {
      sent,
      send: (m: any) => receive(m),
      get disconnected() {
        return disconnected;
      },
    };
  };
  const status = (
    source: any = { id: "zecone", url: "chrome-extension://zecone/popup.html" },
  ) => {
    let result: any;
    ui(
      { kind: "status" },
      source,
      (v: any) => (result = JSON.parse(JSON.stringify(v))),
    );
    return result;
  };
  return {
    makePort,
    status,
    expire: () => {
      for (const f of [...timers.values()]) f();
    },
  };
}
test("worker expiry discards late approval responses and prevents request replay", () => {
  const h = workerHarness(),
    p = h.makePort(),
    request = {
      kind: "request",
      id: randomUUID(),
      method: "eth_requestAccounts",
      params: [],
    };
  p.send(request);
  h.expire();
  assert.equal(p.sent.at(-1).error.code, -32002);
  p.send({
    kind: "wallet",
    message: {
      kind: "response",
      id: request.id,
      result: ["0x" + "11".repeat(20)],
    },
  });
  p.send(request);
  assert.equal(p.sent.filter((m) => m.kind === "execute").length, 1);
  assert.equal(h.status().connections[0].account, null);
});
test("worker rejects unknown response IDs, isolates documents, and removes disconnected state", () => {
  const h = workerHarness(),
    p = h.makePort();
  p.send({
    kind: "wallet",
    message: {
      kind: "response",
      id: randomUUID(),
      result: ["0x" + "11".repeat(20)],
    },
  });
  assert.equal(h.status().connections[0].account, null);
  const q = h.makePort({ ...sender, documentId: "document-2" });
  assert.equal(h.status().connections.length, 2);
  p.send({ kind: "closed" });
  assert.equal(h.status().connections.length, 1);
  assert.equal(q.disconnected, false);
});
test("worker extension UI metadata is unavailable to website senders and contains no params", () => {
  const h = workerHarness(),
    p = h.makePort();
  p.send({
    kind: "request",
    id: randomUUID(),
    method: "personal_sign",
    params: ["sensitive-message-marker"],
  });
  assert.equal(h.status(sender), undefined);
  assert.doesNotMatch(
    JSON.stringify(h.status()),
    /sensitive-message-marker|params|signature/,
  );
  assert.equal(h.makePort({ ...sender, frameId: 1 }).disconnected, true);
});
