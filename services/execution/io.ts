import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
export function exclusiveJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
}
export function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
export function loadAccount(path: string) {
  const { privateKey, network } = readJson<{privateKey: Hex; network: string}>(path);
  if (network !== 'base-sepolia' || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw Error('invalid testnet key file');
  return privateKeyToAccount(privateKey);
}
export async function locked<T>(path: string, fn: () => Promise<T>) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, String(process.pid)); return await fn(); }
  finally { closeSync(fd); unlinkSync(path); }
}
