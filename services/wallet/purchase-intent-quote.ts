// Read-only quote adapter. Never instantiate PurchaseBase/Purchases or a wallet.
import {
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  interpret,
  priceZatoshis,
  RATE,
  MAX_GAS,
  MAX_FEE,
  executorAbi,
  type MarketConfig,
} from "../marketplace/purchase.ts";
import { network } from "../evm/networks.ts";
import {
  evmIntent,
  fingerprint,
  type EvmRoute,
  type Scope,
  type Intent,
} from "./transaction-intents.ts";
export type PurchaseQuoteConfig = {
  market: MarketConfig & { chainId: 84532 };
  relayer: Address;
  codeHashes: { marketplace: Hex; executor: Hex; nft: Hex };
  route: EvmRoute;
};
export type QuoteReads = Pick<
  PublicClient,
  | "getChainId"
  | "getBlock"
  | "getBytecode"
  | "readContract"
  | "call"
  | "estimateGas"
  | "estimateFeesPerGas"
  | "getBalance"
>;
export type QuoteTerms = {
  version: 1;
  network: "eip155:84532";
  operation: "nft-purchase";
  marketplace: Address;
  executor: Address;
  recipient: Address;
  nft: Address;
  listingId: string;
  tokenId: string;
  seller: Address;
  priceWei: string;
  zatoshis: string;
  gasBudgetWei: string;
  rate: string;
  slippageBps: 0;
  estimatedGas: string;
  estimatedFeeWei: string;
  calldataHash: Hex;
  listingExpiry: number;
};
export type AdapterQuote = {
  terms: QuoteTerms;
  observedAt: number;
  expires: number;
  destinationExpiry: number;
  block: string;
  blockHash: Hex;
  requestDigest: string;
  configDigest: string;
  evidence: "two-configured-read-clients-agree";
};
const eq = (a: string, b: string) => getAddress(a) === getAddress(b);
export class PurchaseIntentQuote {
  readonly config: PurchaseQuoteConfig;
  constructor(
    config: PurchaseQuoteConfig,
    private readonly primary: QuoteReads,
    private readonly secondary: QuoteReads,
    readonly now = Date.now,
  ) {
    if (primary === secondary) throw Error("DISTINCT_READ_CLIENTS_REQUIRED");
    const c = structuredClone(config),
      r = c.route;
    if (
      c.market.chainId !== 84532 ||
      r.chainId !== 84532 ||
      r.operation !== "nft-purchase" ||
      !eq(r.target, c.market.marketplace) ||
      r.codeHash !== c.codeHashes.marketplace ||
      (c.market.provider !== undefined && !eq(c.market.provider, c.relayer)) ||
      r.feeCap !== network(84532).gasBudget.toString()
    )
      throw Error("INVALID_PURCHASE_MAPPING");
    for (const key of ["marketplace", "executor", "nft"] as const) {
      if (
        !/^0x[0-9a-f]{64}$/.test(c.codeHashes[key]) ||
        BigInt(c.codeHashes[key]) === 0n
      )
        throw Error("CODE_HASH_REQUIRED");
      getAddress(c.market[key]);
    }
    getAddress(c.relayer);
    Object.freeze(c.market);
    Object.freeze(c.route);
    Object.freeze(c.codeHashes);
    this.config = Object.freeze(c);
  }
  async quote(
    scope: Scope,
    intent: Intent,
    params: unknown[],
  ): Promise<AdapterQuote> {
    const started = this.now(),
      c = this.config;
    const canonical = evmIntent(scope, intent.id, params, [c.route], started);
    if (
      scope.origin !== c.market.origin ||
      canonical.operation !== "nft-purchase" ||
      intent.operation !== canonical.operation ||
      intent.destination.chainId !== canonical.destination.chainId ||
      !eq(intent.target, canonical.target) ||
      fingerprint(intent.input) !== fingerprint(canonical.input) ||
      !canonical.support.recognized ||
      intent.approval !== "consented-preview-only" ||
      canonical.requestDigest !== intent.requestDigest ||
      !eq(intent.recipient!, scope.account) ||
      eq(scope.account, c.relayer) ||
      intent.expires <= started
    )
      throw Error("UNSUPPORTED_OR_UNAPPROVED_INTENT");
    if (
      (await this.primary.getChainId()) !== 84532 ||
      (await this.secondary.getChainId()) !== 84532
    )
      throw Error("WRONG_NETWORK");
    const head = await this.primary.getBlock();
    if (
      head.number === null ||
      head.number <= 0n ||
      !head.hash ||
      !/^0x[0-9a-fA-F]{64}$/.test(head.hash) ||
      Math.abs(Number(head.timestamp) * 1000 - started) > 60000
    )
      throw Error("STALE_QUOTE_BLOCK");
    const inspect = async (client: QuoteReads) => {
      if ((await client.getChainId()) !== 84532) throw Error("WRONG_NETWORK");
      const block = await client.getBlock({ blockNumber: head.number! });
      if (
        block.hash !== head.hash ||
        block.number !== head.number ||
        block.timestamp !== head.timestamp
      )
        throw Error("PROVIDER_DISAGREEMENT");
      for (const key of ["marketplace", "executor", "nft"] as const) {
        const code = await client.getBytecode({
          address: c.market[key],
          blockNumber: head.number!,
        });
        if (!code || keccak256(code) !== c.codeHashes[key])
          throw Error("CONTRACT_CODE_CHANGED");
      }
      const [relayer, market] = await Promise.all([
        client.readContract({
          address: c.market.executor,
          abi: executorAbi,
          functionName: "relayer",
          blockNumber: head.number!,
        }),
        client.readContract({
          address: c.market.executor,
          abi: executorAbi,
          functionName: "marketplace",
          blockNumber: head.number!,
        }),
      ]);
      if (
        !eq(String(relayer), c.relayer) ||
        !eq(String(market), c.market.marketplace)
      )
        throw Error("EXECUTOR_CONFIG_CHANGED");
      // Existing adapter reads and simulation are pinned to one canonical block.
      const pinned = {
        getChainId: () => client.getChainId(),
        getBlock: async () => block,
        readContract: (args: any) =>
          client.readContract({ ...args, blockNumber: head.number! }),
        call: (args: any) =>
          client.call({ ...args, blockNumber: head.number! }),
        estimateGas: (args: any) =>
          client.estimateGas({ ...args, blockNumber: head.number! }),
      };
      const listing = await interpret(
        pinned as any,
        c.market,
        structuredClone(params[0]) as Record<string, unknown>,
        scope.account,
        c.relayer,
      );
      const fees = await client.estimateFeesPerGas();
      const gas = (BigInt(listing.estimatedGas) * 12n) / 10n + 1n;
      const fee = gas * fees.maxFeePerGas + network(84532).dataReserve;
      if (
        gas > MAX_GAS ||
        fees.maxFeePerGas <= 0n ||
        fees.maxPriorityFeePerGas < 0n ||
        fees.maxPriorityFeePerGas > fees.maxFeePerGas ||
        fees.maxFeePerGas > MAX_FEE ||
        fee > BigInt(c.route.feeCap) ||
        fee > network(84532).gasBudget
      )
        throw Error("FEE_CAP");
      if (
        (await client.getBalance({
          address: c.relayer,
          blockNumber: head.number!,
        })) <
        BigInt(listing.price) + network(84532).gasBudget
      )
        throw Error("RELAYER_INVENTORY");
      if (
        (await client.getBlock({ blockNumber: head.number! })).hash !==
          head.hash ||
        (await client.getChainId()) !== 84532
      )
        throw Error("QUOTE_REORG_OR_NETWORK_CHANGE");
      return {
        version: 1,
        network: "eip155:84532",
        operation: "nft-purchase",
        marketplace: c.market.marketplace,
        executor: c.market.executor,
        recipient: scope.account,
        nft: listing.nft,
        listingId: listing.listingId,
        tokenId: listing.tokenId,
        seller: listing.seller,
        priceWei: listing.price,
        zatoshis: priceZatoshis(BigInt(listing.price), 84532).toString(),
        gasBudgetWei: network(84532).gasBudget.toString(),
        rate: RATE.toString(),
        slippageBps: 0,
        estimatedGas: listing.estimatedGas,
        estimatedFeeWei: fee.toString(),
        calldataHash: listing.calldataHash,
        listingExpiry: listing.listingExpiry,
      } satisfies QuoteTerms;
    };
    const first = await inspect(this.primary),
      second = await inspect(this.secondary);
    if (fingerprint(first) !== fingerprint(second))
      throw Error("PROVIDER_DISAGREEMENT");
    for (const client of [this.primary, this.secondary])
      if (
        (await client.getBlock({ blockNumber: head.number })).hash !==
          head.hash ||
        (await client.getChainId()) !== 84532
      )
        throw Error("QUOTE_REORG_OR_NETWORK_CHANGE");
    const destinationExpiry = Math.min(
      Math.floor(started / 1000) + 3600,
      first.listingExpiry - 60,
    );
    if (destinationExpiry < Math.floor(this.now() / 1000) + 1800)
      throw Error("LISTING_EXPIRES_TOO_SOON");
    const expires = Math.min(started + 120000, intent.expires, scope.expires);
    if (this.now() >= expires || this.now() - started > 30000)
      throw Error("QUOTE_EXPIRED_OR_SLOW");
    return {
      terms: first,
      observedAt: started,
      expires,
      destinationExpiry,
      block: head.number.toString(),
      blockHash: head.hash,
      requestDigest: intent.requestDigest,
      configDigest: fingerprint(c),
      evidence: "two-configured-read-clients-agree",
    };
  }
}
