// Read-only network observations. Never requests faucet funds or sends a transaction.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson } from '../services/execution/io.ts';
const exec=promisify(execFile);
const wallets=readJson<{base:{user:string;relayer:string}}>('docs/PUBLIC_WALLETS.json');
async function rpc(method:string,params:unknown[]=[]) {
  const r=await fetch('https://sepolia.base.org',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
  const body=await r.json() as {result?:unknown;error?:unknown};if(!r.ok||body.error)throw Error('RPC unavailable');return body.result;
}
async function scan(role:string){
  const {stdout}=await exec(process.platform==='win32'?'target/debug/zecone-zcash.exe':'target/debug/zecone-zcash',['--wallet',`.secrets/${role}/zcash`,'observe'],{timeout:600000,maxBuffer:4*1024*1024});return JSON.parse(stdout);
}
const jobs={
  baseChainId:()=>rpc('eth_chainId'),
  userBalanceWei:()=>rpc('eth_getBalance',[wallets.base.user,'latest']),
  relayerBalanceWei:()=>rpc('eth_getBalance',[wallets.base.relayer,'latest']),
  zcashPayer:()=>scan('user'),zcashMerchant:()=>scan('merchant'),
  zcashOfficialLinkedFaucet:async()=>{const r=await fetch('https://faucet.zecpages.com',{signal:AbortSignal.timeout(20000)});return {httpStatus:r.status,url:r.url};},
  zcashCommunityFaucet:async()=>{const r=await fetch('https://zcashfaucet.jinolabs.xyz',{signal:AbortSignal.timeout(20000)});return {httpStatus:r.status,url:r.url};},
};
const result:Record<string,unknown>={recordedAt:new Date().toISOString(),mode:'read-only; no transactions or faucet claims'};
await Promise.all(Object.entries(jobs).map(async([k,f])=>{try{result[k]=await f();}catch{result[k]={status:'unavailable-from-this-environment'};}}));
mkdirSync('docs/evidence',{recursive:true});writeFileSync('docs/evidence/network.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
