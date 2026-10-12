// Synthetic test fixtures ONLY. These tests are never evidence of real chain payments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, type Hex } from 'viem';
import { Store, type Payment, type Snapshot, type Order } from '../services/execution/store.ts';
import { orderId, PRICE, typed, verifyIntent, type Intent } from '../services/execution/intent.ts';
import { executeOne, type Executor, type Result } from '../services/execution/worker.ts';

const hex = () => `0x${randomBytes(32).toString('hex')}` as Hex;
async function setup() {
  const path = join(mkdtempSync(join(tmpdir(),'zecone-test-')),'orders.sqlite');
  const store = new Store(path), now = 1000;
  const user = privateKeyToAccount(generatePrivateKey()), relayer = privateKeyToAccount(generatePrivateKey());
  const contract = privateKeyToAccount(generatePrivateKey()).address;
  const body = {recipient:user.address,contract,zatoshis:PRICE.toString(),nonce:hex(),expiry:2000};
  const intent: Intent = {...body,signature:await user.signTypedData(typed(body))};
  const id = await verifyIntent(intent,contract,relayer.address,now), account=randomUUID();
  store.create(id,intent,account,'utest-SYNTHETIC-NOT-AN-ADDRESS',now);
  const payment:Payment = {account,txid:hex().slice(2),pool:3,index:0,zatoshis:PRICE.toString(),height:91,blockHash:hex().slice(2)};
  const snapshot:Snapshot = {network:'zcash-testnet',tip:100,scanned:100,observedAt:now,payments:[payment]};
  return {path,store,now,user,relayer,contract,intent,id,account,payment,snapshot};
}
class Fake implements Executor {
  // A stub for failure injection, deliberately never imported by runtime CLI.
  raw=hex(); hash=keccak256(this.raw); prepared=0; broadcasts:Hex[]=[]; result:Result={status:'pending'}; loseResponse=false;
  async prepare(_o:Order) {this.prepared++;return {raw:this.raw,hash:this.hash};}
  async broadcast(raw:Hex) {this.broadcasts.push(raw);if(this.loseResponse)throw Error('simulated lost response');return this.hash;}
  async receipt(_o:Order) {return this.result;}
}
test('duplicate snapshots and outputs do not increase paid amount',async()=>{
  const f=await setup(); f.store.observe({...f.snapshot,payments:[f.payment,f.payment]},f.now);f.store.observe(f.snapshot,f.now);
  assert.equal(f.store.totals(f.id).confirmed,PRICE);assert.equal(f.store.get(f.id)!.state,'verified'); f.store.close();
});
test('underpayments accumulate but never settle early',async()=>{
  const f=await setup();const p={...f.payment,zatoshis:'400000'};f.store.observe({...f.snapshot,payments:[p]},f.now);
  assert.equal(f.store.get(f.id)!.state,'awaiting_payment');
  f.store.observe({...f.snapshot,payments:[p,{...p,index:1,zatoshis:'600000'}]},f.now);assert.equal(f.store.get(f.id)!.state,'verified');f.store.close();
});
test('nine confirmations and unmined observations cannot authorize',async()=>{
  const f=await setup();f.store.observe({...f.snapshot,payments:[{...f.payment,height:92}]},f.now);
  assert.equal(f.store.get(f.id)!.state,'awaiting_payment');
  assert.throws(()=>f.store.observe({...f.snapshot,payments:[{...f.payment,height:0}]},f.now));f.store.close();
});

