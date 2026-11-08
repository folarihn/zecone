// Early warning for Zcash network upgrades this build cannot follow.
//
// NU7 activated on mainnet at 3,543,405 while the watcher was pinned to a
// library release without its mainnet height; the watcher then stopped with
// `unsupported_consensus` and real checkouts paused for days. This compares the
// upgrades a live node schedules (`getblockchaininfo.upgrades`) with the ones
// compiled into the watch binary (`consensus-info`) so the operator is alerted
// before activation, not after. It is alerting only: it never pauses or
// approves payments, so a single public node is an acceptable source.

export interface KnownUpgrade {
  name: string;
  /** Consensus branch ID, 8 lowercase hex digits. */
  branchId: string;
  /** Mainnet activation height known to this build, or null if unset. */
  activationHeight: number | null;
}

export interface ScheduledUpgrade {
  name: string;
  branchId: string;
  activationHeight: number;
  /** Node-reported status, e.g. "active" or "pending". */
  status: string;
}

export interface UnsupportedUpgrade {
  name: string;
  branchId: string;
  activationHeight: number;
  /** Negative once the upgrade is already active on chain. */
  blocksUntilActivation: number;
  reason: "UNKNOWN_BRANCH" | "ACTIVATION_HEIGHT_MISMATCH";
  knownActivationHeight: number | null;
}

const BRANCH = /^[0-9a-f]{8}$/;

/** Parse the watch binary's `consensus-info` output. */
export function parseKnownUpgrades(value: unknown): KnownUpgrade[] {
  const upgrades = (value as { upgrades?: unknown })?.upgrades;
  if (
    (value as { network?: unknown })?.network !== "zcash-mainnet" ||
    !Array.isArray(upgrades) ||
    upgrades.length === 0
  )
    throw Error("CONSENSUS_INFO_INVALID");
  return upgrades.map((u: Record<string, unknown>) => {
    const branchId = String(u?.branchId ?? "").toLowerCase();
    const height = u?.activationHeight;
    if (
      !BRANCH.test(branchId) ||
      typeof u?.name !== "string" ||
      !(height === null || (Number.isSafeInteger(height) && Number(height) > 0))
    )
      throw Error("CONSENSUS_INFO_INVALID");
    return {
      name: u.name,
      branchId,
      activationHeight: height as number | null,
    };
  });
}

/** Parse a zcashd/zebrad `getblockchaininfo` result. */
export function parseScheduledUpgrades(result: unknown): {
  tip: number;
  upgrades: ScheduledUpgrade[];
} {
  const r = result as {
    chain?: unknown;
    blocks?: unknown;
    upgrades?: Record<string, Record<string, unknown>>;
  };
  if (
    r?.chain !== "main" ||
    !Number.isSafeInteger(r.blocks) ||
    typeof r.upgrades !== "object" ||
    r.upgrades === null
  )
    throw Error("BLOCKCHAIN_INFO_INVALID");
  const upgrades = Object.entries(r.upgrades).map(([id, u]) => {
    const branchId = id.toLowerCase();
    if (
      !BRANCH.test(branchId) ||
      !Number.isSafeInteger(u?.activationheight) ||
      Number(u.activationheight) <= 0
    )
      throw Error("BLOCKCHAIN_INFO_INVALID");
    return {
      name: String(u.name ?? branchId),
      branchId,
      activationHeight: Number(u.activationheight),
      status: String(u.status ?? "unknown"),
    };
  });
  return { tip: r.blocks as number, upgrades };
}

/** Upgrades the node schedules that this build does not follow exactly. */
export function unsupportedUpgrades(
  known: KnownUpgrade[],
  scheduled: ScheduledUpgrade[],
  tip: number,
): UnsupportedUpgrade[] {
  const byBranch = new Map(known.map((k) => [k.branchId, k]));
  const issues: UnsupportedUpgrade[] = [];
  for (const s of scheduled) {
    const k = byBranch.get(s.branchId);
    if (k && k.activationHeight === s.activationHeight) continue;
    issues.push({
      name: s.name,
      branchId: s.branchId,
      activationHeight: s.activationHeight,
      blocksUntilActivation: s.activationHeight - tip,
      reason: k ? "ACTIVATION_HEIGHT_MISMATCH" : "UNKNOWN_BRANCH",
      knownActivationHeight: k?.activationHeight ?? null,
    });
  }
  return issues;
}
