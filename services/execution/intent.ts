import { getAddress, hashTypedData, recoverTypedDataAddress, zeroAddress, type Address, type Hex } from 'viem';
export const CHAIN = 84532;
export const PRICE = 1_000_000n;
export const types = { MintIntent: [
  { name: 'recipient', type: 'address' }, { name: 'zatoshis', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' }, { name: 'expiry', type: 'uint64' },
] } as const;
export type Intent = { recipient: Address; zatoshis: string; nonce: Hex; expiry: number; contract: Address; signature: Hex };
export function typed(i: Omit<Intent, 'signature'>) {
  return { domain: { name: 'ZecOnePhase0', version: '1', chainId: CHAIN, verifyingContract: i.contract }, types, primaryType: 'MintIntent' as const,
    message: { recipient: i.recipient, zatoshis: BigInt(i.zatoshis), nonce: i.nonce, expiry: BigInt(i.expiry) } };
}
export function orderId(i: Intent) { return hashTypedData(typed(i)); }
export async function verifyIntent(i: Intent, contract: Address, relayer: Address, now: number) {
  if (getAddress(i.contract) !== getAddress(contract) || getAddress(i.recipient) === getAddress(relayer) || getAddress(i.recipient) === zeroAddress) throw Error('invalid destination');
  if (!/^[0-9]+$/.test(i.zatoshis) || BigInt(i.zatoshis) !== PRICE || !/^0x[0-9a-fA-F]{64}$/.test(i.nonce)) throw Error('invalid terms');
  if (!Number.isSafeInteger(i.expiry) || i.expiry <= now || i.expiry > now + 86400) throw Error('invalid expiry');
  if (getAddress(await recoverTypedDataAddress({ ...typed(i), signature: i.signature })) !== getAddress(i.recipient)) throw Error('recipient signature required');
  return orderId(i);
}
