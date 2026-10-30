// A stand-in for the Rust `zecone-zcash-watch observe-mainnet` binary, used the
// same way tests/mainnet-watch.test.ts does: the REAL MainnetWatchScanner runs it
// as a child process, parses, validates and freezes its JSON. The fake reads a
// mutable chain description from disk so tests can mine blocks, reorg and fail.
// Synthetic only: no network, no keys, no real chain.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainnetWatchScanner } from "../../services/settlement/mainnet-watch.ts";

export const SOURCE = "https://light.example.org";
export const PEER = "https://peer.example.org";
export const ACCOUNT = "a".repeat(64);

export type FakeNote = { txid: string; index?: number; pool?: 2 | 3 | 4; height: number; zatoshis: string; address: string; spent?: boolean };
export type FakeChain = { tip: number; hashes: Record<number, string>; notes: FakeNote[]; fail?: string; defaultAddress: string };

const SCRIPT = String.raw`
const fs = require("node:fs");
const argv = process.argv.slice(2);
const chain = JSON.parse(fs.readFileSync(process.env.FAKE_CHAIN || argv[0], "utf8"));
if (chain.fail) { process.stderr.write(chain.fail); process.exit(1); }
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const minConf = Number(arg("--minimum-confirmations"));
const cpArg = arg("--checkpoint-height");
const hash = (h) => chain.hashes[h] || (String(h % 10).repeat(64));
if (cpArg !== undefined && Number(cpArg) > chain.tip) { process.stderr.write("checkpoint_above_tip"); process.exit(1); }
const tip = chain.tip;
const payments = chain.notes.filter((n) => n.height <= tip).map((n) => {
  const conf = tip - n.height + 1;
  const count = Math.min(conf, minConf);
  return {
    account: "${"a".repeat(64)}", txid: n.txid, pool: n.pool || 3, index: n.index || 0, zatoshis: n.zatoshis,
    height: n.height, blockHash: hash(n.height), address: n.address, memo: null, nullifier: null,
    locked: false, spent: !!n.spent, isChange: false, confirmations: conf,
    ownershipEvidence: {
      scheme: "zcash-full-transaction-ufvk-v3", digest: require("node:crypto").createHash("sha256").update(n.txid + (n.index||0)).digest("hex"), providers: 2,
      blockEvidence: { scheme: "zcash-header-pow-merkle-v1", height: n.height, headerHash: hash(n.height), merkleRoot: "6".repeat(64), transactionIndex: 0, transactionCount: 1, proofOfWork: "PASS", readOnly: true },
      chainEvidence: { scheme: "zcash-pow-chain-segment-v1", startHeight: n.height, endHeight: n.height + count - 1, startHash: hash(n.height), endHash: hash(n.height + count - 1), blockCount: count, accumulatedWork: "1234abcd", proofOfWork: "PASS", continuity: "PASS", readOnly: true },
    },
  };
});
process.stdout.write(JSON.stringify({
  network: "zcash-mainnet", watchOnly: true, liveChain: true, liveRefundsEnabled: false,
  source: arg("--server"), peerSource: arg("--peer"), account: "${"a".repeat(64)}", address: chain.defaultAddress,
  birthday: 1, tip, scanned: tip, blockHash: hash(tip), observedAt: Math.floor(Date.now() / 1000),
  minimumConfirmations: minConf, anchor: "f".repeat(64), anchorHeight: tip - 10,
  checkpoint: cpArg === undefined ? null : { height: Number(cpArg), hash: hash(Number(cpArg)), orchardRoot: "f".repeat(64) },
  payments,
}));
`;

export function fakeWatcher(initial: FakeChain, minimumConfirmations = 20) {
  const dir = mkdtempSync(join(tmpdir(), "zecone-fake-watch-"));
  const chainFile = join(dir, "chain.json");
  const script = join(dir, "observe.cjs");
  writeFileSync(script, SCRIPT);
  let chain = structuredClone(initial);
  const write = () => writeFileSync(chainFile, JSON.stringify(chain));
  write();
  const scanner = new MainnetWatchScanner(
    dir,
    SOURCE,
    PEER,
    {
      network: "zcash",
      enabled: true,
      providers: [
        { endpoint: SOURCE, operator: "primary" },
        { endpoint: PEER, operator: "secondary" },
      ],
      independenceAcknowledged: true,
      confirmations: minimumConfirmations,
    },
    process.execPath,
    [script, chainFile],
    dir,
  );
  return {
    scanner,
    get chain() {
      return chain;
    },
    update(fn: (c: FakeChain) => void) {
      fn(chain);
      write();
    },
    mine(blocks: number) {
      for (let i = 0; i < blocks; i++) {
        chain.tip += 1;
        chain.hashes[chain.tip] = (chain.tip.toString(16) + "ab").padStart(64, "0");
      }
      write();
    },
  };
}
