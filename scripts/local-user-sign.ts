// Separate user-side signer. No relayer key is loaded. Only gateway-written approvals.
import { existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { getAddress, type Address } from "viem";
import {
  exclusiveJson,
  loadAccount,
  readJson,
} from "../services/execution/io.ts";
import { PRICE, typed, type Intent } from "../services/execution/intent.ts";
import { ORIGIN } from "../services/wallet/security.ts";
async function main() {
  const file = resolve(process.argv[2] ?? "");
  const within = relative(resolve(".state/browser-approvals"), file);
  if (
    within.startsWith("..") ||
    isAbsolute(within) ||
    !within.endsWith(".json")
  )
    throw Error("Invalid approval path");
  const approval = readJson<{
    kind: string;
    expires: number;
    approved: boolean;
    message?: string;
    intent?: Omit<Intent, "signature">;
  }>(file);
  if (!approval.approved || approval.expires <= Date.now())
    throw Error("Approval expired");
  const account = loadAccount(".secrets/user/base-sepolia.json");
  if (approval.kind === "ownership") {
    if (
      !approval.message?.startsWith(
        `ZecOne local wallet connection\nOrigin: ${ORIGIN}\nAccount: ${account.address}\nChain: 84532\n`,
      )
    )
      throw Error("Invalid challenge");
    console.log(
      JSON.stringify({
        signature: await account.signMessage({ message: approval.message }),
      }),
    );
    return;
  }
  if (approval.kind !== "mint-intent" || !approval.intent)
    throw Error("Unsupported approval");
  const { contract } = readJson<{ contract: Address }>(
      ".state/deployment-confirmed.json",
    ),
    i = approval.intent;
  if (
    getAddress(i.contract) !== getAddress(contract) ||
    getAddress(i.recipient) !== account.address ||
    BigInt(i.zatoshis) !== PRICE ||
    i.expiry <= Math.floor(Date.now() / 1000) ||
    i.expiry > Math.floor(Date.now() / 1000) + 86400
  )
    throw Error("Invalid intent");
  const output = file.replace(/\.json$/, ".signed.json");
  if (!existsSync(output))
    exclusiveJson(output, {
      ...i,
      signature: await account.signTypedData(typed(i)),
    });
  console.log(JSON.stringify({ intentFile: output }));
}
main().catch(() => {
  console.error("Local approval could not be signed.");
  process.exitCode = 1;
});
