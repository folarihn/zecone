import {
  EvidenceReader,
  EvidenceError,
  type ReadRpc,
} from "../execution/rpc-confidence.ts";
import { network } from "./networks.ts";
const invalid = (): never => {
  throw new EvidenceError("INVALID_EVIDENCE");
};
const quantity = (v: any): bigint =>
  typeof v === "string" && /^0x(0|[1-9a-f][0-9a-f]*)$/i.test(v)
    ? BigInt(v)
    : invalid();
const hex = (v: any, bytes: number) =>
  typeof v === "string" && new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`, "i").test(v)
    ? v.toLowerCase()
    : invalid();
async function observe(rpc: ReadRpc, chainId: number, hash: string) {
  const policy = network(chainId);
  if (quantity(await rpc("eth_chainId", [])) !== BigInt(chainId))
    throw new EvidenceError("WRONG_NETWORK");
  const r = await rpc("eth_getTransactionReceipt", [hash]);
  if (!r) return null;
  const height = quantity(r.blockNumber),
    head = quantity(await rpc("eth_blockNumber", []));
  const b = await rpc("eth_getBlockByNumber", [r.blockNumber, false]);
  if (!b) return null;
  if (
    hex(r.transactionHash, 32) !== hash.toLowerCase() ||
    hex(b.hash, 32) !== hex(r.blockHash, 32) ||
    quantity(b.number) !== height ||
    ![0n, 1n].includes(quantity(r.status)) ||
    !Array.isArray(r.logs)
  )
    return invalid();
  const material = {
    hash: hash.toLowerCase(),
    height: height.toString(),
    blockHash: hex(r.blockHash, 32),
    status: quantity(r.status).toString(),
    index: quantity(r.transactionIndex).toString(),
    from: hex(r.from, 20),
    to: r.to === null ? null : hex(r.to, 20),
    contract: r.contractAddress === null ? null : hex(r.contractAddress, 20),
    gasUsed: quantity(r.gasUsed).toString(),
    effectiveGasPrice: quantity(r.effectiveGasPrice).toString(),
    logs: r.logs
      .map((l: any) => {
        if (
          l.removed ||
          hex(l.transactionHash, 32) !== hash.toLowerCase() ||
          hex(l.blockHash, 32) !== hex(r.blockHash, 32) ||
          quantity(l.blockNumber) !== height ||
          !/^0x([0-9a-f]{2})*$/i.test(l.data) ||
          !Array.isArray(l.topics)
        )
          return invalid();
        return {
          index: quantity(l.logIndex).toString(),
          address: hex(l.address, 20),
          data: l.data.toLowerCase(),
          topics: l.topics.map((t: any) => hex(t, 32)),
        };
      })
      .sort((a: any, b: any) => Number(BigInt(a.index) - BigInt(b.index))),
  };
  // Different current heads are expected; compare immutable receipt/block effects,
  // then demand each provider independently meets the existing depth policy.
  if (head < height || head - height + 1n < BigInt(policy.confirmations))
    return null;
  return {
    evidence: { receipt: r, confirmations: (head - height + 1n).toString() },
    material,
  };
}
export function evmReceiptEvidence(
  reader: EvidenceReader,
  chainId: number,
  hash: string,
) {
  network(chainId);
  if (!/^0x[0-9a-f]{64}$/i.test(hash))
    throw new EvidenceError("INVALID_DESTINATION_REFERENCE");
  return reader.verify("EVM_CANONICAL_DEPTH_RECEIPT", (rpc) =>
    observe(rpc, chainId, hash),
  );
}
