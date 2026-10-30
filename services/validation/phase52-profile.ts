// Disposable-profile metadata only. No wallet secrets, signer or broadcaster APIs.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep, relative } from "node:path";
import { exclusiveJson } from "../execution/io.ts";
export const ROLES = ["payer", "settlement", "refund-destination"] as const;
export type Phase52Profile = {
  version: 1;
  phase: "5.2";
  network: "zcash-testnet";
  id: string;
  transactionNamespace: string;
  paymentRequestId: string;
  refundRequestId: string;
  simulatedIsolation: true;
  liveRefundsEnabled: false;
  confirmations: 10;
  roles: { role: (typeof ROLES)[number]; keys: string; watch: string }[];
  independentSettlementWatch: string;
};
const uuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    s,
  );
function layout(root: string, id: string) {
  if (!uuid(id)) throw Error("invalid_phase52_id");
  return {
    state: resolve(root, ".state/phase52", id),
    keys: resolve(root, ".secrets/phase52", id),
  };
}
function noLinkedAncestors(root: string, path: string) {
  const r = realpathSync(root),
    rel = relative(r, path);
  if (rel.startsWith("..") || resolve(r, rel) !== path)
    throw Error("profile_outside_workspace");
  let p = r;
  for (const name of rel.split(sep)) {
    p = join(p, name);
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw Error("linked_profile_path");
  }
}
export function validatePhase52Profile(
  value: unknown,
  root = process.cwd(),
): Phase52Profile {
  const p = value as Phase52Profile;
  if (
    !p ||
    Object.keys(p).sort().join(",") !==
      [
        "version",
        "phase",
        "network",
        "id",
        "transactionNamespace",
        "paymentRequestId",
        "refundRequestId",
        "simulatedIsolation",
        "liveRefundsEnabled",
        "confirmations",
        "roles",
        "independentSettlementWatch",
      ]
        .sort()
        .join(",") ||
    p.version !== 1 ||
    p.phase !== "5.2" ||
    p.network !== "zcash-testnet" ||
    p.simulatedIsolation !== true ||
    p.liveRefundsEnabled !== false ||
    p.confirmations !== 10 ||
    !uuid(p.id) ||
    !uuid(p.paymentRequestId) ||
    !uuid(p.refundRequestId) ||
    new Set([p.id, p.paymentRequestId, p.refundRequestId]).size !== 3 ||
    p.transactionNamespace !== `zecone-phase52:${p.id}` ||
    !Array.isArray(p.roles) ||
    p.roles.length !== 3
  )
    throw Error("invalid_phase52_profile");
  const l = layout(root, p.id);
  for (let i = 0; i < ROLES.length; i++) {
    const r = p.roles[i],
      role = ROLES[i];
    if (
      !r ||
      Object.keys(r).sort().join(",") !== "keys,role,watch" ||
      r.role !== role ||
      r.keys !== join(l.keys, role) ||
      r.watch !==
        join(
          l.state,
          role === "settlement" ? "backend/wallet-b-watch" : `${role}-watch`,
        )
    )
      throw Error("phase52_role_path_conflict");
    noLinkedAncestors(root, r.keys);
    noLinkedAncestors(root, r.watch);
  }
  if (p.independentSettlementWatch !== join(l.state, "signer/wallet-b-watch"))
    throw Error("phase52_signer_path_conflict");
  noLinkedAncestors(root, p.independentSettlementWatch);
  return p;
}
export function reservePhase52Profile(root = process.cwd()): Phase52Profile {
  const pointer = resolve(root, ".state/phase52-profile.json");
  if (existsSync(pointer))
    throw Error("phase52_profile_already_reserved_no_automatic_replacement");
  const id = randomUUID(),
    l = layout(root, id);
  const p: Phase52Profile = {
    version: 1,
    phase: "5.2",
    network: "zcash-testnet",
    id,
    transactionNamespace: `zecone-phase52:${id}`,
    paymentRequestId: randomUUID(),
    refundRequestId: randomUUID(),
    simulatedIsolation: true,
    liveRefundsEnabled: false,
    confirmations: 10,
    roles: ROLES.map((role) => ({
      role,
      keys: join(l.keys, role),
      watch: join(
        l.state,
        role === "settlement" ? "backend/wallet-b-watch" : `${role}-watch`,
      ),
    })),
    independentSettlementWatch: join(l.state, "signer/wallet-b-watch"),
  };
  validatePhase52Profile(p, root);
  if (existsSync(l.state) || existsSync(l.keys))
    throw Error("phase52_directory_already_exists");
  exclusiveJson(pointer, p); // Exclusive reservation survives interrupted provisioning.
  mkdirSync(l.state, { recursive: true, mode: 0o700 });
  mkdirSync(l.keys, { recursive: true, mode: 0o700 });
  return p;
}
export function phase52BackendConfiguration(
  p: Phase52Profile,
  root = process.cwd(),
) {
  validatePhase52Profile(p, root);
  return {
    version: 1,
    phase: "5.2",
    profileId: p.id,
    network: p.network,
    transactionNamespace: p.transactionNamespace,
    confirmations: p.confirmations,
    walletBWatch: p.roles[1].watch,
    liveRefundsEnabled: false,
    executionEnabled: false,
  };
}

// Native address allocation may choose different diversifiers in two databases.
// Their UFVK identity and birthday must agree; default receiving strings need not.
export function verifySettlementWatchIdentity(
  a: { network: string; keyId: string; birthday: number },
  b: { network: string; keyId: string; birthday: number },
) {
  if (
    a.network !== "zcash-testnet" ||
    b.network !== a.network ||
    !Number.isSafeInteger(a.birthday) ||
    a.birthday < 1 ||
    a.birthday !== b.birthday ||
    !/^[a-f0-9]{64}$/.test(a.keyId) ||
    a.keyId !== b.keyId
  )
    throw Error("settlement_viewing_copies_disagree");
}
