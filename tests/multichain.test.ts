import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTypedData, keccak256, toHex } from "viem";
import { NETWORK_IDS, chainHex, network, parseChain, validateAddChain } from "../services/evm/networks.ts";
import { transaction } from "../services/wallet/dapp-policy.ts";
import { purchaseTyped, type UnsignedPurchase } from "../services/marketplace/purchase.ts";
import { EthereumSepoliaAdapter } from "../services/evm/adapter.ts";

const user = "0x1865Dd77bFcb632571d3c93144D5634F0D93c714" as const;

test("registry contains only exact testnet chain ids and unique testnet RPCs", () => {
  assert.deepEqual(NETWORK_IDS, [84532, 11155111, 46630]);
  assert.deepEqual(NETWORK_IDS.map(id => network(id).id), [84532, 11155111, 46630]);
  for (const id of NETWORK_IDS) {
    const n = network(id);
    assert.equal(new URL(n.rpc).protocol, "https:");
    assert.equal(n.nativeCurrency.symbol, "ETH");
    assert.ok(n.confirmations > 0 && n.maxGas > 0n && n.gasBudget > 0n);
    assert.throws(() => network(id === 84532 ? 8453 : id === 46630 ? 4663 : 1));
  }
  assert.equal(chainHex(11155111), "0xaa36a7");
  assert.equal(chainHex(46630), "0xb626");
  assert.equal(parseChain("0xaa36a7").id, 11155111);
  assert.throws(() => parseChain("0x01"));
});

test("wallet_addEthereumChain accepts only the exact built-in testnet parameters", () => {
  const n = network(46630);
  const valid = { chainId: "0xb626", chainName: n.name, rpcUrls: [n.rpc], blockExplorerUrls: [n.explorer], nativeCurrency: n.nativeCurrency };
  assert.equal(validateAddChain(valid).id, 46630);
  assert.throws(() => validateAddChain({ ...valid, rpcUrls: ["https://attacker.invalid"] }), /untrusted/);
  assert.throws(() => validateAddChain({ ...valid, chainId: "0x1234" }));
  assert.throws(() => validateAddChain({ ...valid, nativeCurrency: { ...n.nativeCurrency, symbol: "USD" } }), /untrusted/);
});

test("transactions and signed purchase domains remain bound to one selected chain", () => {
  assert.throws(() => transaction([{ from: user, to: user, value: "0x0", chainId: "0xaa36a7" }], user, 46630), /selected testnet/);
  const common: any = {
    kind: "purchase", orderId: `0x${"11".repeat(32)}`, nonce: `0x${"11".repeat(32)}`,
    contract: "0x0000000000000000000000000000000000000011", marketplace: "0x0000000000000000000000000000000000000022",
    listingId: "1", nft: "0x0000000000000000000000000000000000000033", tokenId: "1", seller: "0x0000000000000000000000000000000000000044",
    recipient: user, price: "100000000000000", gasBudget: "200000000000000", zatoshis: "1500000", rate: "20000000000000000",
    maxSlippageBps: "0", expiry: 2000000000, calldataHash: `0x${"55".repeat(32)}`,
    refundHash: `0x${"66".repeat(32)}`, originHash: `0x${"77".repeat(32)}`,
  };
  const rh: UnsignedPurchase = { ...common, chainId: 46630, sourceNetwork: keccak256(toHex("zcash-testnet")), provider: "0x0000000000000000000000000000000000000088", adapter: keccak256(toHex(network(46630).adapter)) };
  const eth: UnsignedPurchase = { ...common, chainId: 11155111, sourceNetwork: keccak256(toHex("zcash-testnet")), provider: "0x0000000000000000000000000000000000000088", adapter: keccak256(toHex(network(11155111).adapter)) };
  assert.notEqual(hashTypedData(purchaseTyped(rh)), hashTypedData(purchaseTyped(eth)));
  assert.equal(purchaseTyped(rh).domain.chainId, 46630);
});

test("EVM receipt adapter waits for depth and detects a reorged block", async () => {
  const adapter = new EthereumSepoliaAdapter();
  const head = { number: 120n };
  const receipt: any = { blockNumber: 110n, blockHash: `0x${"11".repeat(32)}`, transactionHash: `0x${"33".repeat(32)}`, status: "success", logs: [] };
  (adapter as any).client = {
    getChainId: async () => 11155111,
    getBlock: async (args?: any) => args?.blockNumber
      ? { hash: `0x${"22".repeat(32)}` }
      : { hash: `0x${"44".repeat(32)}`, number: head.number, timestamp: BigInt(Math.floor(Date.now() / 1000)) },
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => head.number,
  };
  assert.equal(await adapter.receipt(receipt.transactionHash), null, "must wait for configured confirmation depth");
  head.number = 121n;
  await assert.rejects(adapter.receipt(receipt.transactionHash), /reorganization/);
});