test('Ironwood notes require ten confirmations and retain pool-specific identity',async()=>{
  const f=await setup(); const p={...f.payment,pool:4};
  f.store.observe({...f.snapshot,payments:[{...p,height:92}]},f.now);
  assert.equal(f.store.get(f.id)!.state,'awaiting_payment');
  f.store.observe({...f.snapshot,payments:[p,p]},f.now);
  assert.equal(f.store.totals(f.id).confirmed,PRICE);
  assert.equal(f.store.get(f.id)!.state,'verified');
  assert.equal((f.store.report().payments[0] as {key:string}).key,`${p.txid}:4:${p.index}`);
  f.store.close();
});
test('invalid network, partial scan, stale snapshot and transparent output fail closed',async()=>{
  const f=await setup();
  for(const s of [{...f.snapshot,network:'mainnet'},{...f.snapshot,scanned:99},{...f.snapshot,observedAt:1},{...f.snapshot,payments:[{...f.payment,pool:0}]}]) assert.throws(()=>f.store.observe(s,f.now));
  assert.equal(f.store.get(f.id)!.state,'awaiting_payment');f.store.close();
});
test('expired orders with funds enter auditable recovery and cannot revive',async()=>{
  const f=await setup();f.store.observe({...f.snapshot,observedAt:2001},2001);
  assert.equal(f.store.get(f.id)!.state,'expired');assert.equal(f.store.report().recoveries.length,1);
  assert.equal(f.store.eligible(f.store.get(f.id)!,2001),false);f.store.close();
});
test('a late payment to an already expired order stays expired',async()=>{
  const f=await setup();f.store.observe({...f.snapshot,payments:[],observedAt:2001},2001);
  f.store.observe({...f.snapshot,observedAt:2010},2010);assert.equal(f.store.get(f.id)!.state,'expired');assert.equal(f.store.report().recoveries.length,1);f.store.close();
});
test('overpayment authorizes only one mint and records excess recovery',async()=>{
  const f=await setup();f.store.observe({...f.snapshot,payments:[{...f.payment,zatoshis:'2000000'}]},f.now);
  assert.equal(f.store.get(f.id)!.state,'verified');assert.equal(f.store.report().recoveries.length,1);f.store.close();
});
test('reorg before preparation removes authorization',async()=>{
  const f=await setup();f.store.observe(f.snapshot,f.now);f.store.observe({...f.snapshot,payments:[]},f.now);
  assert.equal(f.store.get(f.id)!.state,'awaiting_payment');f.store.close();
});
test('reorg after preparation stops broadcast and creates recovery',async()=>{
  const f=await setup();f.store.observe(f.snapshot,f.now);const x=new Fake();f.store.prepared(f.id,x.raw,x.hash,f.now);
  f.store.observe({...f.snapshot,payments:[]},f.now);await executeOne(f.store,f.id,x,()=>f.now);
  assert.equal(f.store.get(f.id)!.state,'recovery');assert.equal(x.broadcasts.length,0);f.store.close();
});
test('conflicting duplicate outputs reject the entire snapshot atomically',async()=>{
  const f=await setup();assert.throws(()=>f.store.observe({...f.snapshot,payments:[f.payment,{...f.payment,zatoshis:'1'}]},f.now));
  assert.equal(f.store.totals(f.id).received,0n);f.store.close();
});
test('payment attribution cannot be replayed against another account',async()=>{
  const f=await setup();f.store.observe(f.snapshot,f.now);
  const second={...f.intent,nonce:hex()};const id=orderId(second),account=randomUUID();f.store.create(id,second,account,'utest-SECOND-SYNTHETIC',f.now);
  assert.throws(()=>f.store.observe({...f.snapshot,payments:[{...f.payment,account}]},f.now));
  assert.equal(f.store.totals(f.id).confirmed,PRICE);assert.equal(f.store.totals(id).confirmed,0n);f.store.close();
});
test('same request is idempotent; reusing nonce for another intent fails',async()=>{
  const f=await setup();f.store.create(f.id,f.intent,f.account,'utest-SYNTHETIC-NOT-AN-ADDRESS',f.now);
  const changed={...f.intent,expiry:1900};assert.throws(()=>f.store.create(orderId(changed),changed,randomUUID(),'utest-OTHER',f.now));
  assert.equal(f.store.all().length,1);f.store.close();
});
test('crash after broadcast preserves raw transaction across restart',async()=>{
  const f=await setup();f.store.observe(f.snapshot,f.now);const x=new Fake();x.loseResponse=true;
  await assert.rejects(executeOne(f.store,f.id,x,()=>f.now));assert.equal(f.store.get(f.id)!.state,'prepared');f.store.close();
  const reopened=new Store(f.path);x.loseResponse=false;await executeOne(reopened,f.id,x,()=>f.now);
  assert.equal(x.prepared,1);assert.equal(x.broadcasts[0],x.broadcasts[1]);assert.equal(reopened.get(f.id)!.state,'submitted');reopened.close();
});
test('receipt reconciliation prevents duplicate settlement on retries',async()=>{
  const f=await setup();f.store.observe(f.snapshot,f.now);const x=new Fake();await executeOne(f.store,f.id,x,()=>f.now);
  x.result={status:'success',hash:x.hash,block:'500',recipient:f.user.address,tokenId:BigInt(f.id).toString()};
  await executeOne(f.store,f.id,x,()=>f.now);await executeOne(f.store,f.id,x,()=>f.now);
  assert.equal(x.broadcasts.length,1);assert.equal(x.prepared,1);assert.equal(f.store.get(f.id)!.state,'settled');f.store.close();
});
test('confirmed revert records failure; explicit retry requires fresh payment',async()=>{
  const f=await setup();f.store.observe(f.snapshot,f.now);const x=new Fake();await executeOne(f.store,f.id,x,()=>f.now);
  assert.throws(()=>f.store.retry(f.id,f.now));x.result={status:'reverted'};await executeOne(f.store,f.id,x,()=>f.now);
  assert.equal(f.store.get(f.id)!.state,'failed');assert.equal(f.store.report().recoveries.length,1);
  assert.throws(()=>f.store.retry(f.id,1500));f.store.retry(f.id,f.now);assert.equal(f.store.get(f.id)!.tx_hash,null);f.store.close();
});
test('expired pending settlement does not rebroadcast',async()=>{
  const f=await setup();f.store.observe(f.snapshot,f.now);const x=new Fake();f.store.prepared(f.id,x.raw,x.hash,f.now);
  await executeOne(f.store,f.id,x,()=>2001);assert.equal(x.broadcasts.length,0);assert.equal(f.store.get(f.id)!.state,'recovery');f.store.close();
});
test('altered recipient, contract, price, expiry and signature are rejected',async()=>{
  const f=await setup();
  for(const i of [{...f.intent,recipient:f.relayer.address},{...f.intent,contract:f.user.address},{...f.intent,zatoshis:'1'},{...f.intent,expiry:999},{...f.intent,expiry:1999}]) await assert.rejects(verifyIntent(i,f.contract,f.relayer.address,f.now));
  assert.equal(await verifyIntent(f.intent,f.contract,f.relayer.address,f.now),f.id);f.store.close();
});
test('a slow prepare cannot bypass the freshness check before persistence',async()=>{
  const f=await setup();f.store.observe(f.snapshot,f.now);const x=new Fake();let clock=f.now;
  x.prepare=async()=>{clock+=121;return {raw:x.raw,hash:x.hash};};
  await assert.rejects(executeOne(f.store,f.id,x,()=>clock));assert.equal(x.broadcasts.length,0);assert.equal(f.store.get(f.id)!.raw,null);f.store.close();
});
