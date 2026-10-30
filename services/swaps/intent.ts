import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
export const CHAIN = 84532,
  RATE = 20000000000000000n,
  BUDGET = 100000000000000n;
export const SOURCE = keccak256(toHex("zcash-testnet")),
  ACTION = keccak256(toHex("TOKEN_SWAP")),
  ADAPTER = keccak256(toHex("uniswap-v2-native-v1"));
export const routerAbi = parseAbi([
  "function factory() view returns(address)",
  "function WETH() view returns(address)",
  "function getAmountsOut(uint256,address[]) view returns(uint256[])",
  "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns(uint256[])",
  "function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns(uint256,uint256,uint256)",
]);
export const tokenAbi = parseAbi([
  "function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export const pairAbi = parseAbi([
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)",
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
  "event Sync(uint112 reserve0,uint112 reserve1)",
]);
export const factoryAbi = parseAbi([
  "function getPair(address,address) view returns(address)",
]);
export const fields = [
  { name: "action", type: "bytes32" },
  { name: "sourceNetwork", type: "bytes32" },
  { name: "chainId", type: "uint256" },
  { name: "orderId", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "recipient", type: "address" },
  { name: "provider", type: "address" },
  { name: "adapter", type: "bytes32" },
  { name: "target", type: "address" },
  { name: "maxNative", type: "uint256" },
  { name: "maxGas", type: "uint256" },
  { name: "zatoshis", type: "uint256" },
  { name: "expiry", type: "uint64" },
  { name: "paramsHash", type: "bytes32" },
  { name: "calldataHash", type: "bytes32" },
  { name: "refundHash", type: "bytes32" },
] as const;
export const swapFields = [
  { name: "inputAsset", type: "address" },
  { name: "amountIn", type: "uint256" },
  { name: "outputToken", type: "address" },
  { name: "decimals", type: "uint8" },
  { name: "router", type: "address" },
  { name: "routeHash", type: "bytes32" },
  { name: "expectedOut", type: "uint256" },
  { name: "minOut", type: "uint256" },
  { name: "slippageBps", type: "uint256" },
  { name: "deadline", type: "uint64" },
  { name: "referenceBlock", type: "uint256" },
  { name: "referenceHash", type: "bytes32" },
] as const;
const tuple = `(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`,
  swapTuple = `(${swapFields.map((f) => `${f.type} ${f.name}`).join(",")})`;
