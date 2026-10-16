// Phase 6C: copy first, then read. No service constructors, scans, keys or workers.
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../execution/store.ts";
import { PurchaseJournal, type PurchaseRow } from "../marketplace/journal.ts";
import { Purchases } from "../marketplace/service.ts";
import { Swaps } from "../swaps/service.ts";
import { SeaportPurchases } from "../seaport/service.ts";
import { checkoutView, type Dashboard } from "./view.ts";
import type { Checkout } from "./state.ts";
import { unifiedCheckouts } from "./checkouts.ts";

export const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
export function copyDatabase(source: string, destination: string) {
  const root = realpathSync(".state/phase6c/snapshots");
  const requested = relative(root, resolve(destination));
  if (requested.startsWith("..") || isAbsolute(requested))
    throw Error("snapshot_copy_required");
  mkdirSync(destination, { recursive: true });
  const rel = relative(root, realpathSync(destination));
  if (rel.startsWith("..") || isAbsolute(rel))
    throw Error("snapshot_copy_required");
  const files = ["", "-wal", "-shm"].filter((s) => existsSync(source + s));
  if (!files.includes("")) throw Error("source_database_missing");
  const before = files.map((s) => digest(source + s));
  files.forEach((s) =>
    copyFileSync(
      source + s,
      join(destination, "wallet.sqlite" + s),
      constants.COPYFILE_EXCL,
    ),
  );
  if (
    files.some(
      (s, i) =>
        digest(source + s) !== before[i] ||
        digest(join(destination, "wallet.sqlite" + s)) !== before[i],
    ) ||
    ["", "-wal", "-shm"].some(
      (s) => existsSync(source + s) !== files.includes(s),
    )
  )
    throw Error("source_changed_during_copy_stop_writers_and_retry");
  return join(destination, "wallet.sqlite");
}
export function readonlyStore(file: string, purchases = false) {
  // Deliberately bypass constructors: they migrate and recover interrupted rows.
  const store = Object.create(
    purchases ? PurchaseJournal.prototype : Store.prototype,
  ) as PurchaseJournal;
  Object.defineProperties(store, {
    db: { value: new DatabaseSync(file, { readOnly: true }) },
    confirmations: { value: 10 },
  });
  return store;
}
export function historicalSnapshot() {
  mkdirSync(".state/phase6c/snapshots", { recursive: true });
  const directory = resolve(".state/phase6c/snapshots", randomUUID());
  const copied = (file: string, name: string) =>
    copyDatabase(file, join(directory, name));
  if (
    readFileSync(".secrets/user/zcash/network", "utf8").trim() !==
    "zcash-testnet"
  )
    throw Error("testnet_only");
  const nativeWallet = join(directory, "zcash");
  copied(".secrets/user/zcash/wallet.sqlite", "zcash");
  const orders = readonlyStore(copied(".state/orders.sqlite", "orders"));
  const journal = readonlyStore(
    copied(".state/purchases.sqlite", "purchases"),
    true,
  );
  const app = new DatabaseSync(copied(".state/wallet-app.sqlite", "app"), {
    readOnly: true,
  });
  try {
    const manifest = JSON.parse(
      readFileSync("docs/PUBLIC_WALLETS.json", "utf8"),
    );
    const scans = orders.db
      .prepare(
        "SELECT detail FROM audit WHERE event='scan_verified' ORDER BY seq DESC LIMIT 1",
      )
      .get() as { detail: string } | undefined;
    const tip = scans ? JSON.parse(scans.detail).tip : 0;
    const checkouts = (
      app
        .prepare("SELECT * FROM checkouts ORDER BY created DESC")
        .all() as Checkout[]
    ).map((c) => checkoutView(c, orders, tip));
    const kinds = ["purchase", "swap", "seaport"] as const;
    const lists = Object.fromEntries(
      kinds.map((kind, index) => {
        const service = Object.create(
          [Purchases, Swaps, SeaportPurchases][index].prototype,
        ) as Purchases;
        Object.defineProperties(service, {
          store: { value: journal },
          manifest: { value: manifest },
        });
        const rows = journal.db
          .prepare(
            "SELECT * FROM purchase_requests WHERE json_extract(intent,'$.kind')=? ORDER BY created DESC",
          )
          .all(kind) as PurchaseRow[];
        return [kind, rows.map((row) => service.view(row))];
      }),
    );
    const deployment = JSON.parse(
      readFileSync(".state/deployment-confirmed.json", "utf8"),
    );
    const dashboard: Dashboard = {
      address: manifest.base.user,
      contract: deployment.contract,
      priceZatoshis: "1000000",
      zcash: null,
      base: null,
      health: {
        zcash:
          "Historical copy; no sync performed. Original wallet quarantined; do not spend.",
        base: "Not queried",
        worker: "Read-only: workers disabled",
        busy: false,
      },
      nfts: [],
      baseActivity: checkouts
        .filter((c) => c.baseTx)
        .map((c) => ({
          hash: c.baseTx!,
          status: c.status,
          kind: c.kind,
          tokenId: c.tokenId,
        })),
      checkouts,
    };
    const unified = unifiedCheckouts(
      [
        { kind: "mint", rows: checkouts.filter((c) => c.kind === "mint") },
        { kind: "action", rows: checkouts.filter((c) => c.kind === "action") },
        ...kinds.map((kind) => ({ kind, rows: lists[kind] })),
      ],
      manifest.base.user,
    );
    for (const c of unified.filter(
      (c) => !["mint", "action"].includes(c.kind) && c.destinationTx,
    )) {
      const n = lists[c.kind].find((r: any) => r.id === c.id);
      dashboard.baseActivity.push({
        hash: c.destinationTx!,
        kind: c.kind,
        status: c.status,
        tokenId: c.tokenId,
        networkName: c.networkName,
        explorer: n.explorer,
      });
    }
    const refund = JSON.parse(
      readFileSync(
        "docs/phase52-evidence/unsigned-refund-2026-10-15T07-45-30.329Z.json",
        "utf8",
      ),
    );
    if (
      refund.signed !== false ||
      refund.broadcast !== false ||
      refund.liveRefundsEnabled !== false
    )
      throw Error("unexpected_archived_refund_status");
    if (
      digest(
        ".state/phase52/99ef6572-b2ba-4d7f-a1fb-1bf333f2cb0b/transfer/unsigned-refund.pczt",
      ) !== refund.pcztSha256
    )
      throw Error("archived_unsigned_refund_changed");
    dashboard.recoverySnapshot = {
      paymentTx: refund.originalPaymentTxid,
      refundZatoshis: refund.refundZatoshis,
      feeZatoshis: refund.feeZatoshis,
      expiryHeight: refund.expiryHeight,
      archivedAt: refund.at,
      pcztSha256: refund.pcztSha256,
    };
    let dapps: {
      connections: unknown[];
      requests: unknown[];
      historical: boolean;
    } = { connections: [], requests: [], historical: true };
    if (existsSync(".state/dapps.sqlite")) {
      const db = new DatabaseSync(copied(".state/dapps.sqlite", "dapps"), {
        readOnly: true,
      });
      try {
        dapps = {
          connections: db
            .prepare(
              "SELECT origin,created FROM permissions ORDER BY created DESC",
            )
            .all(),
          requests: db
            .prepare(
              "SELECT origin,method,state,tx_hash AS txHash,created FROM requests ORDER BY created DESC LIMIT 50",
            )
            .all(),
          historical: true,
        };
      } finally {
        db.close();
      }
    }
    return {
      dapps,
      capturedAt: new Date().toISOString(),
      readOnly: true,
      nativeWallet,
      dashboard,
      lists,
      checkouts: unified,
      networks: [] as unknown[],
      liveRefundsEnabled: false,
    };
  } finally {
    app.close();
    orders.close();
    journal.close();
  }
}
