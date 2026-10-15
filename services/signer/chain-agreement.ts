const operators: Record<string, string> = {
  "https://testnet.zec.rocks:443": "zec.rocks",
  "https://lightwalletd.testnet.electriccoin.co:9067": "ECC",
  "https://lwd.testnet.zec.pro:443": "ZEC.PRO",
};
export type ChainCheckpoint = {
  network: string;
  source: string;
  chainName: string;
  tip: number;
  branch: string;
  height: number;
  blockHash: string;
  ironwoodAnchor: string;
  observedAt: number;
};
/** Provider agreement is evidence corroboration, never full consensus verification. */
export function verifyProviderAgreement(
  a: ChainCheckpoint,
  b: ChainCheckpoint,
  now: number,
) {
  for (const s of [a, b])
    if (
      s.network !== "zcash-testnet" ||
      s.chainName !== "test" ||
      !operators[s.source] ||
      !Number.isSafeInteger(s.tip) ||
      !Number.isSafeInteger(s.height) ||
      s.height < 1 ||
      s.tip < s.height ||
      !/^[a-f0-9]{64}$/.test(s.blockHash) ||
      !/^[a-f0-9]{64}$/.test(s.ironwoodAnchor) ||
      !/^[a-f0-9]{8}$/.test(s.branch) ||
      !Number.isSafeInteger(s.observedAt) ||
      s.observedAt > now + 5 ||
      now - s.observedAt > 120
    )
      throw Error("invalid_or_stale_chain_checkpoint");
  if (operators[a.source] === operators[b.source])
    throw Error("independent_provider_required");
  if (
    a.height !== b.height ||
    a.blockHash !== b.blockHash ||
    a.ironwoodAnchor !== b.ironwoodAnchor ||
    a.branch !== b.branch
  )
    throw Error("scanner_disagreement");
  const confirmations = Math.min(a.tip, b.tip) - a.height + 1;
  if (confirmations < 10) throw Error("insufficient_independent_confirmations");
  return {
    height: a.height,
    blockHash: a.blockHash,
    confirmations,
    independentProviders: true,
    fullConsensusValidation: false,
  };
}
