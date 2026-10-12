// Read-only public-chain verification. Never loads private keys or broadcasts.
import { writeFileSync } from 'node:fs';
import { createPublicClient, decodeEventLog, getAddress, http, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { abi } from '../services/execution/base.ts';
import { readJson } from '../services/execution/io.ts';
import { Store } from '../services/execution/store.ts';
import type { Intent } from '../services/execution/intent.ts';

const deployment = readJson<{contract:Address;deploymentHash:Hex}>('.state/deployment-confirmed.json');
const payment = readJson<{orderId:Hex;requestId:string}>('.state/live-payment.json');
const store = new Store('.state/orders.sqlite');
const report = store.report();
store.close();
const order = report.orders.find(o => o.id === payment.orderId);
if (!order || order.state !== 'settled' || !order.tx_hash) throw Error('Live order is not settled');
const intent = JSON.parse(order.intent) as Intent;
const scanEvent = [...report.audit].reverse().find(a=>a.order_id===order.id && a.event==='scan_verified');
if (!scanEvent) throw Error('Missing scan audit evidence');
const scan = JSON.parse(scanEvent.detail as string) as {tip:number;scanned:number;observedAt:number;requiredConfirmations:number;confirmedZatoshis:string};
const received = report.payments.filter(p=>p.order_id===order.id && p.active===1).map(p=>({txid:(p.key as string).split(':')[0],pool:Number((p.key as string).split(':')[1]),index:Number((p.key as string).split(':')[2]),zatoshis:p.zatoshis,height:p.height,blockHash:p.block_hash,confirmations:scan.tip-Number(p.height)+1}));
if (scan.tip!==scan.scanned || BigInt(scan.confirmedZatoshis)<BigInt(intent.zatoshis) || received.some(p=>p.confirmations<10)) throw Error('Insufficient confirmed Zcash evidence');
const client = createPublicClient({chain:baseSepolia,transport:http(process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org')});
if (await client.getChainId() !== 84532) throw Error('Base Sepolia required');
const [deployReceipt,mintReceipt,head,owner,consumed] = await Promise.all([
  client.getTransactionReceipt({hash:deployment.deploymentHash}),
  client.getTransactionReceipt({hash:order.tx_hash}),
  client.getBlockNumber(),
  client.readContract({address:deployment.contract,abi,functionName:'ownerOf',args:[BigInt(order.id)]}),
  client.readContract({address:deployment.contract,abi,functionName:'consumed',args:[order.id]}),
]);
const canonical = await client.getBlock({blockNumber:mintReceipt.blockNumber});
const confirmations = head-mintReceipt.blockNumber+1n;
const events = mintReceipt.logs.filter(l => getAddress(l.address) === getAddress(deployment.contract)).flatMap(l => {
  try { return [decodeEventLog({abi,eventName:'OrderMinted',data:l.data,topics:l.topics}).args]; } catch { return []; }
});
if (deployReceipt.status !== 'success' || mintReceipt.status !== 'success' || confirmations < 3n || canonical.hash !== mintReceipt.blockHash || !consumed || getAddress(owner) !== getAddress(intent.recipient) || events.length !== 1 || events[0].orderId !== order.id || events[0].tokenId !== BigInt(order.id) || getAddress(events[0].recipient) !== getAddress(owner)) throw Error('Live evidence verification failed');
const evidence = {recordedAt:new Date().toISOString(),mode:'Real Zcash Testnet payment and real Base Sepolia mint; no fixtures',deployment,orderId:order.id,recipient:owner,tokenId:BigInt(order.id).toString(),zcash:{network:'zcash-testnet',...scan,payments:received},mint:{hash:order.tx_hash,status:mintReceipt.status,blockNumber:mintReceipt.blockNumber,blockHash:mintReceipt.blockHash,observedHead:head,confirmations,consumed,events,gasUsed:mintReceipt.gasUsed},deploymentReceipt:{status:deployReceipt.status,blockNumber:deployReceipt.blockNumber,blockHash:deployReceipt.blockHash,gasUsed:deployReceipt.gasUsed},report};
writeFileSync('docs/evidence/live-test.json',JSON.stringify(evidence,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log(JSON.stringify({verified:true,contract:deployment.contract,mintHash:order.tx_hash,recipient:owner,confirmations:confirmations.toString(),evidence:'docs/evidence/live-test.json'}));
