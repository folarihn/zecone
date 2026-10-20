// Disposable fixtures. No live RPC, key unlock, payment or broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { blockhash, generateKeyPairSigner } from "@solana/kit";
import { encodeFunctionData, getAddress, type Hex } from "viem";
import { Store } from "../services/execution/store.ts";
import type { Executor } from "../services/execution/worker.ts";
import { network } from "../services/evm/networks.ts";
import {
  erc20Abi,
  quoteTransfer,
  transferCall,
} from "../services/evm/transfers.ts";
import { EvmTransferSettlement } from "../services/settlement/evm-transfer.ts";
import {
  DEFAULT_TRANSFER_POLICY,
  TRANSFER_ACTIONS,
  transferCapabilities,
  transferOrderId,
  validateTransfer,
  type EvmTransferIntent,
  type TransferPolicy,
} from "../services/settlement/transfers.ts";
import { SolanaSettlement } from "../services/solana/settlement.ts";
import { ata } from "../services/solana/transactions.ts";
import { TOKEN } from "../services/solana/network.ts";
const relayer = getAddress("0x1111111111111111111111111111111111111111");
const recipient = getAddress("0x2222222222222222222222222222222222222222");
const token = getAddress("0x3333333333333333333333333333333333333333");
const hash = `0x${"a".repeat(64)}` as Hex;
const policy: TransferPolicy = {
  ...DEFAULT_TRANSFER_POLICY,
  erc20: { 84532: [{ kind: "ERC20", address: token, decimals: 6 }] },
};
function evmIntent(
  asset: EvmTransferIntent["asset"] = { kind: "native" },
  amount = "1000",
): EvmTransferIntent {
  return {
    family: "evm",
    action:
      asset.kind === "native"
        ? TRANSFER_ACTIONS.EVM_NATIVE
        : TRANSFER_ACTIONS.EVM_ERC20,
    version: 1,
    chainId: 84532,
    relayer,
    recipient,
    amount,
    asset,
    feeCapWei: "1000000",
    quotation: {
      block: "100",
      calldataHash: hash,
      gas: "21000",
      feeCapWei: "1000",
      at: 1000,
      expires: 1090,
    },
    zatoshis: "100000",
    nonce: hash,
    expiry: 2000,
    pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE",
    profileId: randomUUID(),
    requestId: randomUUID(),
  };
}
function adapter(overrides: any = {}) {
  return {
    chainId: 84532,
    policy: network(84532),
    health: async () => ({ chainId: 84532, block: "100", hash }),
    prepare: async () => ({
      nonce: 0n,
      gas: 21000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 1n,
      feeCap: 1000n,
    }),
    client: {
      getBalance: async () => 10n ** 18n,
      getBytecode: async () => "0x60",
      readContract: async ({ functionName }: any) =>
        functionName === "decimals" ? 6 : 10n ** 18n,
      getTransactionCount: async () => 0n,
      getTransaction: async () => ({
        from: relayer,
        to: recipient,
        value: 1000n,
        input: "0x",
      }),
    },
    ...overrides,
  } as any;
}
test("transfer policy accepts only capped testnet assets and allowlisted tokens", () => {
  assert.equal(validateTransfer(evmIntent(), policy, 1000).family, "evm");
  assert.throws(
    () => validateTransfer({ ...evmIntent(), chainId: 1 as any }, policy, 1000),
    /unsupported_testnet/,
  );
  assert.throws(
    () => validateTransfer({ ...evmIntent(), amount: "0" }, policy, 1000),
    /INVALID_AMOUNT/,
  );
  assert.throws(
    () =>
      validateTransfer(
        { ...evmIntent(), amount: (10n ** 16n + 1n).toString() },
        policy,
        1000,
      ),
    /AMOUNT_CAP/,
  );
  const erc20 = evmIntent({ kind: "ERC20", address: token, decimals: 6 });
  assert.equal(
    validateTransfer(erc20, policy, 1000).action,
    "EVM_ERC20_TRANSFER",
  );
  assert.throws(
    () =>
      validateTransfer(
        { ...erc20, asset: { kind: "ERC20", address: recipient, decimals: 6 } },
        policy,
        1000,
      ),
    /TOKEN_NOT_ALLOWLISTED/,
  );
  assert.throws(
    () =>
      validateTransfer({ ...evmIntent(), recipient: relayer }, policy, 1000),
    /INVALID_RECIPIENT/,
  );
  assert.throws(
    () => validateTransfer({ ...evmIntent(), expiry: 0 }, policy, 1000),
    /INVALID_TRANSFER_INTENT/,
  );
  assert.equal(
    transferCapabilities(policy).find((c) => c.action === "EVM_ERC20_TRANSFER")!
      .status,
    "implemented-testnet-read-only",
  );
  assert.equal(
    transferCapabilities().find((c) => c.action === "EVM_ERC20_TRANSFER")!
      .status,
    "blocked-configuration",
  );
});
test("native and ERC-20 calls are exact and contain no arbitrary calldata", () => {
  assert.deepEqual(transferCall(evmIntent()), {
    to: recipient,
    data: "0x",
    value: 1000n,
  });
  const call = transferCall(
    evmIntent({ kind: "ERC20", address: token, decimals: 6 }),
  );
  assert.equal(call.to, token);
  assert.equal(call.value, 0n);
  assert.equal(
    call.data,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, 1000n],
    }),
  );
});
test("EVM preview returns the exact call without creating an order", async () => {
  const store = new Store(":memory:"),
    service = new EvmTransferSettlement(store, adapter(), () => 1000),
    preview = await service.preview({
      profileId: randomUUID(),
      requestId: randomUUID(),
      recipient,
      relayer,
      amount: "1000",
      asset: { kind: "native" },
      feeCapWei: "1000000",
      account: "a".repeat(64),
      paymentAddress: "utest1_synthetic",
    });
  assert.equal(preview.financialOrderCreated, false);
  assert.equal(preview.executionAuthorized, false);
  assert.equal(preview.call.to, recipient);
  assert.equal(preview.call.value, "1000");
  assert.equal(preview.call.data, "0x");
  assert.equal(preview.id, transferOrderId(preview.intent));
  assert.equal(store.all().length, 0);
  store.close();
});
test("read-only quote revalidates block, fee and relayer liquidity", async () => {
  const quote = await quoteTransfer(
    adapter(),
    evmIntent(),
    relayer,
    policy,
    1000,
  );
  assert.equal(quote.chainId, 84532);
  assert.equal(quote.block, "100");
  assert.equal(quote.call.to, recipient);
  assert.equal(quote.feeCapWei, "1000");
  assert.equal(quote.expires, 1090);
  await assert.rejects(
    quoteTransfer(
      adapter({
        prepare: async () => ({
          feeCap: 2000000n,
          gas: 1n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          nonce: 0n,
        }),
      }),
      evmIntent(),
      relayer,
      policy,
      1000,
    ),
    /GAS_BUDGET_EXCEEDED/,
  );
  await assert.rejects(
    quoteTransfer(
      adapter({ client: { ...adapter().client, getBalance: async () => 1n } }),
      evmIntent(),
      relayer,
      policy,
      1000,
    ),
    /INSUFFICIENT_RELAYER_LIQUIDITY|gas_budget_exceeded/,
  );
});
function snapshot(intent: EvmTransferIntent, account: string, at = 100000) {
  return {
    network: "zcash-testnet",
    watchOnly: true,
    liveChain: true,
    liveRefundsEnabled: false,
    source: "https://testnet.zec.rocks:443",
    account,
    address: `utest1_${intent.requestId.slice(0, 8)}`,
    birthday: 800,
    tip: 1000,
    scanned: 1000,
    observedAt: at,
    blockHash: "b".repeat(64),
    payments: [
      {
        account,
        txid: "c".repeat(64),
        pool: 4,
        index: 0,
        zatoshis: "100000",
        height: 991,
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
          zatoshis: "100000",
          minedHeight: 991,
          nullifier: "1".repeat(64),
        },
      ],
    },
  } as any;
}
test("EVM transfer order reuses payment observation and executes once", async () => {
  const store = new Store(":memory:"),
    service = new EvmTransferSettlement(store, adapter(), () => 100000),
    account = "a".repeat(64),
    request = {
      profileId: randomUUID(),
      requestId: randomUUID(),
      recipient,
      relayer,
      amount: "1000",
      asset: { kind: "native" as const },
      feeCapWei: "1000000",
      account,
      paymentAddress: `utest1_${randomUUID()}`,
    };
  const view = await service.quote(request, policy);
  assert.equal(view.orderState, "awaiting_payment");
  assert.equal(view.asset.kind, "native");
  assert.equal(store.all().length, 1);
  const intent = service.intent(view.id);
  assert.equal(view.id, transferOrderId(intent));
  await assert.rejects(
    service.quote(
      {
        ...request,
        recipient: getAddress("0x4444444444444444444444444444444444444444"),
      },
      policy,
    ),
    /DELIVERY_POLICY|invalid|RECIPIENT|IDEMPOTENCY/,
  );
  store.observe(snapshot(intent, account), 100000);
  let broadcasts = 0;
  const executor: Executor = {
    prepare: async () => ({ raw: hash, hash }),
    broadcast: async () => {
      broadcasts++;
      return hash;
    },
    receipt: async () => ({
      status: "success",
      hash,
      block: "101",
      recipient,
      amountOut: "1000",
    }),
  };
  await service.execute(view.id, executor);
  assert.equal(store.get(view.id)!.state, "settled");
  assert.equal(broadcasts, 1);
  await service.execute(view.id, executor);
  assert.equal(broadcasts, 1);
  assert.equal(service.view(view.id).txHash, hash);
  store.close();
});
test("ERC-20 transfer requires operator allowlist before any quote", async () => {
  const store = new Store(":memory:"),
    service = new EvmTransferSettlement(store, adapter(), () => 100000, policy),
    blocked = new EvmTransferSettlement(store, adapter(), () => 100000);
  const request = {
    profileId: randomUUID(),
    requestId: randomUUID(),
    recipient,
    relayer,
    amount: "1000",
    asset: { kind: "ERC20" as const, address: token, decimals: 6 },
    feeCapWei: "1000000",
    account: "a".repeat(64),
    paymentAddress: "utest1_synthetic",
  };
  await assert.rejects(blocked.quote(request), /TOKEN_NOT_ALLOWLISTED/);
  assert.equal(store.all().length, 0);
  const view = await service.quote(request, policy);
  assert.equal(view.action, "EVM_ERC20_TRANSFER");
  assert.equal(view.call.to, token);
  store.close();
});
const splRelayer = await generateKeyPairSigner(),
  splRecipient = await generateKeyPairSigner(),
  mint = (await generateKeyPairSigner()).address;
