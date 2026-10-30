// Real external reads only. Never constructs a wallet client or transaction signer.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { OpenSeaPreviews } from "../services/opensea/service.ts";
import { addr } from "../services/opensea/inspection.ts";
import { DiscoveryError } from "../services/opensea/api.ts";
const manifest = JSON.parse(readFileSync("docs/PUBLIC_WALLETS.json", "utf8"));
const service = new OpenSeaPreviews(
  addr(manifest.base.user),
  addr(manifest.base.relayer),
);
const collection = process.argv[2] ?? "pudgypenguins";
mkdirSync("docs/phase4d-evidence", { recursive: true });
try {
  const catalog = await service.catalog(collection);
  writeFileSync(
    "docs/phase4d-evidence/api-catalog.json",
    JSON.stringify(
      { observedAt: new Date().toISOString(), ...catalog },
      null,
      2,
    ),
  );
  const hash = process.argv[3] ?? catalog.listings[0]?.orderHash;
  const preview = await service.preview(collection, hash);
  writeFileSync(
    "docs/phase4d-evidence/live-preview.json",
    JSON.stringify(preview, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        mode: preview.mode,
        orderHash: preview.orderHash,
        recipient: preview.recipient,
        block: preview.block,
        priceWei: preview.priceWei,
        gasBudgetWei: preview.gasBudgetWei,
        imageAvailable: !!preview.image,
        simulation: preview.simulation,
        executable: false,
      },
      null,
      2,
    ),
  );
} catch (e) {
  const reason =
    e instanceof DiscoveryError
      ? e.message
      : "Read-only chain/API verification unavailable";
  writeFileSync(
    "docs/phase4d-evidence/inspection-failure.json",
    JSON.stringify({ observedAt: new Date().toISOString(), reason }, null, 2),
  );
  console.error(reason);
  process.exitCode = 1;
}
