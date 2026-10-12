// Offline connector-policy tests. No private keys, external RPC calls, or broadcasts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Dapps } from "../services/wallet/dapps.ts";
import {
  RpcError,
  originOf,
  rpcParams,
  transaction,
  typedMessage,
} from "../services/wallet/dapp-policy.ts";
import type { Session } from "../services/wallet/security.ts";
import { randomUUID } from "node:crypto";

const origin = "https://dapp.example";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "zecone-dapps-"));
  const user = privateKeyToAccount(generatePrivateKey());
  const d = new Dapps(user.address, join(dir, "dapps.sqlite"));
  return { d, user, close: () => d.db.close() };
}
const session: Session = {
  id: "local-session",
  csrf: "f".repeat(64),
  expires: Date.now() + 600_000,
  connected: 1,
};

test("origin policy accepts exact HTTPS and loopback origins and rejects spoofed or unsafe origins", () => {
  assert.equal(originOf(origin), origin);
  assert.equal(
    originOf("https://dapp.example.evil"),
    "https://dapp.example.evil",
  ); // valid but unrelated origin; it never inherits this origin's grant.
  assert.equal(originOf("http://127.0.0.1:4321"), "http://127.0.0.1:4321");
  for (const value of [
    "https://dapp.example/path",
    "https://user@dapp.example",
    "http://192.168.1.4",
    "file:///tmp/app",
    "null",
    "https://dapp.example\n",
  ])
    assert.throws(() => originOf(value));
});

test("EIP-1193 array and object parameter forms normalize without losing transaction fields", () => {
  const body = {
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    value: "0x0",
  };
  assert.deepEqual(rpcParams([body]), [body]);
  assert.deepEqual(rpcParams(body), [body]);
  assert.throws(() => rpcParams(null));
});

test("address access is opt-in, request approval is idempotent, and revocation is origin-bound", async () => {
  const f = fixture();
  try {
    const requestId = randomUUID(),
      channel = randomUUID();
    assert.deepEqual(
      await f.d.request(session, {
        id: requestId,
        channel,
        origin,
        method: "eth_accounts",
        params: [],
      }),
      { done: true, result: [] },
    );
    const req = (await f.d.request(session, {
      id: requestId,
      channel,
      origin,
      method: "eth_requestAccounts",
      params: [],
    })) as any;
    assert.equal(req.state, "pending");
    assert.equal(req.origin, origin);
    assert.equal(req.review.account, f.user.address);
    const retry = (await f.d.request(session, {
      id: requestId,
      channel,
      origin,
      method: "eth_requestAccounts",
      params: [],
    })) as any;
    assert.equal(retry.id, requestId);
    await assert.rejects(
      f.d.request(session, {
        id: requestId,
        channel,
        origin,
        method: "eth_requestAccounts",
        params: [1],
      }),
      /replay/i,
    );
    const done = (await f.d.approve(
      session,
      requestId,
      req.reviewHash,
      true,
    )) as any;
    assert.equal(done.result[0], f.user.address);
    assert.deepEqual(
      (
        (await f.d.request(session, {
          id: randomUUID(),
          channel,
          origin,
          method: "eth_accounts",
          params: [],
        })) as any
      ).result,
      [f.user.address],
    );
    f.d.revoke(origin);
    assert.deepEqual(
      (
        (await f.d.request(session, {
          id: randomUUID(),
          channel,
          origin,
          method: "eth_accounts",
          params: [],
        })) as any
      ).result,
      [],
    );
  } finally {
    f.close();
  }
});

test("channel binding prevents origin and local-session substitution", () => {
  const f = fixture();
  try {
    const channel = randomUUID();
    f.d.bind(session, channel, origin);
    assert.throws(
      () => f.d.bind(session, channel, "https://evil.example"),
      /mismatch/i,
    );
    assert.throws(
      () => f.d.bind({ ...session, id: "other" }, channel, origin),
      /mismatch/i,
    );
  } finally {
    f.close();
  }
});

test("unapproved signature/transaction and unsupported RPC methods fail before signing", async () => {
  const f = fixture();
  try {
    const call = (method: string, params: unknown[] = []) =>
      f.d.request(session, {
        id: randomUUID(),
        channel: randomUUID(),
        origin,
        method,
        params,
      });
    await assert.rejects(
      call("personal_sign", ["0x6869", f.user.address]),
      (e: any) => e instanceof RpcError && e.code === 4100,
    );
    await assert.rejects(
      call("eth_sendTransaction", [
        { from: f.user.address, to: f.user.address, value: "0x0" },
      ]),
      (e: any) => e instanceof RpcError && e.code === 4100,
    );
    await assert.rejects(
      call("eth_sign"),
      (e: any) => e instanceof RpcError && e.code === 4200,
    );
    await assert.rejects(
      call("eth_signTransaction"),
      (e: any) => e instanceof RpcError && e.code === 4200,
    );
  } finally {
    f.close();
  }
});

test("fixed-chain request rejects wrong networks and malformed transaction fields", async () => {
  const f = fixture();
  try {
    const channel = randomUUID();
    f.d.db
      .prepare("INSERT INTO permissions VALUES(?,?)")
      .run(origin, Date.now());
    const call = (method: string, params: unknown[] = []) =>
      f.d.request(session, {
        id: randomUUID(),
        channel,
        origin,
        method,
        params,
      });
    await assert.rejects(
      call("wallet_switchEthereumChain", [{ chainId: "0x1" }]),
      (e: any) => e instanceof RpcError && e.code === 4901,
    );
    assert.equal(
      (
        (await call("wallet_switchEthereumChain", [
          { chainId: "0x14a34" },
        ])) as any
      ).result,
      null,
    );
    await assert.rejects(
      call("eth_sendTransaction", [
        {
          from: f.user.address,
          to: f.user.address,
          value: "0x0",
          gas: "0x5208",
        },
      ]),
      /field/i,
    );
    await assert.rejects(
      call("eth_sendTransaction", [
        {
          from: privateKeyToAccount(generatePrivateKey()).address,
          to: f.user.address,
          value: "0x1",
        },
      ]),
      /sender/i,
    );
    assert.throws(
      () =>
        transaction(
          [
            {
              from: f.user.address,
              to: f.user.address,
              value: "0x1",
              chainId: "0x1",
            },
          ],
          f.user.address,
        ),
      /Base Sepolia/i,
    );
    assert.throws(() =>
      typedMessage(
        [
          f.user.address,
          JSON.stringify({
            domain: { chainId: 1, verifyingContract: f.user.address },
            types: {},
            primaryType: "X",
            message: {},
          }),
        ],
        f.user.address,
      ),
    );
  } finally {
    f.close();
  }
});

test("EIP-1193 read methods expose only chain id and the public EVM address", async () => {
  const f = fixture();
  try {
    const channel = randomUUID();
    const chain = await f.d.request(session, {
      id: randomUUID(),
      channel,
      origin,
      method: "eth_chainId",
      params: [],
    });
    const accounts = await f.d.request(session, {
      id: randomUUID(),
      channel,
      origin,
      method: "eth_accounts",
      params: [],
    });
    assert.deepEqual(chain, { done: true, result: "0x14a34" });
    assert.deepEqual(accounts, { done: true, result: [] });
    const serialized = JSON.stringify([chain, accounts]);
    for (const marker of [
      "shielded",
      "viewingKey",
      "zatoshis",
      "zcash-testnet",
      "seed",
    ])
      assert.equal(serialized.includes(marker), false);
  } finally {
    f.close();
  }
});
