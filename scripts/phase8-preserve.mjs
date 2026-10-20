// Hash-only read of protected files; no credential contents/paths in public output.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const phase = process.argv.includes("--functional")
  ? "functional"
  : process.argv.includes("--phase8d2")
    ? "phase8d2"
    : process.argv.includes("--phase8d1")
      ? "phase8d1"
      : process.argv.includes("--phase8d0")
        ? "phase8d0"
        : process.argv.includes("--phase8c")
          ? "phase8c"
          : process.argv.includes("--phase8b")
            ? "phase8b"
            : "phase8a";
const root = `.state/${phase}`,
  output = `docs/${phase}-evidence/preservation.json`;
mkdirSync(root, { recursive: true });
mkdirSync(`docs/${phase}-evidence`, { recursive: true });
const hash = (x) => createHash("sha256").update(x).digest("hex");
const groups = [
  ".state/phase6/preserved.json",
  ".state/phase7c/phase7b-preserved.json",
].map((file) => {
  const entries = Object.entries(JSON.parse(readFileSync(file, "utf8")));
  return {
    files: entries.length,
    changed: entries.filter(
      ([path, h]) => !existsSync(path) || hash(readFileSync(path)) !== h,
    ).length,
  };
});
const fingerprints = {},
  journals = [];
for (const item of ["phase7b", "phase7c"]) {
  const p = JSON.parse(readFileSync(`.state/${item}/profile.json`, "utf8"));
  const db = new DatabaseSync(`.state/${item}/${p.id}/settlement.sqlite`, {
    readOnly: true,
  });
  const financial = {};
  for (const name of [
    "orders",
    "payments",
    "solana_settlement",
    "solana_authorizations",
  ])
    financial[name] = db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all();
  fingerprints[item] = hash(JSON.stringify(financial));
  const states = financial.solana_settlement;
  const counts = db
    .prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE event IN ('solana_signing_claimed','solana_broadcast_claimed')",
    )
    .get().n;
  const claims = db
    .prepare(
      "SELECT event,COUNT(*) AS n FROM audit WHERE event IN ('solana_signing_claimed','solana_broadcast_claimed') GROUP BY event",
    )
    .all();
  journals.push({
    phase: item,
    completed:
      states.length === 1 &&
      states[0].state === "COMPLETED" &&
      financial.orders[0].state === "settled",
    signedEvidencePresent: !!states[0].wire,
    receiptPresent: !!states[0].receipt,
    signingAndBroadcastClaims: Number(counts),
    singleSigningAndBroadcastClaims:
      claims.length === 2 && claims.every((r) => Number(r.n) === 1),
    refundsDisabled: p.liveRefundsEnabled === false,
  });
  db.close();
}
const baseline = `${root}/financial-before.private.json`;
if (!existsSync(baseline)) {
  if (!process.argv.includes("--initialize"))
    throw Error(
      "Private preservation baseline missing; initialize before validation.",
    );
  writeFileSync(baseline, JSON.stringify(fingerprints), {
    flag: "wx",
    mode: 0o600,
  });
}
const unchanged =
  JSON.stringify(JSON.parse(readFileSync(baseline, "utf8"))) ===
  JSON.stringify(fingerprints);
const result = {
  at: new Date().toISOString(),
  groups,
  journals,
  financialRowsUnchanged: unchanged,
};
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (
  groups.some((x) => x.changed) ||
  !unchanged ||
  journals.some(
    (x) =>
      !x.completed || !x.refundsDisabled || !x.singleSigningAndBroadcastClaims,
  )
)
  process.exitCode = 1;
