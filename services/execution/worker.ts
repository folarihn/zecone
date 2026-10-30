import { Store, type Order } from './store.ts';
import type { Hex } from 'viem';
export type Result = { status:'pending' } | { status:'reverted' } | { status:'success'; hash:Hex; block:string; recipient:string; tokenId?:string; actionId?:string; token?:string; amountOut?:string; balanceBefore?:string; balanceAfter?:string };
export interface Executor {
  prepare(order: Order): Promise<{raw:Hex;hash:Hex}>;
  broadcast(raw: Hex): Promise<Hex>;
  receipt(order: Order): Promise<Result>;
}
export async function executeOne(store: Store, id: string, executor: Executor, clock: () => number) {
  let o = store.get(id); if (!o) throw Error('unknown order');
  if (o.state === 'settled') return;
  if (o.tx_hash) {
    // Always reconcile before considering another broadcast. Recovery never rebroadcasts.
    const r = await executor.receipt(o);
    if (r.status === 'success') { store.settled(id,r,clock()); return; }
    if (r.status === 'reverted') { store.failed(id,clock()); return; }
    if (!['prepared','submitted'].includes(o.state)) return;
  } else {
    if (!store.claimPreparation(id,clock())) return;
    try {
      const tx = await executor.prepare(o);
      store.prepared(id,tx.raw,tx.hash,clock()); // durable BEFORE any broadcast
    } catch (e) {
      // The constructor may already have signed. Keep its claim permanently;
      // a thrown error is not evidence that an executable transaction is absent.
      store.atomic(() => {
        const current = store.get(id);
        if (current && !current.tx_hash && current.state !== 'settled') {
          store.recover(id,'execution_construction_uncertain',{},clock());
          store.transition(id,'recovery',clock());
        }
      });
      throw e;
    }
    o = store.get(id)!;
  }
  // Do not initiate/rebroadcast after expiry or a stale scan. Reconciliation can still continue.
  const intent = JSON.parse(o.intent);
  if (clock() >= intent.expiry || clock()-o.observed_at > 120) {
    store.atomic(() => { store.recover(id,'pending_settlement_requires_review',{hash:o!.tx_hash},clock()); store.transition(id,'recovery',clock()); }); return;
  }
  store.event(id,'broadcast_attempt',{hash:o.tx_hash},clock());
  let hash:Hex;
  try { hash = await executor.broadcast(o.raw!); }
  catch (e) { store.event(id,'broadcast_outcome_unknown',{hash:o.tx_hash},clock()); throw e; }
  if (hash.toLowerCase() !== o.tx_hash!.toLowerCase()) throw Error('RPC returned unexpected transaction hash');
  store.submitted(id,clock());
  const r = await executor.receipt(store.get(id)!);
  if (r.status === 'success') store.settled(id,r,clock());
  if (r.status === 'reverted') store.failed(id,clock());
}
