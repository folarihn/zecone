import { type Devnet } from "./network.ts";
// A second independently operated source is required before asserting consensus.
// Phase 7A uses this only in tests: no independent live endpoint configured.
export async function corroborate(
  first: Pick<Devnet, "status">,
  second: Pick<Devnet, "status">,
  signature: string,
) {
  try {
    const [a, b] = await Promise.all([
      first.status(signature),
      second.status(signature),
    ]);
    return a === b ? a : "RPC_DISAGREEMENT";
  } catch {
    return "RPC_UNAVAILABLE";
  }
}
