import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createPublicClient,http,type Address} from 'viem';
import {baseSepolia} from 'viem/chains';
import {readJson} from '../services/execution/io.ts';
const exec=promisify(execFile),manifest=readJson<{base:{user:Address;relayer:Address}}>('docs/PUBLIC_WALLETS.json');
try{
 const client=createPublicClient({chain:baseSepolia,transport:http(process.env.BASE_SEPOLIA_RPC||'https://sepolia.base.org')});
 if(await client.getChainId()!==84532)throw Error('Wrong chain');
 const {stdout}=await exec(resolve('target/debug/zecone-zcash.exe'),['--wallet',resolve('.secrets/user/zcash'),'summary'],{windowsHide:true,timeout:600000,maxBuffer:16000000});const z=JSON.parse(stdout);
 const [user,provider]=await Promise.all([client.getBalance({address:manifest.base.user}),client.getBalance({address:manifest.base.relayer})]);
 const evidence={checkedAt:new Date().toISOString(),chainId:84532,user:manifest.base.user,provider:manifest.base.relayer,userWei:user.toString(),providerWei:provider.toString(),zcash:{network:'testnet',tip:z.tip,scanned:z.scanned,spendableZatoshis:z.spendableZatoshis,totalZatoshis:z.totalZatoshis},funded:BigInt(z.spendableZatoshis)>=1020000n&&provider>=2000000000000000n};
 mkdirSync('docs/phase3-evidence',{recursive:true});writeFileSync('docs/phase3-evidence/preflight.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));if(!evidence.funded)process.exitCode=2;
}catch{console.error('Read-only Phase 3 preflight failed. No payment or deployment was attempted.');process.exitCode=1;}
