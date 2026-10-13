// MAINNET READ-ONLY: no walletClient, private key, payment allocation or settlement imports.
import {
  createPublicClient,
  http,
  getAddress,
  zeroAddress,
  zeroHash,
  hashStruct,
  hashDomain,
  recoverTypedDataAddress,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toFunctionSignature,
  type Address,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import {
  components,
  orderTypes,
  seaportAbi,
  PROTOCOL,
  type Components,
} from "../seaport/protocol.ts";
import { DiscoveryError } from "./api.ts";
export const CONDUIT_KEY =
  "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000" as Hex;
export const CONTROLLER =
  "0x00000000F9490004C11Cef243f5400493c00Ad63" as Address;
export const CONDUIT = "0x1E0049783F008A0085193E00003D00cd54003c71" as Address;
const nftAbi = parseAbi([
  "function ownerOf(uint256) view returns(address)",
  "function getApproved(uint256) view returns(address)",
  "function isApprovedForAll(address,address) view returns(bool)",
]);
const conduitAbi = parseAbi([
  "function getConduit(bytes32) view returns(address conduit,bool exists)",
  "function getConduitCodeHashes() view returns(bytes32 creationCodeHash,bytes32 runtimeCodeHash)",
  "function getChannelStatus(address,address) view returns(bool)",
]);
export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new DiscoveryError(message);
}
export const addr = (v: any): Address => {
  try {
    return getAddress(v);
  } catch {
    throw new DiscoveryError("Invalid API address");
  }
};
export function integer(v: any): string {
  check(
    typeof v === "string" || (typeof v === "number" && Number.isSafeInteger(v)),
    "Unsafe API integer",
  );
  check(
    /^(0|[1-9][0-9]{0,77}|0x[0-9a-fA-F]{1,64})$/.test(String(v)),
    "Invalid API integer",
  );
  const b = BigInt(v);
  check(b < 2n ** 256n, "API integer overflow");
  return String(b);
}
const hash = (v: any): Hex => {
  check(
    typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v),
    "Invalid API hash",
  );
  return v.toLowerCase() as Hex;
};
export function normalize(p: any): Components {
  check(
    p &&
      Array.isArray(p.offer) &&
      p.offer.length === 1 &&
      Array.isArray(p.consideration) &&
      p.consideration.length >= 1 &&
      p.consideration.length <= 5,
    "Unsupported Seaport items",
  );
  const item = (x: any) => ({
    itemType: Number(integer(x.itemType)),
    token: addr(x.token),
    identifierOrCriteria: integer(x.identifierOrCriteria),
    startAmount: integer(x.startAmount),
    endAmount: integer(x.endAmount),
  });
  check(
    integer(p.totalOriginalConsiderationItems) ===
      String(p.consideration.length),
    "Added consideration is unsupported",
  );
  return {
    offerer: addr(p.offerer),
    zone: addr(p.zone),
    offer: p.offer.map(item),
    consideration: p.consideration.map((x: any) => ({
      ...item(x),
      recipient: addr(x.recipient),
    })),
    orderType: Number(integer(p.orderType)),
    startTime: integer(p.startTime),
    endTime: integer(p.endTime),
    zoneHash: hash(p.zoneHash),
    salt: integer(p.salt),
    conduitKey: hash(p.conduitKey),
    counter: integer(p.counter),
  };
}
export function parseListing(raw: any, now = Math.floor(Date.now() / 1000)) {
  check(
    raw?.chain === "ethereum" &&
      addr(raw.protocol_address) === PROTOCOL &&
      raw.status === "ACTIVE" &&
      raw.remaining_quantity === 1,
    "Unsupported chain, protocol or listing status",
  );
  const p = normalize(raw.protocol_data?.parameters),
    o = p.offer[0];
  check(
    p.orderType === 0 &&
      p.zone === zeroAddress &&
      p.zoneHash === zeroHash &&
      [zeroHash, CONDUIT_KEY].includes(p.conduitKey),
    "Unsupported Seaport order or conduit",
  );
  check(
    BigInt(p.startTime) <= BigInt(now) && BigInt(p.endTime) > BigInt(now + 30),
    "Listing expired or not yet active",
  );
  check(
    o.itemType === 2 &&
      o.token !== zeroAddress &&
      o.startAmount === "1" &&
      o.endAmount === "1",
    "Only one fixed ERC-721 is supported",
  );
  check(
    addr(raw.asset?.contract) === o.token &&
      integer(raw.asset?.identifier) === o.identifierOrCriteria,
    "API asset mismatch",
  );
  check(
    p.offerer !== zeroAddress && p.consideration[0].recipient === p.offerer,
    "Invalid seller consideration",
  );
  let total = 0n;
  const seen = new Set<string>();
  for (const c of p.consideration) {
    check(
      c.itemType === 0 &&
        c.token === zeroAddress &&
        c.identifierOrCriteria === "0" &&
        BigInt(c.startAmount) > 0n &&
        c.startAmount === c.endAmount &&
        c.recipient !== zeroAddress &&
        !seen.has(c.recipient),
      "Unsupported or changed consideration",
    );
    seen.add(c.recipient);
    total += BigInt(c.startAmount);
  }
  const fees = total - BigInt(p.consideration[0].startAmount);
  check(fees * 100n <= total * 5n, "Fees exceed read-only inspection policy");
  check(
    raw.price?.current?.currency === "ETH" &&
      raw.price.current.decimals === 18 &&
      integer(raw.price.current.value) === String(total),
    "API price mismatch",
  );
  const orderHash = hash(raw.order_hash);
  check(
    hashStruct({
      types: orderTypes,
      primaryType: "OrderComponents",
      data: components(p),
    }) === orderHash,
    "Order hash mismatch",
  );
  return {
    p,
    orderHash,
    total,
    fees,
    nft: o.token,
    tokenId: o.identifierOrCriteria,
  };
}
export type InspectedListing = ReturnType<typeof parseListing>;
export function checkedFulfillment(
  raw: any,
  l: InspectedListing,
  recipient: Address,
) {
  const f = raw?.fulfillment_data,
    t = f?.transaction,
    d = t?.input_data;
  check(
    ["seaport", "seaport1.6"].includes(raw?.protocol) &&
      t?.chain === 1 &&
      addr(t.to) === PROTOCOL &&
      Array.isArray(f.orders) &&
      f.orders.length === 1,
    "Unsupported fulfillment protocol or chain",
  );
  check(
    integer(t.value) === String(l.total) &&
      (t.value_hex == null || integer(t.value_hex) === String(l.total)),
    "Fulfillment value mismatch",
  );
  check(
    d &&
      addr(d.recipient) === recipient &&
      [zeroHash, CONDUIT_KEY].includes(d.fulfillerConduitKey) &&
      Array.isArray(d.criteriaResolvers) &&
      d.criteriaResolvers.length === 0,
    "Fulfillment recipient or conduit mismatch",
  );
  check(
    Object.keys(d).every((k) =>
      [
        "advancedOrder",
        "criteriaResolvers",
        "fulfillerConduitKey",
        "recipient",
      ].includes(k),
    ),
    "Unsupported fulfillment arguments",
  );
  const order = f.orders[0],
    signature = order.signature;
  check(
    typeof signature === "string" &&
      /^0x(?:[a-fA-F0-9]{128}|[a-fA-F0-9]{130})$/.test(signature),
    "Unsupported seller signature",
  );
  check(
    JSON.stringify(normalize(order.parameters)) === JSON.stringify(l.p),
    "Fulfillment order changed",
  );
  const { counter, ...p } = components(l.p);
  const advanced = {
    parameters: {
      ...p,
      totalOriginalConsiderationItems: BigInt(p.consideration.length),
    },
    numerator: 1n,
    denominator: 1n,
    signature: signature as Hex,
    extraData: "0x" as Hex,
  };
  const data = encodeFunctionData({
    abi: seaportAbi,
    functionName: "fulfillAdvancedOrder",
    args: [advanced, [], d.fulfillerConduitKey, recipient],
  });
  const entry = seaportAbi.find(
    (v) => v.type === "function" && v.name === "fulfillAdvancedOrder",
  )!;
  check(
    t.function === toFunctionSignature(entry as any),
    "Unsupported fulfillment method",
  );
  let proposed: Hex;
  try {
    proposed = encodeFunctionData({
      abi: seaportAbi,
      functionName: "fulfillAdvancedOrder",
      args: [
        d.advancedOrder,
        d.criteriaResolvers,
        d.fulfillerConduitKey,
        d.recipient,
      ],
    });
  } catch {
    throw new DiscoveryError("Malformed fulfillment calldata");
  }
  check(proposed === data, "Fulfillment calldata changed");
  // OpenSea's documented transaction schema supplies attribution separately. Only
  // a four-byte tag is accepted, retained unchanged, and used only in eth_call.
  const suffix = t.calldata_suffix ?? "0x";
  check(
    typeof suffix === "string" && /^(0x|0x[0-9a-fA-F]{8})$/.test(suffix),
    "Unsupported attribution suffix",
  );
  return {
    data: (data + suffix.slice(2)) as Hex,
    signature: signature as Hex,
    suffix,
    fulfillerConduit: d.fulfillerConduitKey as Hex,
  };
}
export function publicReader() {
  return createPublicClient({
    chain: mainnet,
    transport: http("https://ethereum-rpc.publicnode.com", {
      timeout: 20000,
      retryCount: 1,
    }),
  });
}
export async function inspect(
  l: InspectedListing,
  f: ReturnType<typeof checkedFulfillment>,
  recipient: Address,
  provider: Address,
  client = publicReader(),
) {
  check((await client.getChainId()) === 1, "Wrong inspection RPC chain");
  check(
    recipient !== provider &&
      recipient !== zeroAddress &&
      recipient !== l.p.offerer,
    "Invalid preview recipient",
  );
  const block = await client.getBlock();
  check(
    block.hash && Math.abs(Date.now() / 1000 - Number(block.timestamp)) < 300,
    "Stale inspection RPC",
  );
  check(
    BigInt(l.p.startTime) <= block.timestamp &&
      BigInt(l.p.endTime) > block.timestamp + 30n,
    "Listing expired at chain block",
  );
  const at = { blockNumber: block.number };
  const [code, info, onchainHash, counter, status] = await Promise.all([
    client.getBytecode({ address: PROTOCOL, ...at }),
    client.readContract({
      address: PROTOCOL,
      abi: seaportAbi,
      functionName: "information",
      ...at,
    }),
    client.readContract({
      address: PROTOCOL,
      abi: seaportAbi,
      functionName: "getOrderHash",
      args: [components(l.p)],
      ...at,
    }),
    client.readContract({
      address: PROTOCOL,
      abi: seaportAbi,
      functionName: "getCounter",
      args: [l.p.offerer],
      ...at,
    }),
    client.readContract({
      address: PROTOCOL,
      abi: seaportAbi,
      functionName: "getOrderStatus",
      args: [l.orderHash],
      ...at,
    }),
  ]);
  check(
    code &&
      keccak256(code) ===
        "0x74499ac0cce14428e4b41541d5e44f28f5a6882a1051d0118867c2a93cd5aec0",
    "Unrecognized Seaport bytecode",
  );
  const domain = {
    name: "Seaport",
    version: "1.6",
    chainId: 1n,
    verifyingContract: PROTOCOL,
  };
  const domainHash = hashDomain({
    domain,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
  check(
    Array.isArray(info) && Array.isArray(status),
    "Invalid protocol response",
  );
  check(
    info[0] === "1.6" && info[1] === domainHash && addr(info[2]) === CONTROLLER,
    "Seaport domain mismatch",
  );
  check(
    onchainHash === l.orderHash &&
      counter === BigInt(l.p.counter) &&
      !status[1] &&
      status[2] === 0n,
    "Order changed, cancelled or filled",
  );
  let signatureValid = false;
  try {
    signatureValid =
      addr(
        await recoverTypedDataAddress({
          domain,
          types: orderTypes,
          primaryType: "OrderComponents",
          message: components(l.p),
          signature: f.signature,
        }),
      ) === l.p.offerer;
  } catch {}
  check(signatureValid || status[0], "Seller signature invalid");
  let operator = PROTOCOL;
  if (l.p.conduitKey !== zeroHash || f.fulfillerConduit !== zeroHash) {
    const [derived, hashes, open, code] = await Promise.all([
      client.readContract({
        address: CONTROLLER,
        abi: conduitAbi,
        functionName: "getConduit",
        args: [CONDUIT_KEY],
        ...at,
      }),
      client.readContract({
        address: CONTROLLER,
        abi: conduitAbi,
        functionName: "getConduitCodeHashes",
        ...at,
      }),
      client.readContract({
        address: CONTROLLER,
        abi: conduitAbi,
        functionName: "getChannelStatus",
        args: [CONDUIT, PROTOCOL],
        ...at,
      }),
      client.getBytecode({ address: CONDUIT, ...at }),
    ]);
    check(
      derived[1] &&
        addr(derived[0]) === CONDUIT &&
        open &&
        code &&
        keccak256(code) === hashes[1],
      "Conduit verification failed",
    );
    if (l.p.conduitKey !== zeroHash) operator = CONDUIT;
  }
  const [owner, approved, all] = await Promise.all([
    client.readContract({
      address: l.nft,
      abi: nftAbi,
      functionName: "ownerOf",
      args: [BigInt(l.tokenId)],
      ...at,
    }),
    client.readContract({
      address: l.nft,
      abi: nftAbi,
      functionName: "getApproved",
      args: [BigInt(l.tokenId)],
      ...at,
    }),
    client.readContract({
      address: l.nft,
      abi: nftAbi,
      functionName: "isApprovedForAll",
      args: [l.p.offerer, operator],
      ...at,
    }),
  ]);
  check(
    addr(owner) === l.p.offerer && (all || addr(approved) === operator),
    "Seller ownership or approval changed",
  );
  // Every consideration recipient is public and bounded. Contract recipients are
  // reported as such; an exact simulation must succeed, no safety claim is made.
  const recipients = await Promise.all(
    l.p.consideration.map(async (c) => ({
      address: c.recipient,
      amount: c.startAmount,
      contract: !!(
        await client.getBytecode({ address: c.recipient, ...at })
      )?.replace(/^0x$/, ""),
    })),
  );
  const call = {
    account: provider,
    to: PROTOCOL,
    data: f.data,
    value: l.total,
    ...at,
    stateOverride: [{ address: provider, balance: l.total + 10n ** 18n }],
  };
  const simulated = await client.call(call);
  check(
    simulated.data === "0x" + "0".repeat(63) + "1",
    "Fulfillment simulation did not return true",
  );
  const gas = await client.estimateGas(call),
    fees = await client.estimateFeesPerGas();
  const gasBudget = ((gas * 120n + 99n) / 100n) * fees.maxFeePerGas;
  check(gas > 0n && gasBudget > 0n, "Invalid gas estimate");
  check(
    (await client.getBlock(at)).hash === block.hash,
    "Inspection block reorganized",
  );
  const expiry = Math.min(
    Math.floor(Date.now() / 1000) + 300,
    Number(l.p.endTime) - 1,
  );
  check(
    expiry > Math.floor(Date.now() / 1000),
    "Preview expired during verification",
  );
  const liquidity = l.total + gasBudget,
    rate = 20000000000000000n;
  return {
    mode: "read-only-mainnet-preview" as const,
    executable: false as const,
    chainId: 1,
    network: "Ethereum mainnet — inspection only",
    protocol: PROTOCOL,
    protocolVersion: "1.6",
    orderHash: l.orderHash,
    recipient,
    provider,
    seller: l.p.offerer,
    nft: l.nft,
    tokenId: l.tokenId,
    sellerWei: l.p.consideration[0].startAmount,
    feesWei: String(l.fees),
    priceWei: String(l.total),
    consideration: recipients,
    gasEstimate: String(gas),
    maxFeePerGas: String(fees.maxFeePerGas),
    gasBudgetWei: String(gasBudget),
    requiredLiquidityWei: String(liquidity),
    simulatedZatoshis: String((liquidity * 100000000n + rate - 1n) / rate),
    simulatedRate:
      "1 TAZ = 0.02 ETH (illustrative only; no exchange or payable quote)",
    expiry,
    observedAt: new Date().toISOString(),
    block: String(block.number),
    blockHash: block.hash,
    sellerAuthorization: signatureValid
      ? "EIP-712 signature verified"
      : "Onchain validated",
    approvalOperator: operator,
    calldataHash: keccak256(f.data),
    attribution: f.suffix,
    simulation:
      "eth_call succeeded with hypothetical provider ETH balance; no broadcast",
    paymentAddress: null,
    executionBlocker:
      "Mainnet settlement is disabled. Existing testnet wrapper cannot execute this listing.",
    trust:
      "Trusted prefunded operator; no atomic bridge. Gas is an estimate; listing state can change. Manual recovery only. No liquidity reserved.",
    privacy:
      "OpenSea and RPC providers observe public addresses and queries. The operator can correlate payments with public NFT delivery. Browsing and NFT ownership are not anonymous.",
  };
}
