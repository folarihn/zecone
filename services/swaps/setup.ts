import {
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { readJson } from "../execution/io.ts";
import { factoryAbi, routerAbi, tokenAbi, type SwapConfig } from "./intent.ts";
import { client, inspect } from "./adapter.ts";
export const SEED_ETH = 5000000000000000n,
  SEED_TOKEN = 1000000000000000000000n;
export type SetupStep = (
  name: string,
  data: Hex,
  to?: Address,
  value?: bigint,
) => Promise<TransactionReceipt>;
export function artifact(name: string) {
  const paths: Record<string, string> = {
    WETH9: "node_modules/@uniswap/v2-periphery/build/WETH9.json",
    UniswapV2Factory:
      "node_modules/@uniswap/v2-core/build/UniswapV2Factory.json",
    UniswapV2Router02:
      "node_modules/@uniswap/v2-periphery/build/UniswapV2Router02.json",
    SwapTestToken: "out/SwapTestToken.sol/SwapTestToken.json",
    ZecOneSwapExecutor: "out/ZecOneSwapExecutor.sol/ZecOneSwapExecutor.json",
  };
  const a = readJson<any>(paths[name]);
  return {
    abi: a.abi,
    bytecode: (typeof a.bytecode === "string"
      ? a.bytecode.startsWith("0x")
        ? a.bytecode
        : `0x${a.bytecode}`
      : a.bytecode.object) as Hex,
  };
}
export async function infrastructure(
  step: SetupStep,
  provider: Address,
  user: Address,
  p = client(),
): Promise<SwapConfig> {
  if ((await p.getChainId()) !== 84532) throw Error("Base Sepolia only");
  async function deploy(name: string, args: unknown[] = []) {
    const a = artifact(name),
      r = await step(name, encodeDeployData({ ...a, args }));
    if (!r.contractAddress) throw Error("deployment_missing_address");
    return r.contractAddress;
  }
  const weth = await deploy("WETH9"),
    token = await deploy("SwapTestToken", [provider]),
    factory = await deploy("UniswapV2Factory", [provider]),
    router = await deploy("UniswapV2Router02", [factory, weth]);
  await step(
    "token-approval",
    encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [router, SEED_TOKEN],
    }),
    token,
  );
  // Stable seed deadline is supplied by the caller's persisted exact calldata when resuming.
  const expiry = (await p.getBlock()).timestamp + 86400n;
  await step(
    "seed-liquidity",
    encodeFunctionData({
      abi: routerAbi,
      functionName: "addLiquidityETH",
      args: [token, SEED_TOKEN, SEED_TOKEN, SEED_ETH, provider, expiry],
    }),
    router,
    SEED_ETH,
  );
  const pool = await p.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getPair",
    args: [weth, token],
  });
  const executor = await deploy("ZecOneSwapExecutor", [
    provider,
    router,
    token,
  ]);
  const codeHashes: Record<Address, Hex> = {};
  for (const address of [weth, token, factory, router, pool, executor]) {
    const code = await p.getBytecode({ address });
    if (!code) throw Error("empty_contract");
    codeHashes[address] = keccak256(code);
  }
  const c: SwapConfig = {
    chainId: 84532,
    user,
    provider,
    weth,
    token,
    factory,
    router,
    pool,
    executor,
    codeHashes,
  };
  await inspect(c, p);
  if (
    (await p.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "allowance",
      args: [provider, router],
    })) !== 0n
  )
    throw Error("unused_setup_allowance");
  return c;
}
