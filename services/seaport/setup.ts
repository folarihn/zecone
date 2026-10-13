import {
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { randomBytes } from "node:crypto";
import { toHex } from "viem";
import { readJson } from "../execution/io.ts";
import { client } from "../swaps/adapter.ts";
import {
  PROTOCOL,
  PROTOCOL_CODE,
  seaportAbi,
  orderHash,
  type Listing,
  type SeaportConfig,
} from "./protocol.ts";
export async function infrastructure(
  step: (
    name: string,
    data: Hex,
    to?: Address,
    value?: bigint,
  ) => Promise<TransactionReceipt>,
  provider: Address,
  user: Address,
  seller: Address,
  p = client(),
) {
  if ((await p.getChainId()) !== 84532) throw Error("wrong_chain");
  const code = await p.getBytecode({ address: PROTOCOL });
  if (!code || keccak256(code) !== PROTOCOL_CODE)
    throw Error("official_seaport_unavailable");
  const artifact = (name: string) =>
      readJson<{ abi: any; bytecode: { object: Hex } }>(
        `out/${name}.sol/${name}.json`,
      ),
    nftArt = artifact("MarketTestNFT"),
    nft = (
      await step(
        "collection",
        encodeDeployData({
          abi: nftArt.abi,
          bytecode: nftArt.bytecode.object,
          args: [seller],
        }),
      )
    ).contractAddress!;
  const a = artifact("ZecOneSeaportExecutor"),
    executor = (
      await step(
        "executor",
        encodeDeployData({
          abi: a.abi,
          bytecode: a.bytecode.object,
          args: [provider, nft, seller, provider],
        }),
      )
    ).contractAddress!;
  const codeHashes = {} as Record<Address, Hex>;
  for (const address of [PROTOCOL, nft, executor]) {
    const b = await p.getBytecode({ address });
    if (!b) throw Error("missing_code");
    codeHashes[address] = keccak256(b);
  }
  return {
    chainId: 84532,
    protocol: PROTOCOL,
    protocolVersion: "1.6",
    executor,
    nft,
    seller,
    feeRecipient: provider,
    provider,
    user,
    codeHashes,
  } satisfies SeaportConfig;
}
export async function unsignedListing(
  c: SeaportConfig,
  p = client(),
  tokenId = "1",
): Promise<Listing> {
  const at = Number((await p.getBlock()).timestamp),
    counter = await p.readContract({
      address: PROTOCOL,
      abi: seaportAbi,
      functionName: "getCounter",
      args: [c.seller],
    });
  const l: Listing = {
    source: "controlled-seaport",
    chainId: 84532,
    protocol: PROTOCOL,
    protocolVersion: "1.6",
    orderHash: zeroHash,
    signature: "0x",
    parameters: {
      offerer: c.seller,
      zone: zeroAddress,
      offer: [
        {
          itemType: 2,
          token: c.nft,
          identifierOrCriteria: tokenId,
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: "100000000000000",
          endAmount: "100000000000000",
          recipient: c.seller,
        },
        {
          itemType: 0,
          token: zeroAddress,
          identifierOrCriteria: "0",
          startAmount: "2500000000000",
          endAmount: "2500000000000",
          recipient: c.feeRecipient,
        },
      ],
      orderType: 0,
      startTime: String(at - 60),
      endTime: String(at + 86400),
      zoneHash: zeroHash,
      salt: BigInt(toHex(randomBytes(32))).toString(),
      conduitKey: zeroHash,
      counter: String(counter),
    },
  };
  l.orderHash = orderHash(l);
  return l;
}