const splPolicy: TransferPolicy = {
  ...DEFAULT_TRANSFER_POLICY,
  spl: [{ kind: "SPL", mint, decimals: 6 }],
};
function solanaFixture() {
  const store = new Store(":memory:"),
    balances = new Map<string, bigint>(),
    accounts = new Map<string, any>();
  const service = new SolanaSettlement(
    store,
    {
      balance: async () => 100000000n,
      latest: async () => ({
        blockhash: blockhash("11111111111111111111111111111111"),
        lastValidBlockHeight: 1000n,
      }),
      fee: async () => 5000n,
      valid: async () => true,
      simulate: async () => ({ err: null, unitsConsumed: 150n }),
      send: async () => {
        throw Error("NO_BROADCAST_IN_TEST");
      },
      receipt: async () => null,
    } as any,
    () => 100000,
    undefined,
  );
  (service.network as any).account = async (address: string) =>
    accounts.get(String(address));
  return {
    store,
    service,
    balances,
    accounts,
    request: {
      profileId: randomUUID(),
      requestId: randomUUID(),
      recipient: splRecipient.address,
      relayer: splRelayer.address,
      lamports: "1000000",
      account: "a".repeat(64),
      paymentAddress: "utest1_synthetic",
    },
    install: async () => {
      accounts.set(mint, {
        owner: TOKEN,
        data: {
          parsed: {
            type: "mint",
            info: { isInitialized: true, decimals: 6, freezeAuthority: null },
          },
        },
      });
      for (const [owner, amount] of [
        [splRelayer.address, 10000000n],
        [splRecipient.address, 0n],
      ] as const) {
        const address = String(await ata(owner, mint));
        accounts.set(address, {
          owner: TOKEN,
          data: {
            parsed: {
              info: {
                owner,
                mint,
                state: "initialized",
                delegate: null,
                closeAuthority: null,
                tokenAmount: { amount: amount.toString() },
              },
            },
          },
        });
        balances.set(address, amount);
      }
    },
  };
}
test("SPL delivery is quoted and prepared through the existing Solana engine", async () => {
  const x = solanaFixture();
  await x.install();
  const view = x.service.quote(x.request, undefined, {
    kind: "SPL",
    mint,
    decimals: 6,
  });
  assert.equal(view.action, "SOLANA_DEVNET_SPL_DELIVERY");
  assert.equal(view.asset.kind, "SPL");
  const intent = x.service.intent(view.id);
  assert.equal(intent.spl!.mint, mint);
  x.store.observe(
    {
      ...snapshot(intent as any, x.request.account),
      address: x.request.paymentAddress,
    } as any,
    100000,
  );
  x.service.authorize(view.id, {
    ...snapshot(intent as any, x.request.account),
    address: x.request.paymentAddress,
  } as any);
  const prepared: any = await x.service.prepare(view.id);
  assert.equal(prepared.state, "AWAITING_EXPLICIT_APPROVAL");
  assert.equal(prepared.action.asset.kind, "SPL");
  assert.equal(prepared.action.asset.mint, mint);
  assert.match(prepared.wire, /^[A-Za-z0-9+/]+={0,2}$/);
  x.store.close();
});
