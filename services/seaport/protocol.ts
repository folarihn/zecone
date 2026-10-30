import {
  encodeFunctionData,
  encodeAbiParameters,
  parseAbi,
  hashStruct,
  hashTypedData,
  recoverTypedDataAddress,
  getAddress,
  keccak256,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { fields, SOURCE, BUDGET, zecCost } from "../swaps/intent.ts";
export { SOURCE, BUDGET, zecCost };
export const CHAIN = 84532,
  PROTOCOL = "0x0000000000000068F116a894984e2DB1123eB395" as Address;
export const PROTOCOL_CODE =
  "0x7912af42062ec0080cde88360c1429d58984ae16eb3f17af505b815bf6ffc745" as Hex;
export const ADAPTER = keccak256(toHex("seaport-1.6-full-open-v1")),
  ACTION = keccak256(toHex("SEAPORT_PURCHASE"));
// Matches the official pinned seaport-types 1.6.3 structs and SeaportInterface.
const offerTuple =
    "(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)",
  considerationTuple =
    "(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)";
const orderStart = `address offerer,address zone,${offerTuple}[] offer,${considerationTuple}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey`;
export const componentsTuple = `(${orderStart},uint256 counter)`,
  parametersTuple = `(${orderStart},uint256 totalOriginalConsiderationItems)`,
  advancedTuple = `(${parametersTuple} parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)`;
const criteriaTuple =
  "(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)";
export const seaportAbi = parseAbi([
  `function fulfillAdvancedOrder(${advancedTuple} advancedOrder,${criteriaTuple}[] criteriaResolvers,bytes32 fulfillerConduitKey,address recipient) payable returns(bool)`,
  `function getOrderHash(${componentsTuple} order) view returns(bytes32)`,
  "function getCounter(address) view returns(uint256)",
  "function getOrderStatus(bytes32) view returns(bool isValidated,bool isCancelled,uint256 totalFilled,uint256 totalSize)",
  "function information() view returns(string version,bytes32 domainSeparator,address conduitController)",
  `function validate((${parametersTuple} parameters,bytes signature)[] orders) returns(bool)`,
  `function cancel(${componentsTuple}[] orders) returns(bool)`,
  "function incrementCounter() returns(uint256)",
  "event OrderFulfilled(bytes32 orderHash,address indexed offerer,address indexed zone,address recipient,(uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer,(uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)",
]);
const intentTuple = `(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
export const executorAbi = parseAbi([
  `function execute(${intentTuple} i,${advancedTuple} a,uint256 counter,bytes signature) payable`,
  `function intentId(${intentTuple} i) view returns(bytes32)`,
  "function consumed(bytes32) view returns(bool)",
  "function relayer() view returns(address)",
  "function nft() view returns(address)",
  "function seller() view returns(address)",
  "function feeRecipient() view returns(address)",
  "error Replay()",
  "error InvalidIntent()",
  "error InvalidListing()",
  "error DeliveryMismatch()",
  "event SeaportPurchased(bytes32 indexed digest,bytes32 indexed seaportOrderHash,address indexed recipient,address nft,uint256 tokenId,address seller,uint256 sellerAmount,address feeRecipient,uint256 feeAmount)",
]);
export const orderTypes = {
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
} as const;
export type Item = {
  itemType: number;
  token: Address;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
};
export type Components = {
  offerer: Address;
  zone: Address;
  offer: Item[];
  consideration: (Item & { recipient: Address })[];
  orderType: number;
  startTime: string;
  endTime: string;
  zoneHash: Hex;
  salt: string;
  conduitKey: Hex;
  counter: string;
};
export type Listing = {
  source: "controlled-seaport" | "opensea-api";
  chainId: 84532;
  protocol: Address;
  protocolVersion: "1.6";
  orderHash: Hex;
  parameters: Components;
  signature: Hex;
};
export type SeaportConfig = {
  chainId: 84532;
  protocol: Address;
  protocolVersion: "1.6";
  executor: Address;
  nft: Address;
  seller: Address;
  feeRecipient: Address;
  provider: Address;
  user: Address;
  codeHashes: Record<Address, Hex>;
};
export type SeaportIntent = {
  kind: "seaport";
  version: 1;
  chainId: 84532;
  contract: Address;
  orderId: Hex;
  nonce: Hex;
  sourceNetwork: Hex;
  adapter: Hex;
  provider: Address;
  recipient: Address;
  price: string;
  gasBudget: string;
  zatoshis: string;
  expiry: number;
  refundHash: Hex;
  listing: Listing;
  nft: Address;
  tokenId: string;
  seller: Address;
  feeRecipient: Address;
  feeAmount: string;
  signature: Hex;
};
export type UnsignedSeaport = Omit<SeaportIntent, "signature">;
export const eq = (a: string, b: string) => getAddress(a) === getAddress(b);
export function uint(v: unknown): bigint {
  if (
    typeof v !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(v) ||
    BigInt(v) > 2n ** 256n - 1n
  )
    throw Error("invalid_seaport_integer");
  return BigInt(v);
}
export function components(p: Components) {
  const item = (x: Item) => ({
    ...x,
    identifierOrCriteria: uint(x.identifierOrCriteria),
    startAmount: uint(x.startAmount),
    endAmount: uint(x.endAmount),
  });
  return {
    ...p,
    offer: p.offer.map(item),
    consideration: p.consideration.map((x) => ({
      ...item(x),
      recipient: x.recipient,
    })),
    startTime: uint(p.startTime),
    endTime: uint(p.endTime),
    salt: uint(p.salt),
    counter: uint(p.counter),
  };
}
export function orderTyped(l: Listing) {
  return {
    domain: {
      name: "Seaport",
      version: "1.6",
      chainId: CHAIN,
      verifyingContract: PROTOCOL,
    },
    types: orderTypes,
    primaryType: "OrderComponents" as const,
    message: components(l.parameters),
  };
}
export function orderHash(l: Listing) {
  return hashStruct({
    types: orderTypes,
    primaryType: "OrderComponents",
    data: components(l.parameters),
  });
}
export function advanced(l: Listing) {
  const { counter, ...p } = components(l.parameters);
  return {
    parameters: {
      ...p,
      totalOriginalConsiderationItems: BigInt(p.consideration.length),
    },
    numerator: 1n,
    denominator: 1n,
    signature: l.signature,
    extraData: "0x" as Hex,
  };
}
export function fulfillment(l: Listing, recipient: Address) {
  return encodeFunctionData({
    abi: seaportAbi,
    functionName: "fulfillAdvancedOrder",
    args: [advanced(l), [], zeroHash, recipient],
  });
}
export function listingTerms(
  l: Listing,
  c: Pick<SeaportConfig, "nft" | "seller" | "feeRecipient">,
  at: number,
) {
  if (
    l.chainId !== CHAIN ||
    !eq(l.protocol, PROTOCOL) ||
    l.protocolVersion !== "1.6" ||
    !["controlled-seaport", "opensea-api"].includes(l.source)
  )
    throw Error("invalid_protocol");
  const p = l.parameters;
  components(p);
  if (
    p.orderType !== 0 ||
    !eq(p.offerer, c.seller) ||
    eq(c.seller, zeroAddress) ||
    !eq(p.zone, zeroAddress) ||
    p.zoneHash !== zeroHash ||
    p.conduitKey !== zeroHash ||
    p.offer.length !== 1 ||
    p.consideration.length < 1 ||
    p.consideration.length > 2
  )
    throw Error("unsupported_seaport_order");
  if (uint(p.startTime) > BigInt(at) || uint(p.endTime) <= BigInt(at))
    throw Error("listing_expired");
  const o = p.offer[0];
  if (
    o.itemType !== 2 ||
    !eq(o.token, c.nft) ||
    eq(c.nft, zeroAddress) ||
    o.startAmount !== "1" ||
    o.endAmount !== "1"
  )
    throw Error("unsupported_seaport_nft");
  let total = 0n;
  for (const [n, x] of p.consideration.entries()) {
    if (
      x.itemType !== 0 ||
      !eq(x.token, zeroAddress) ||
      x.identifierOrCriteria !== "0" ||
      uint(x.startAmount) === 0n ||
      x.startAmount !== x.endAmount ||
      !eq(x.recipient, n === 0 ? c.seller : c.feeRecipient) ||
      eq(x.recipient, zeroAddress)
    )
      throw Error("invalid_consideration");
    total += uint(x.startAmount);
  }
  const fee = p.consideration[1]?.startAmount ?? "0";
  if (
    uint(fee) > uint(p.consideration[0].startAmount) / 20n ||
    total > 200000000000000n
  )
    throw Error("excessive_seaport_expenditure");
  if (orderHash(l) !== l.orderHash) throw Error("seaport_order_hash_mismatch");
  if (!/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})?$/.test(l.signature))
    throw Error("invalid_seller_signature");
  return {
    total,
    fee,
    sellerAmount: p.consideration[0].startAmount,
    tokenId: o.identifierOrCriteria,
  };
}
export function typed(i: UnsignedSeaport) {
  return {
    domain: {
      name: "ZecOneSeaport",
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
      target: i.listing.protocol,
      maxNative: uint(i.price),
      maxGas: uint(i.gasBudget),
      zatoshis: uint(i.zatoshis),
      expiry: BigInt(i.expiry),
      paramsHash: keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "address" },
            { type: "uint256" },
            { type: "address" },
            { type: "bytes32" },
            { type: "uint256" },
            { type: "address" },
            { type: "uint256" },
          ],
          [
            i.listing.orderHash,
            i.nft,
            uint(i.tokenId),
            i.seller,
            keccak256(toHex("1.6")),
            uint(i.listing.parameters.counter),
            i.feeRecipient,
            uint(i.feeAmount),
          ],
        ),
      ),
      calldataHash: keccak256(fulfillment(i.listing, i.recipient)),
      refundHash: i.refundHash,
    },
  };
}
export function terms(i: UnsignedSeaport, c: SeaportConfig, at: number) {
  const l = listingTerms(i.listing, c, at);
  if (
    i.kind !== "seaport" ||
    i.version !== 1 ||
    i.chainId !== CHAIN ||
    c.chainId !== CHAIN ||
    !eq(c.protocol, PROTOCOL) ||
    c.protocolVersion !== "1.6" ||
    !eq(i.contract, c.executor) ||
    !eq(i.provider, c.provider) ||
    !eq(i.recipient, c.user) ||
    eq(c.user, c.provider) ||
    eq(c.user, c.seller) ||
    eq(c.user, zeroAddress) ||
    !eq(i.nft, c.nft) ||
    !eq(i.seller, c.seller) ||
    !eq(i.feeRecipient, c.feeRecipient) ||
    i.sourceNetwork !== SOURCE ||
    i.adapter !== ADAPTER ||
    i.tokenId !== l.tokenId ||
    i.price !== l.total.toString() ||
    i.feeAmount !== l.fee ||
    i.gasBudget !== BUDGET.toString() ||
    i.zatoshis !== zecCost(l.total).toString() ||
    !Number.isSafeInteger(i.expiry) ||
    i.expiry <= at ||
    i.expiry > at + 3600 ||
    BigInt(i.expiry) >= uint(i.listing.parameters.endTime)
  )
    throw Error("invalid_seaport_intent");
  for (const h of [i.orderId, i.nonce, i.refundHash])
    if (!/^0x[0-9a-f]{64}$/.test(h) || h === zeroHash)
      throw Error("invalid_seaport_hash");
  return hashTypedData(typed(i));
}
export async function signature(
  i: SeaportIntent,
  c: SeaportConfig,
  at: number,
) {
  const digest = terms(i, c, at);
  if (
    !eq(
      await recoverTypedDataAddress({ ...typed(i), signature: i.signature }),
      i.recipient,
    )
  )
    throw Error("invalid_user_signature");
  return digest;
}
