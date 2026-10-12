import { existsSync } from 'node:fs';
import { getAddress, encodeDeployData, zeroAddress, type Address, type Hex } from 'viem';
import { Base } from './base.ts';
import { Store } from './store.ts';
import { Zcash } from './zcash.ts';
import { executeOne } from './worker.ts';
import { exclusiveJson, loadAccount, locked, readJson } from './io.ts';
import { verifyIntent, type Intent } from './intent.ts';

const now = () => Math.floor(Date.now()/1000);
const [command, arg] = process.argv.slice(2);
const live = process.argv.includes('--allow-testnet-broadcast');
const config = () => readJson<{contract:Address;deploymentHash:Hex}>('.state/deployment-confirmed.json');
async function main() {
  if (command === 'deploy') {
    if (!live) throw Error('deploy requires --allow-testnet-broadcast after funding');
    const b = new Base(zeroAddress); await b.chain();
    if (existsSync('.state/deployment-confirmed.json')) { console.log(JSON.stringify(config())); return; }
    let tx: {raw:Hex;hash:Hex};
    if (existsSync('.state/deployment-pending.json')) tx = readJson('.state/deployment-pending.json');
    else {
      const artifact = readJson<{abi:any;bytecode:{object:Hex}}>('out/ZecOneNFT.sol/ZecOneNFT.json');
      tx = await b.signed(encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args:[b.account.address]}));
      exclusiveJson('.state/deployment-pending.json',tx);
    }
    const receipt = await b.public.getTransactionReceipt({hash:tx.hash}).catch(() => null);
    if (!receipt) await b.broadcast(tx.raw);
    const final = await b.public.waitForTransactionReceipt({hash:tx.hash,confirmations:3,timeout:180_000});
    if (final.status !== 'success' || !final.contractAddress) throw Error('deployment failed; preserve pending evidence for review');
    const deployment = {contract:final.contractAddress,deploymentHash:tx.hash};
    await new Base(deployment.contract).check();
    exclusiveJson('.state/deployment-confirmed.json',deployment);
    console.log(JSON.stringify(deployment)); return;
  }
  const store = new Store('.state/orders.sqlite');
  try {
    if (command === 'status') { console.log(JSON.stringify(store.report(),null,2)); return; }
    const {contract} = config();
    const zcash = new Zcash();
    if (command === 'create') {
      if (!arg) throw Error('provide signed intent file');
      const intent = readJson<Intent>(arg);
      const relayer = loadAccount('.secrets/relayer/base-sepolia.json').address;
      const id = await verifyIntent(intent,contract,relayer,now());
      const old = store.get(id);
      if (old) { console.log(JSON.stringify({id:old.id,address:old.address,state:old.state})); return; }
      const receiver = await zcash.allocate(id);
      const o = store.create(id,intent,receiver.account,receiver.address,now());
      console.log(JSON.stringify({id:o.id,address:o.address,zatoshis:intent.zatoshis,expiry:intent.expiry})); return;
    }
    if (command === 'scan' || command === 'tick' || command === 'retry') {
      if (command === 'tick' && !live) throw Error('tick requires --allow-testnet-broadcast after funding');
      store.observe(await zcash.observe(),now());
      if (command === 'retry') { if (!arg) throw Error('provide failed order ID'); store.retry(arg,now()); }
      if (command === 'tick') {
        const base = new Base(contract);
        // At most one active EVM nonce at a time. Never issue another while receipt is unknown.
        const pending = store.all().find(o => o.tx_hash && ['prepared','submitted','recovery'].includes(o.state));
        const next = pending ?? store.all().find(o=>store.eligible(o,now()));
        if (next) await executeOne(store,next.id,base,now);
      }
      console.log(JSON.stringify(store.report(),null,2)); return;
    }
    throw Error('commands: deploy | create <intent.json> | scan | tick | retry <id> | status');
  } finally { store.close(); }
}
// Exclusive across order allocation, scan and transaction work. A stale lock requires operator review.
locked('.state/service.lock',main).catch(() => {
  // Do not serialize viem error objects: they can include signed transaction bytes or credential URLs.
  console.error('Command failed. No success is assumed. Check configuration, funding, lock ownership and persisted status; see docs/RUNBOOK.md.');
  process.exitCode = 1;
});
