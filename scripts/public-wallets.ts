import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAccount } from '../services/execution/io.ts';
const binary=resolve(process.platform==='win32'?'target/debug/zecone-zcash.exe':'target/debug/zecone-zcash');
function zcash(role:string) {
  const rows=JSON.parse(execFileSync(binary,['--wallet',resolve(`.secrets/${role}/zcash`),'addresses'],{encoding:'utf8'})) as {account:string;address:string;saplingAddress:string|null;label:string}[];
  const a=rows.find(r=>r.label==='funding');if(!a)throw Error('funding account missing');return a;
}
const wallets={
  notice:'Public testnet addresses only. See docs/RESULTS.md for live transaction outcomes.',
  base:{network:'base-sepolia',chainId:84532,user:loadAccount('.secrets/user/base-sepolia.json').address,relayer:loadAccount('.secrets/relayer/base-sepolia.json').address},
  zcash:{network:'zcash-testnet',payer:zcash('user'),merchant:zcash('merchant')},
};
writeFileSync('docs/PUBLIC_WALLETS.json',JSON.stringify(wallets,null,2)+'\n');
console.log(JSON.stringify(wallets,null,2));
