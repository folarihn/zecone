import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, blockhash } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../services/execution/store.ts";
import {
  SolanaSettlement,
  getCompiledMessage,
  type SettlementNetwork,
} from "../services/solana/settlement.ts";
import { SettlementReview } from "../services/wallet/settlement-review.ts";
import { SolanaTransferFlow } from "../services/settlement/solana-transfer-flow.ts";
import { SourceBindings } from "../services/settlement/source-bindings.ts";
import type { WatchSnapshot } from "../services/signer/watch-evidence.ts";
async function fixture(file = ":memory:") {
  const user = privateKeyToAccount(generatePrivateKey()),
    key = await generateKeyPairSigner(),
    recipient = (await generateKeyPairSigner()).address;
  let time = 100000,
    sends = 0,
    receipt: any = null,
    unavailable = false,
    valid = true;
  const store = new Store(file),
    bindingDb = new DatabaseSync(":memory:");
  const net: SettlementNetwork = {
    balance: async () => 100000000n as any,
    latest: async () => ({
      blockhash: blockhash("11111111111111111111111111111111"),
      lastValidBlockHeight: 1000n,
    }),
    valid: async () => valid,
    fee: async () => 5000n as any,
    simulate: async () => ({ err: null, unitsConsumed: 150n }) as any,
    send: async () => {
      sends++;
      if (unavailable) throw Error("lost response");
      return service.row(id).signature!;
    },
    receipt: async () => receipt,
  };
  const service = new SolanaSettlement(store, net, () => time),
    reads = {
      check: async () => {},
      balance: net.balance,
      terms: async () => {
        throw Error("SWAP_DISABLED");
      },
    },
    review = new SettlementReview(
      service,
      reads,
      () => time,
      new SourceBindings(bindingDb, "isolated"),
    ),
    flow = new SolanaTransferFlow(review, service, user.address);
  const input = {
    profileId: "new-profile",
    requestId: "new-request",
    recipient,
    relayer: key.address,
    lamports: "1000000",
    account: "a".repeat(64),
    paymentAddress: "utest1_SYNTHETIC",
  };
  let id = "";
  const authorize = async () => {
    const r = await flow.review("session", input, "transfer"),
      sig = await user.signMessage({ message: r.message });
    const out = await flow.authorizeSigned(
      "session",
      r.id,
      r.digest,
      sig,
      () => {},
    );
    id = out.orderId;
    return out;
  };
  const snapshot = (depth = 10, amount = "100000"): WatchSnapshot => ({
    network: "zcash-testnet",
    watchOnly: true,
    liveChain: true,
    liveRefundsEnabled: false,
    source: "https://testnet.zec.rocks:443",
    account: input.account,
    address: input.paymentAddress,
    birthday: 800,
    tip: 1000,
    scanned: 1000,
    observedAt: time,
    blockHash: "b".repeat(64),
    payments: [
      {
        account: input.account,
        txid: "c".repeat(64),
        pool: 4,
        index: 0,
        zatoshis: amount,
        height: 1001 - depth,
        blockHash: "d".repeat(64),
      },
    ],
    native: {
      fullViewingKey: "e".repeat(192),
      anchor: "f".repeat(64),
      anchorHeight: 990,
      inputs: [
        {
          paymentKey: `${"c".repeat(64)}:4:0`,
          zatoshis: amount,
          minedHeight: 1001 - depth,
          nullifier: "1".repeat(64),
        } as any,
      ],
    },
  });
  const finalize = () => {
    const p = JSON.parse(service.row(id).prepared!);
    receipt = {
      version: "legacy",
      transaction: {
        signatures: [service.row(id).signature],
        message: getCompiledMessage(p.wire),
      },
      meta: {
        err: null,
        fee: 5000,
        preBalances: [100000000, 0, 0],
        postBalances: [98995000, 1000000, 0],
      },
    };
  };
  return {
    store,
    service,
    flow,
    review,
    user,
    key,
    input,
    net,
    authorize,
    snapshot,
    finalize,
    id: () => id,
    sends: () => sends,
    setTime: (t: number) => {
      time = t;
    },
    setLost: () => {
      unavailable = true;
    },
    expire: () => {
      valid = false;
    },
    close: () => {
      store.close();
      bindingDb.close();
    },
  };
}
test("SOL wallet signature to owned payment to exact executor and finalized effects", async () => {
  const x = await fixture();
  try {
    await x.authorize();
    assert.equal(x.flow.state(x.id()).state, "PAYMENT_PENDING");
    await x.flow.observe(x.id(), { observe: async () => x.snapshot(9) });
    assert.equal(x.flow.state(x.id()).state, "DETECTED");
    await x.flow.observe(x.id(), { observe: async () => x.snapshot() });
    assert.equal(x.flow.state(x.id()).state, "CONFIRMED");
    const p = await x.flow.prepare(x.id());
    await x.flow.execute(
      x.id(),
      { orderId: x.id(), digest: p.digest, approved: true },
      x.key,
    );
    assert.equal(x.sends(), 1);
    x.finalize();
    assert.equal((await x.flow.reconcile(x.id())).state, "COMPLETED");
    await assert.rejects(
      x.flow.execute(
        x.id(),
        { orderId: x.id(), digest: p.digest, approved: true },
        x.key,
      ),
    );
    assert.equal(x.sends(), 1);
  } finally {
    x.close();
  }
});
test("SOL grants reject wrong signatures, session changes and changed terms", async () => {
  const x = await fixture();
  try {
    const r = await x.flow.review("session", x.input, "transfer"),
      other = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(
      x.flow.authorizeSigned(
        "session",
        r.id,
        r.digest,
        await other.signMessage({ message: r.message }),
        () => {},
      ),
      /USER_SIGNATURE/,
    );
    const sig = await x.user.signMessage({ message: r.message });
    await assert.rejects(
      x.flow.authorizeSigned("other", r.id, r.digest, sig, () => {}),
      /REVIEW_UNAVAILABLE/,
    );
    await assert.rejects(
      x.flow.authorizeSigned("session", r.id, r.digest, sig, () => {
        throw Error("revoked");
      }),
      /revoked/,
    );
    x.store.db
      .prepare(
        "UPDATE wallet_settlement_reviews SET payload=replace(payload,'1000000','2000000') WHERE id=?",
      )
      .run(r.id);
    await assert.rejects(
      x.flow.authorizeSigned("session", r.id, r.digest, sig, () => {}),
      /DIGEST/,
    );
    assert.equal(x.store.all().length, 0);
  } finally {
    x.close();
  }
});
test("SOL raw imported observations and failed scans cannot unlock preparation", async () => {
  const x = await fixture();
  try {
    await x.authorize();
    x.service.authorize(x.id(), x.snapshot());
    await assert.rejects(x.flow.prepare(x.id()), /NATIVE_OBSERVATION/);
    await x.flow.observe(x.id(), { observe: async () => x.snapshot() });
    await assert.rejects(
      x.flow.observe(x.id(), {
        observe: async () => {
          throw Error("offline");
        },
      }),
    );
    await assert.rejects(x.flow.prepare(x.id()), /NATIVE_OBSERVATION/);
  } finally {
    x.close();
  }
});
test("SOL watch leases exclude concurrent prepare; underpayments and extra payments fail closed", async () => {
  for (const amount of ["99999", "100001"]) {
    const x = await fixture();
    try {
      await x.authorize();
      await x.flow.observe(x.id(), {
        observe: async () => x.snapshot(10, amount),
      });
      await assert.rejects(x.flow.prepare(x.id()));
    } finally {
      x.close();
    }
  }
  const x = await fixture();
  try {
    await x.authorize();
    let release!: (s: WatchSnapshot) => void;
    const pending = x.flow.observe(x.id(), {
      observe: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    await new Promise((r) => setImmediate(r));
    await assert.rejects(x.flow.prepare(x.id()));
    release(x.snapshot());
    await pending;
  } finally {
    x.close();
  }
});
test("SOL late exact approval and expired blockhash never invoke signer", async () => {
  for (const expiry of ["approval", "blockhash"]) {
    const x = await fixture();
    try {
      await x.authorize();
      await x.flow.observe(x.id(), { observe: async () => x.snapshot() });
      const p = await x.flow.prepare(x.id());
      if (expiry === "approval") x.setTime(100091);
      else x.expire();
      const poison = new Proxy(
        { address: x.key.address },
        {
          get(t, k) {
            if (k !== "address") throw Error("SIGNER_TOUCHED");
            return t.address;
          },
        },
      ) as any;
      await assert.rejects(
        x.flow.execute(
          x.id(),
          { orderId: x.id(), digest: p.digest, approved: true },
          poison,
        ),
        expiry === "approval" ? /EXACT_APPROVAL/ : /BLOCKHASH/,
      );
      assert.equal(x.sends(), 0);
    } finally {
      x.close();
    }
  }
});
test("SOL lost broadcast response and actual restart reconcile one original signature", async () => {
  const file = join(
      mkdtempSync(join(tmpdir(), "zecone-sol-")),
      "orders.sqlite",
    ),
    x = await fixture(file);
  await x.authorize();
  await x.flow.observe(x.id(), { observe: async () => x.snapshot() });
  const p = await x.flow.prepare(x.id());
  x.setLost();
  await x.flow.execute(
    x.id(),
    { orderId: x.id(), digest: p.digest, approved: true },
    x.key,
  );
  x.finalize();
  const id = x.id(),
    authorizer = x.user.address,
    net = x.net;
  assert.equal(x.sends(), 1);
  x.close();
  const store = new Store(file);
  try {
    const service = new SolanaSettlement(store, net, () => 100100),
      review = new SettlementReview(
        service,
        {
          check: async () => {},
          balance: net.balance,
          terms: async () => {
            throw Error();
          },
        },
        () => 100100,
      ),
      flow = new SolanaTransferFlow(review, service, authorizer);
    assert.equal((await flow.reconcile(id)).state, "COMPLETED");
    await assert.rejects(flow.prepare(id));
    assert.equal(x.sends(), 1);
  } finally {
    store.close();
  }
});
test("SOL unsupported tokens, duplicate grants and cross-session status stay blocked", async () => {
  const x = await fixture();
  try {
    await assert.rejects(
      x.flow.review("session", x.input, "swap"),
      /NATIVE_SOL/,
    );
    await x.authorize();
    assert.throws(() => x.flow.scopedState("other", x.id()));
    await assert.rejects(
      x.flow.review("session", x.input, "transfer"),
      /ISOLATED/,
    );
    assert.equal(x.store.all().length, 1);
  } finally {
    x.close();
  }
});

test("SOL exact approval is checked again after asynchronous preflight", async () => {
  const x = await fixture();
  try {
    await x.authorize();
    await x.flow.observe(x.id(), { observe: async () => x.snapshot() });
    const p = await x.flow.prepare(x.id());
    x.net.fee = async () => {
      x.setTime(100091);
      return 5000n as any;
    };
    const poison = new Proxy(
      { address: x.key.address },
      {
        get(t, k) {
          if (k !== "address") throw Error("SIGNER_TOUCHED");
          return t.address;
        },
      },
    ) as any;
    await assert.rejects(
      x.flow.execute(
        x.id(),
        { orderId: x.id(), digest: p.digest, approved: true },
        poison,
      ),
      /EXACT_APPROVAL_EXPIRED/,
    );
    assert.equal(x.sends(), 0);
  } finally {
    x.close();
  }
});
test("SOL concurrent execution makes one claim and one submission", async () => {
  const x = await fixture();
  try {
    await x.authorize();
    await x.flow.observe(x.id(), { observe: async () => x.snapshot() });
    const p = await x.flow.prepare(x.id()),
      approval = { orderId: x.id(), digest: p.digest, approved: true as const };
    const results = await Promise.allSettled([
      x.flow.execute(x.id(), approval, x.key),
      x.flow.execute(x.id(), approval, x.key),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(x.sends(), 1);
  } finally {
    x.close();
  }
});
test("shared source journal prevents two state owners reserving the same SOL relayer", () => {
  const path = join(
      mkdtempSync(join(tmpdir(), "zecone-relay-")),
      "replay.sqlite",
    ),
    aDb = new DatabaseSync(path),
    bDb = new DatabaseSync(path),
    a = new SourceBindings(aDb, "first"),
    b = new SourceBindings(bDb, "second");
  try {
    a.reserveRelayer(
      "solana:devnet",
      "public-relayer",
      "one",
      1010000n,
      10000000n,
    );
    assert.throws(
      () =>
        b.reserveRelayer(
          "solana:devnet",
          "public-relayer",
          "two",
          1010000n,
          10000000n,
        ),
      /ALREADY_RESERVED/,
    );
    b.completeRelayer("one");
    assert.throws(() =>
      b.reserveRelayer(
        "solana:devnet",
        "public-relayer",
        "two",
        1010000n,
        10000000n,
      ),
    );
    a.completeRelayer("one");
    b.reserveRelayer(
      "solana:devnet",
      "public-relayer",
      "two",
      1010000n,
      10000000n,
    );
  } finally {
    aDb.close();
    bDb.close();
  }
});
