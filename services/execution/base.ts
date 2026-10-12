import { createPublicClient, createWalletClient, decodeEventLog, encodeDeployData, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseEther, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { loadAccount } from './io.ts';
import { CHAIN, PRICE, typed, type Intent } from './intent.ts';
import type { Order } from './store.ts';
import type { Executor, Result } from './worker.ts';

export const abi = parseAbi([
  'function mint((address recipient,uint256 zatoshis,bytes32 nonce,uint64 expiry) intent, bytes signature)',
  'function relayer() view returns (address)', 'function PRICE() view returns (uint256)',
  'function consumed(bytes32) view returns (bool)', 'function ownerOf(uint256) view returns (address)',
  'event OrderMinted(bytes32 indexed orderId,address indexed recipient,uint256 tokenId)',
]);
export class Base implements Executor {
  account: ReturnType<typeof loadAccount>;
  public;
  wallet;
  constructor(readonly contract: Address, readonly confirmations = 3, rpc = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org', keyFile = '.secrets/relayer/base-sepolia.json') {
    this.account = loadAccount(keyFile);
    const url = new URL(rpc);
    if (url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname)) throw Error('Base RPC requires TLS');
    if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw Error('invalid confirmations');
    this.public = createPublicClient({ chain:baseSepolia,transport:http(rpc,{timeout:30_000,retryCount:1}) });
    this.wallet = createWalletClient({ chain:baseSepolia,account:this.account,transport:http(rpc,{timeout:30_000,retryCount:0}) });
  }
  async chain() { if (await this.public.getChainId() !== CHAIN) throw Error('Base Sepolia required'); }
  async check() {
    await this.chain();
    if (!await this.public.getBytecode({address:this.contract})) throw Error('NFT contract is not deployed');
    const [relayer, price] = await Promise.all([
      this.public.readContract({address:this.contract,abi,functionName:'relayer'}),
      this.public.readContract({address:this.contract,abi,functionName:'PRICE'}),
    ]);
    if (getAddress(relayer) !== this.account.address || price !== PRICE) throw Error('contract configuration mismatch');
  }
  async signed(data: Hex, to?: Address) {
    await this.chain();
    const nonce = await this.public.getTransactionCount({address:this.account.address,blockTag:'pending'});
    const fees = await this.public.estimateFeesPerGas();
    const gas = await this.public.estimateGas({account:this.account.address,to,data,value:0n});
    const gasWithMargin = gas * 12n / 10n;
    if (gasWithMargin * fees.maxFeePerGas > parseEther('0.005')) throw Error('gas budget exceeds 0.005 test ETH; review required');
    const request = await this.wallet.prepareTransactionRequest({account:this.account,to,data,value:0n,nonce,gas:gasWithMargin,...fees});
    const raw = await this.wallet.signTransaction(request);
    return {raw, hash:keccak256(raw)};
  }
  async prepare(o: Order) {
    await this.check();
    const i = JSON.parse(o.intent) as Intent;
    if (getAddress(i.contract) !== getAddress(this.contract)) throw Error('wrong contract');
    if (await this.public.readContract({address:this.contract,abi,functionName:'consumed',args:[o.id]})) throw Error('order already consumed; reconcile receipt');
    const args = [typed(i).message,i.signature] as const;
    await this.public.simulateContract({account:this.account.address,address:this.contract,abi,functionName:'mint',args});
    return this.signed(encodeFunctionData({abi,functionName:'mint',args}),this.contract);
  }
  async broadcast(raw: Hex) { await this.chain(); return this.public.sendRawTransaction({serializedTransaction:raw}); }
  async receipt(o: Order): Promise<Result> {
    await this.check();
    let receipt;
    try { receipt = await this.public.getTransactionReceipt({hash:o.tx_hash!}); }
    catch (e) { if (e instanceof TransactionReceiptNotFoundError) return {status:'pending'}; throw e; }
    const head = await this.public.getBlockNumber();
    if (head < receipt.blockNumber || head-receipt.blockNumber+1n < BigInt(this.confirmations)) return {status:'pending'};
    const block = await this.public.getBlock({blockNumber:receipt.blockNumber});
    if (block.hash !== receipt.blockHash) return {status:'pending'};
    if (receipt.status === 'reverted') return {status:'reverted'};
    const i = JSON.parse(o.intent) as Intent;
    const events = receipt.logs.filter(l => getAddress(l.address) === getAddress(this.contract)).flatMap(l => {
      try { const e = decodeEventLog({abi,eventName:'OrderMinted',data:l.data,topics:l.topics}); return [e.args]; } catch { return []; }
    });
    if (events.length !== 1 || events[0].orderId !== o.id || getAddress(events[0].recipient) !== getAddress(i.recipient) || events[0].tokenId !== BigInt(o.id)) throw Error('receipt lacks exact predetermined mint');
    const [used,owner] = await Promise.all([
      this.public.readContract({address:this.contract,abi,functionName:'consumed',args:[o.id]}),
      this.public.readContract({address:this.contract,abi,functionName:'ownerOf',args:[BigInt(o.id)]}),
    ]);
    if (!used || getAddress(owner) !== getAddress(i.recipient)) throw Error('mint ownership reconciliation failed');
    return {status:'success',hash:receipt.transactionHash,block:receipt.blockNumber.toString(),recipient:owner,tokenId:BigInt(o.id).toString()};
  }
}
