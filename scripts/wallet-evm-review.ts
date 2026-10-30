// Read-only operator review. It never creates an order, pays, signs or broadcasts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../services/execution/store.ts";
import { adapterFor } from "../services/evm/adapter.ts";
import { EvmTransferSettlement } from "../services/settlement/evm-transfer.ts";
import {
  DEFAULT_TRANSFER_POLICY,
  type Erc20Asset,
  type SplAsset,
  type TransferPolicy,
} from "../services/settlement/transfers.ts";

const args = process.argv.slice(2),
  requestPath = args[0],
  policyIndex = args.indexOf("--policy"),
  policyPath = policyIndex >= 0 ? args[policyIndex + 1] : undefined,
  rest = args.filter((a) => a !== "--policy" && a !== policyPath),
  valid =
    !!requestPath &&
    (policyIndex < 0
      ? rest.length === 1
      : rest.length === 3 && rest[1] === "--policy" && !!policyPath);
if (!valid)
  throw Error(
    "Usage: wallet-evm-review <public-request.json> [--policy <policy.json>]",
  );
const uint = (value: unknown, label: string) => {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value))
    throw Error(`INVALID_${label}`);
  return BigInt(value);
};
const policyFile = policyPath
  ? JSON.parse(readFileSync(resolve(policyPath), "utf8"))
  : null;
const policy: TransferPolicy = policyFile
  ? {
      erc20: Object.fromEntries(
        Object.entries(policyFile.erc20 ?? {}).map(([id, tokens]) => [
          id,
          (tokens as Erc20Asset[]).map((t) => ({
            kind: "ERC20",
            address: t.address,
            decimals: t.decimals,
          })),
        ]),
      ) as TransferPolicy["erc20"],
      spl: ((policyFile.spl ?? []) as SplAsset[]).map((s) => ({
        kind: "SPL",
        mint: s.mint,
        decimals: s.decimals,
      })),
      evmNativeCapWei: uint(policyFile.evmNativeCapWei, "NATIVE_CAP"),
      erc20Cap: uint(policyFile.erc20Cap, "ERC20_CAP"),
      solLamportsCap: uint(policyFile.solLamportsCap, "SOL_CAP"),
      splCap: uint(policyFile.splCap, "SPL_CAP"),
    }
  : DEFAULT_TRANSFER_POLICY;
const request = JSON.parse(readFileSync(resolve(requestPath), "utf8"));
if (!request || typeof request !== "object" || Array.isArray(request))
  throw Error("A public EVM review request object is required.");
if (!Number.isSafeInteger(request.chainId)) throw Error("INVALID_CHAIN");
const store = new Store(":memory:"),
  service = new EvmTransferSettlement(
    store,
    adapterFor(request.chainId),
    undefined,
    policy,
  );
try {
  const preview = await service.preview(request);
  console.log(
    JSON.stringify(
      {
        ...preview,
        broadcast: false,
        signing: false,
        notice:
          "Read-only quote. No financial order, payment, signature or broadcast was created.",
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
