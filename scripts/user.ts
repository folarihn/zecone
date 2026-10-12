import { randomBytes } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import { exclusiveJson, loadAccount, readJson } from '../services/execution/io.ts';
import { PRICE, typed, type Intent } from '../services/execution/intent.ts';

// Explicit user-side utility. The backend never imports this module or loads this key path.
const account = loadAccount('.secrets/user/base-sepolia.json');
const {contract} = readJson<{contract:Address}>('.state/deployment-confirmed.json');
const output = process.argv[2] ?? '.state/intent.json';
const intent: Omit<Intent,'signature'> = {recipient:account.address,contract:getAddress(contract),zatoshis:PRICE.toString(),nonce:`0x${randomBytes(32).toString('hex')}`,expiry:Math.floor(Date.now()/1000)+86400};
const signature = await account.signTypedData(typed(intent));
exclusiveJson(output,{...intent,signature});
console.log(JSON.stringify({recipient:account.address,intentFile:output,expiry:intent.expiry}));
