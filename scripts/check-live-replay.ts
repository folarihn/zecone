// Re-run an already settled order and verify that no new transaction is issued.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { readJson } from '../services/execution/io.ts';
import { Store } from '../services/execution/store.ts';
const exec = promisify(execFile);
const {base} = readJson<{base:{relayer:Address}}>('docs/PUBLIC_WALLETS.json');
const {orderId} = readJson<{orderId:string}>('.state/live-payment.json');
const client=createPublicClient({chain:baseSepolia,transport:http(process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org')});
assert.equal(await client.getChainId(),84532);
async function snapshot() {
  const s=new Store('.state/orders.sqlite');
  try {
    const r=s.report(),o=s.get(orderId);
    assert.equal(o?.state,'settled');
    return {state:o!.state,txHash:o!.tx_hash,orderCount:r.orders.length,paymentCount:r.payments.length,broadcastAttempts:r.audit.filter(a=>a.event==='broadcast_attempt').length,nonce:await client.getTransactionCount({address:base.relayer,blockTag:'pending'})};
  } finally {s.close();}
}
const before=await snapshot();
const {stdout}=await exec(process.execPath,['--import','tsx','services/execution/cli.ts','create','.state/intent.json']);
const repeated=JSON.parse(stdout); assert.equal(repeated.id,orderId); assert.equal(repeated.state,'settled');
await exec(process.execPath,['--import','tsx','services/execution/cli.ts','tick','--allow-testnet-broadcast'],{timeout:180000,maxBuffer:4*1024*1024});
const after=await snapshot(); assert.deepEqual(after,before);
const evidence={recordedAt:new Date().toISOString(),result:'passed',description:'Identical intent reused the settled order; another worker tick issued no transaction',before,after};
writeFileSync('docs/evidence/live-idempotency.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
