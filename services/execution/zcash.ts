import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { Snapshot } from './store.ts';
const exec = promisify(execFile);
export class Zcash {
  constructor(readonly wallet = '.secrets/merchant/zcash', readonly binary = process.platform === 'win32' ? 'target/debug/zecone-zcash.exe' : 'target/debug/zecone-zcash') {}
  private async call<T>(args: string[]): Promise<T> {
    // No shell and no externally supplied evidence file. stdout is the local native scanner.
    try {
      const {stdout} = await exec(resolve(this.binary), ['--wallet',resolve(this.wallet),...args], {maxBuffer:16*1024*1024,timeout:600_000});
      return JSON.parse(stdout);
    } catch { throw Error('Zcash service failed; run its read-only sync command for diagnostics'); }
  }
  allocate(id: string) { return this.call<{account:string;address:string}>(['allocate','--label',id]); }
  observe() { return this.call<Snapshot>(['observe']); }
}
