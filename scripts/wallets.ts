import { existsSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { exclusiveJson, loadAccount } from '../services/execution/io.ts';
for (const role of ['user', 'relayer']) {
  const file = `.secrets/${role}/base-sepolia.json`;
  if (!existsSync(file)) {
    const privateKey = generatePrivateKey();
    exclusiveJson(file, { network: 'base-sepolia', privateKey });
  }
  // Only public addresses leave this utility. Settlement imports no user key code.
  console.log(JSON.stringify({ role, address: loadAccount(file).address, credentialFile: file }));
}
