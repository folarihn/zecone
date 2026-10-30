import { network, chainFor, chainHex } from "../services/evm/networks.ts";
import { resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import {
  createPublicClient,
  http,
  getAddress,
  keccak256,
  hashTypedData,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  exclusiveJson,
  readJson,
  loadAccount,
  locked,
} from "../services/execution/io.ts";
import { digest } from "../services/wallet/dapps.ts";
import {
  originOf,
  hex,
  typedMessage,
  transaction,
} from "../services/wallet/dapp-policy.ts";
async function main() {
  const path = resolve(process.argv[2] ?? ""),
    within = relative(resolve(".state/dapp-approvals"), path);
  if (
    within.startsWith("..") ||
    isAbsolute(within) ||
    !/^[0-9a-f-]{36}\.json$/.test(within)
  )
    throw Error("Invalid path");
  const a = readJson<any>(path);
  originOf(a.origin);
  if (
    a.approved !== true ||
    a.expires <= Date.now() ||
    digest(a.review) !== a.reviewHash
  )
    throw Error("Invalid approval");
  const account = loadAccount(".secrets/user/base-sepolia.json"),
    r = a.review;
  const policy = network(r.chainId);
  if (getAddress(r.account) !== account.address)
    throw Error("Invalid signer");
  const output = path.replace(/\.json$/, ".signed.json");
  if (existsSync(output)) {
    const saved = readJson<any>(output);
    console.log(
      JSON.stringify(
        saved.raw ? { hash: saved.hash } : { signature: saved.signature },
      ),
    );
    return;
  }
  let result: any;
  if (a.method === "personal_sign")
    result = {
      signature: await account.signMessage({
        message: { raw: hex(r.raw, 8194) },
      }),
    };
  else if (a.method === "eth_signTypedData_v4") {
    const t = typedMessage(
      [account.address, JSON.stringify(r.typedData)],
      account.address, r.chainId,
    );
    hashTypedData(t);
    result = { signature: await account.signTypedData(t) };
  } else if (a.method === "eth_sendTransaction") {
    transaction(
      [
        {
          from: account.address,
          to: r.to,
          data: r.data,
          value: `0x${BigInt(r.value).toString(16)}`,
          chainId: chainHex(r.chainId),
        },
      ],
      account.address, r.chainId,
    );
    const client = createPublicClient({
      chain: chainFor(r.chainId),
      transport: http(policy.rpc, {
        timeout: 20000,
        retryCount: 1,
      }),
    });
    if (
      (await client.getChainId()) !== r.chainId ||
      (await client.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      })) !== r.nonce
    )
      throw Error("Chain or nonce changed");
    const gas = BigInt(r.gas),
      maxFeePerGas = BigInt(r.maxFeePerGas),
      maxPriorityFeePerGas = BigInt(r.maxPriorityFeePerGas);
    if (
      !Number.isSafeInteger(r.nonce) ||
      r.nonce < 0 ||
      gas <= 0n ||
      maxPriorityFeePerGas < 0n ||
      maxPriorityFeePerGas > maxFeePerGas ||
      gas > policy.maxGas || maxFeePerGas > policy.maxFee || gas * maxFeePerGas + policy.dataReserve > 5000000000000000n
    )
      throw Error("Invalid budget");
    const call = {
      account: account.address,
      to: getAddress(r.to),
      data: hex(r.data),
      value: BigInt(r.value),
    };
    await client.call({ ...call, gas });
    if ((await client.estimateGas(call)) > gas) throw Error("Gas changed");
    if (a.expires <= Date.now()) throw Error("Expired");
    const raw = await account.signTransaction({
      chainId: r.chainId,
      type: "eip1559",
      to: call.to,
      data: call.data,
      value: call.value,
      nonce: r.nonce,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    result = { raw, hash: keccak256(raw) };
  } else throw Error("Unsupported method");
  exclusiveJson(output, result);
  console.log(
    JSON.stringify(
      result.raw ? { hash: result.hash } : { signature: result.signature },
    ),
  );
}
locked(".state/user-dapp-signer.lock", main).catch(() => {
  console.error(
    "Local dApp signing did not complete. Preserve the request for review.",
  );
  process.exitCode = 1;
});
