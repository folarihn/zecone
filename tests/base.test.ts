// Local Anvil EVM only. Does not use real wallets, real Zcash observations, or public testnet funds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeDeployData, parseEther, toHex, zeroAddress, type Hex } from 'viem';
import { Base } from '../services/execution/base.ts';
import { exclusiveJson, readJson } from '../services/execution/io.ts';
import { Store } from '../services/execution/store.ts';
import { PRICE, typed, verifyIntent, type Intent } from '../services/execution/intent.ts';
import { executeOne } from '../services/execution/worker.ts';

test('local EVM: real viem signing, persisted raw tx, receipt/event/owner reconciliation and chain guard', {timeout:60_000}, async()=>{
  const listener=createServer(); listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
  const node=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','84532','--silent'],{stdio:'ignore',windowsHide:true});
  const dir=mkdtempSync(join(tmpdir(),'zecone-evm-')), keyFile=join(dir,'relayer.json');
  exclusiveJson(keyFile,{network:'base-sepolia',privateKey:generatePrivateKey()});
  const rpc=`http://127.0.0.1:${port}`, bootstrap=new Base(zeroAddress,1,rpc,keyFile);
  let store:Store|undefined;
  try {
    let ready=false;
    for(let i=0;i<50;i++){try {await bootstrap.chain();ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}
    assert.ok(ready,'Anvil startup failed');
    async function local(method:string,params:unknown[]=[]){
      const response=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      const body=await response.json() as {error?:unknown};if(body.error)throw Error('local EVM RPC failed');
    }
    await local('anvil_setBalance',[bootstrap.account.address,toHex(parseEther('1'))]);
    const artifact=readJson<{abi:any;bytecode:{object:Hex}}>('out/ZecOneNFT.sol/ZecOneNFT.json');
    const deployment=await bootstrap.signed(encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args:[bootstrap.account.address]}));
    await bootstrap.broadcast(deployment.raw);
    const deployReceipt=await bootstrap.public.waitForTransactionReceipt({hash:deployment.hash});assert.ok(deployReceipt.contractAddress);
    const base=new Base(deployReceipt.contractAddress,1,rpc,keyFile);await base.check();
    const user=privateKeyToAccount(generatePrivateKey()),now=Math.floor(Date.now()/1000);
    const body={recipient:user.address,contract:base.contract,zatoshis:PRICE.toString(),nonce:`0x${randomBytes(32).toString('hex')}` as Hex,expiry:now+3600};
    const intent:Intent={...body,signature:await user.signTypedData(typed(body))};
    const id=await verifyIntent(intent,base.contract,base.account.address,now),account=randomUUID();
    store=new Store(join(dir,'orders.sqlite'));store.create(id,intent,account,'utest-LOCAL-EVM-SYNTHETIC',now);
    store.observe({network:'zcash-testnet',tip:100,scanned:100,observedAt:now,payments:[{account,txid:randomBytes(32).toString('hex'),pool:3,index:0,zatoshis:PRICE.toString(),height:91,blockHash:randomBytes(32).toString('hex')}]},now);
    await executeOne(store,id,base,()=>now);
    const o=store.get(id)!;assert.equal(o.state,'settled');assert.ok(o.raw);assert.ok(o.tx_hash);
    const nonce=await base.public.getTransactionCount({address:base.account.address});
    await executeOne(store,id,base,()=>now);assert.equal(await base.public.getTransactionCount({address:base.account.address}),nonce);
    assert.equal((await base.receipt(o)).status,'success');
    await local('anvil_setChainId',[8453]);await assert.rejects(base.chain(),/Base Sepolia/);
  } finally {store?.close();node.kill();}
});