export const executorAbi = parseAbi([
  `function execute(${tuple} i,${swapTuple} s,bytes signature) payable`,
  `function intentId(${tuple} i) view returns(bytes32)`,
  "function consumed(bytes32) view returns(bool)",
  "function relayer() view returns(address)",
  "function router() view returns(address)",
  "function token() view returns(address)",
  "function pool() view returns(address)",
  "error Replay()",
  "error InvalidIntent()",
  "error Slippage()",
  "error ReceiptMismatch()",
  "event SwapExecuted(bytes32 indexed digest,address indexed recipient,address indexed token,uint256 amountIn,uint256 amountOut,uint256 balanceBefore,uint256 balanceAfter)",
]);
export type SwapConfig = {
  chainId: 84532;
  provider: Address;
  user: Address;
  router: Address;
  factory: Address;
  weth: Address;
  token: Address;
  pool: Address;
  executor: Address;
  codeHashes: Record<Address, Hex>;
};
export type SwapIntent = {
  kind: "swap";
  version: 1;
  chainId: 84532;
  contract: Address;
  orderId: Hex;
  nonce: Hex;
  recipient: Address;
  provider: Address;
  sourceNetwork: Hex;
  adapter: Hex;
  target: Address;
  maxNative: string;
  maxGas: string;
  price: string;
  gasBudget: string;
  zatoshis: string;
  expiry: number;
  refundHash: Hex;
  inputAsset: Address;
  outputToken: Address;
  decimals: 18;
  router: Address;
  route: [Address, Address];
  expectedOut: string;
  minOut: string;
  slippageBps: number;
  referenceBlock: string;
  referenceHash: Hex;
  signature: Hex;
};
export type UnsignedSwap = Omit<SwapIntent, "signature">;
export function output(amount: bigint, reserveIn: bigint, reserveOut: bigint) {
  if (amount <= 0n || reserveIn <= 0n || reserveOut <= 0n)
    throw Error("insufficient_liquidity");
  return (amount * 997n * reserveOut) / (reserveIn * 1000n + amount * 997n);
}
export function impactBps(
  amount: bigint,
  result: bigint,
  ri: bigint,
  ro: bigint,
) {
  return Number(10000n - (result * ri * 10000n) / (amount * ro));
}
export function zecCost(amount: bigint) {
  return ((amount + BUDGET) * 100000000n + RATE - 1n) / RATE;
}
export function swapParams(i: UnsignedSwap) {
  return {
    inputAsset: i.inputAsset,
    amountIn: BigInt(i.maxNative),
    outputToken: i.outputToken,
    decimals: i.decimals,
    router: i.router,
    routeHash: keccak256(
      encodeAbiParameters([{ type: "address[]" }], [i.route]),
    ),
    expectedOut: BigInt(i.expectedOut),
    minOut: BigInt(i.minOut),
    slippageBps: BigInt(i.slippageBps),
    deadline: BigInt(i.expiry),
    referenceBlock: BigInt(i.referenceBlock),
    referenceHash: i.referenceHash,
  };
}
export function swapData(i: UnsignedSwap) {
  return encodeFunctionData({
    abi: routerAbi,
    functionName: "swapExactETHForTokens",
    args: [BigInt(i.minOut), i.route, i.recipient, BigInt(i.expiry)],
  });
}
export function swapTyped(i: UnsignedSwap) {
  const s = swapParams(i);
  return {
    domain: {
      name: "ZecOneExecution",
      version: "1",
      chainId: i.chainId,
      verifyingContract: i.contract,
    },
    types: { ExecutionIntent: fields },
    primaryType: "ExecutionIntent" as const,
    message: {
      action: ACTION,
      sourceNetwork: i.sourceNetwork,
      chainId: BigInt(i.chainId),
      orderId: i.orderId,
      nonce: i.nonce,
      recipient: i.recipient,
      provider: i.provider,
      adapter: i.adapter,
      target: i.target,
      maxNative: BigInt(i.maxNative),
      maxGas: BigInt(i.maxGas),
      zatoshis: BigInt(i.zatoshis),
      expiry: BigInt(i.expiry),
      paramsHash: keccak256(
        encodeAbiParameters([{ type: "tuple", components: swapFields }], [s]),
      ),
      calldataHash: keccak256(swapData(i)),
      refundHash: i.refundHash,
    },
  };
}
const eq = (a: string, b: string) => getAddress(a) === getAddress(b);
export function terms(i: UnsignedSwap, c: SwapConfig, at: number) {
  for (const v of [
    i.maxNative,
    i.maxGas,
    i.price,
    i.gasBudget,
    i.zatoshis,
    i.expectedOut,
    i.minOut,
    i.referenceBlock,
  ])
    if (!/^(0|[1-9][0-9]{0,76})$/.test(v)) throw Error("invalid_swap_integer");
  for (const v of [i.orderId, i.nonce, i.refundHash, i.referenceHash])
    if (!/^0x[0-9a-f]{64}$/.test(v) || BigInt(v) === 0n)
      throw Error("invalid_swap_hash");
  if (
    i.kind !== "swap" ||
    i.version !== 1 ||
    i.chainId !== CHAIN ||
    c.chainId !== CHAIN ||
    !eq(i.contract, c.executor) ||
    !eq(i.provider, c.provider) ||
    !eq(i.recipient, c.user) ||
    eq(i.recipient, c.provider) ||
    eq(i.recipient, zeroAddress) ||
    i.sourceNetwork !== SOURCE ||
    i.adapter !== ADAPTER ||
    !eq(i.target, c.router) ||
    !eq(i.router, c.router) ||
    !eq(i.outputToken, c.token) ||
    !eq(i.inputAsset, c.weth) ||
    i.decimals !== 18 ||
    i.route.length !== 2 ||
    !eq(i.route[0], c.weth) ||
    !eq(i.route[1], c.token) ||
    BigInt(i.maxNative) <= 0n ||
    BigInt(i.maxNative) > 200000000000000n ||
    i.price !== i.maxNative ||
    i.maxGas !== BUDGET.toString() ||
    i.gasBudget !== i.maxGas ||
    i.zatoshis !== zecCost(BigInt(i.maxNative)).toString() ||
    !Number.isSafeInteger(i.slippageBps) ||
    i.slippageBps < 1 ||
    i.slippageBps > 300 ||
    BigInt(i.minOut) <= 0n ||
    BigInt(i.minOut) !==
      (BigInt(i.expectedOut) * BigInt(10000 - i.slippageBps)) / 10000n ||
    !Number.isSafeInteger(i.expiry) ||
    i.expiry <= at ||
    i.expiry > at + 3600 ||
    BigInt(i.referenceBlock) <= 0n
  )
    throw Error("invalid_swap_terms");
  return hashTypedData(swapTyped(i));
}
export async function signature(i: SwapIntent, c: SwapConfig, at: number) {
  const id = terms(i, c, at);
  if (
    !eq(
      await recoverTypedDataAddress({
        ...swapTyped(i),
        signature: i.signature,
      }),
      c.user,
    )
  )
    throw Error("unauthorized_swap_signer");
  return id;
}
