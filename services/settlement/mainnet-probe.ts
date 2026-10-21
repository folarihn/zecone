// Closed read-only RPC surface. This file has no signing or submission method.
import { createHash } from "node:crypto";
import { getAddress } from "viem";
import {
  address,
  blockhash,
  pipe,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  independentProviders,
  type ProductionProfile,
  type Provider,
} from "./production-safety.ts";
export type Check = {
  status: "PASS" | "FAIL" | "BLOCKED";
  reason?: string;
  evidence?: unknown;
};
const methods = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_blockNumber",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "getTransaction",
  "getSignatureStatuses",
  "getGenesisHash",
  "getSlot",
  "getBlock",
  "getBalance",
  "getLatestBlockhash",
  "getBlockHeight",
  "isBlockhashValid",
  "getAccountInfo",
  "simulateTransaction",
  "getFeeForMessage",
  "getblockchaininfo",
  "getblockhash",
]);
export async function readProductionRpc(
  provider: Provider,
  method: string,
  params: unknown[],
  fetcher: typeof fetch = fetch,
) {
  if (!methods.has(method)) throw Error("READ_METHOD_FORBIDDEN");
  const u = new URL(provider.endpoint);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    !provider.operator.trim()
  )
    throw Error("INVALID_PROVIDER");
  const response = await fetcher(u, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error("READ_PROVIDER_UNAVAILABLE");
  // Bound read bodies as well as headers; never print raw RPC errors/URLs.
  const reader = response.body?.getReader();
  if (!reader) throw Error("INVALID_RPC_RESPONSE");
  let body = "",
    size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) throw Error("RPC_RESPONSE_TOO_LARGE");
      body += new TextDecoder().decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  const data = JSON.parse(body);
  if (data.id !== 1 || data.error || !("result" in data))
    throw Error("INVALID_RPC_RESPONSE");
  return data.result as any;
}
const hex = (n: bigint) => `0x${n.toString(16)}`;
const asInt = (v: unknown) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw Error("INVALID_RPC_INTEGER");
  return v;
};
export async function probeMainnet(
  profile: ProductionProfile,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1000),
) {
  const checks: Record<string, Check> = {};
  let independent = false;
  try {
    independentProviders(profile);
    independent = true;
    checks.providerConfiguration = { status: "PASS" };
  } catch {
    checks.providerConfiguration = {
      status: "BLOCKED",
      reason: "TWO_ACKNOWLEDGED_INDEPENDENT_OPERATORS_REQUIRED",
    };
  }
  checks.shieldedObservation = {
    status: "BLOCKED",
    reason:
      "FULL_TRANSACTION_UFVK_DECRYPTION_IMPLEMENTED_BUT_NO_AUTHENTICATED_MAINNET_SCAN_CONFIGURED",
  };
  checks.pricing = {
    status: "BLOCKED",
    reason: "SIGNED_PRODUCTION_PRICE_FEEDS_NOT_CONFIGURED",
  };
  checks.signerIsolation = {
    status: "BLOCKED",
    reason: "CONFIGURATION_IS_NOT_INDEPENDENT_DEVICE_VALIDATION",
  };
  checks.reservationDeployment = {
    status: "BLOCKED",
    reason: "SINGLE_WRITER_SHARED_LOCAL_DATABASE_DEPLOYMENT_NOT_VALIDATED",
  };
  const providers = profile.providers.slice(0, 2),
    identity: any[] = [],
    states: any[] = [];
  if (!providers.length) {
    checks.identity = {
      status: "BLOCKED",
      reason: "NO_MAINNET_PROVIDER_CONFIGURED",
    };
    checks.finalizedState = {
      status: "BLOCKED",
      reason: "NO_MAINNET_PROVIDER_CONFIGURED",
    };
    checks.independentAgreement = {
      status: "BLOCKED",
      reason: "NO_MAINNET_PROVIDER_CONFIGURED",
    };
    return {
      network: profile.network,
      enabled: profile.enabled,
      spendingEnabled: false,
      productionReady: false,
      confidence: "UNAVAILABLE",
      checks,
    };
  }
  const rpc = (p: Provider, m: string, args: unknown[] = []) =>
    readProductionRpc(p, m, args, fetcher);
  const expected =
    profile.network === "base"
      ? "0x2105"
      : "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  try {
    if (!providers.length) throw Error("NO_PROVIDER");
    for (const p of providers) {
      if (profile.network === "zcash") {
        const info = await rpc(p, "getblockchaininfo");
        if (
          info.chain !== "main" ||
          info.initialblockdownload !== false ||
          asInt(info.blocks) < 20
        )
          throw Error("WRONG_OR_STALE_NETWORK");
        identity.push("main");
        states.push(info.blocks - 20);
      } else {
        const id = await rpc(
          p,
          profile.network === "base" ? "eth_chainId" : "getGenesisHash",
        );
        if (id !== expected) throw Error("WRONG_NETWORK");
        identity.push(id);
        const head =
          profile.network === "base"
            ? await rpc(p, "eth_getBlockByNumber", ["finalized", false])
            : await rpc(p, "getSlot", [{ commitment: "finalized" }]);
        if (profile.network === "base") {
          if (
            !head?.hash ||
            now - Number(BigInt(head.timestamp)) > 1800 ||
            Number(BigInt(head.timestamp)) > now + 30
          )
            throw Error("STALE_FINALIZED_HEAD");
          states.push(Number(BigInt(head.number)));
        } else states.push(asInt(head));
      }
    }
    checks.identity = {
      status: "PASS",
      evidence: { providersVerified: identity.length, expected },
    };
    const common = Math.min(...states),
      anchors: any[] = [];
    for (const p of providers) {
      const anchor =
        profile.network === "base"
          ? await rpc(p, "eth_getBlockByNumber", [hex(BigInt(common)), false])
          : profile.network === "solana"
            ? await rpc(p, "getBlock", [
                common,
                {
                  commitment: "finalized",
                  transactionDetails: "none",
                  rewards: false,
                  maxSupportedTransactionVersion: 0,
                },
              ])
            : await rpc(p, "getblockhash", [common]);
      const value =
        profile.network === "zcash"
          ? anchor
          : profile.network === "base"
            ? anchor?.hash
            : anchor?.blockhash;
      if (typeof value !== "string" || !value || /^0x0+$/.test(value))
        throw Error("ANCHOR_UNAVAILABLE");
      if (
        profile.network === "solana" &&
        (!Number.isSafeInteger(anchor?.blockTime) ||
          now - anchor.blockTime > 300 ||
          anchor.blockTime > now + 30)
      )
        throw Error("STALE_FINALIZED_HEAD");
      anchors.push(value);
    }
    if (anchors.some((a) => a !== anchors[0]))
      throw Error("PROVIDER_DISAGREEMENT");
    checks.finalizedState = {
      status: "PASS",
      evidence: {
        height: common,
        providersVerified: anchors.length,
        anchorDigest: createHash("sha256").update(anchors[0]).digest("hex"),
      },
    };
    checks.independentAgreement = independent
      ? { status: "PASS" }
      : { status: "BLOCKED", reason: "PRIMARY_ONLY_NOT_PRODUCTION_VERIFIED" };
    if (profile.network !== "zcash") {
      if (!profile.relayer || profile.recipients.length !== 1) {
        checks.liquidity = {
          status: "BLOCKED",
          reason:
            "DEDICATED_MAINNET_RELAYER_AND_EXACT_RECIPIENT_NOT_CONFIGURED",
        };
        checks.simulation = {
          status: "BLOCKED",
          reason: "EXACT_MAINNET_DESTINATION_NOT_CONFIGURED",
        };
      } else {
        const recipient = profile.recipients[0],
          amount = BigInt(profile.perTransaction) - BigInt(profile.feeCap);
        if (amount <= 0n) throw Error("FINANCIAL_LIMIT");
        const balances: bigint[] = [];
        for (const p of providers) {
          if (profile.network === "base") {
            const owner = getAddress(profile.relayer),
              to = getAddress(recipient);
            if (owner === to) throw Error("SELF_TRANSFER");
            if (
              (await rpc(p, "eth_getCode", [to, hex(BigInt(common))])) !== "0x"
            )
              throw Error("EOA_REQUIRED");
            const b = BigInt(
              await rpc(p, "eth_getBalance", [owner, hex(BigInt(common))]),
            );
            balances.push(b);
          } else {
            address(profile.relayer);
            address(recipient);
            if (profile.relayer === recipient) throw Error("SELF_TRANSFER");
            const b = await rpc(p, "getBalance", [
              profile.relayer,
              { commitment: "finalized", minContextSlot: common },
            ]);
            if (asInt(b.context?.slot) < common)
              throw Error("STALE_ACCOUNT_STATE");
            balances.push(BigInt(asInt(b.value)));
          }
        }
        if (balances.some((b) => b !== balances[0]))
          throw Error("PROVIDER_DISAGREEMENT");
        checks.liquidity = {
          status:
            balances[0] >= BigInt(profile.perTransaction) ? "PASS" : "FAIL",
          evidence: {
            required: profile.perTransaction,
            sufficient: balances[0] >= BigInt(profile.perTransaction),
          },
        };
        if (profile.network === "base") {
          const call = {
              from: profile.relayer,
              to: recipient,
              value: hex(amount),
              data: "0x",
            },
            gas: bigint[] = [];
          for (const p of providers) {
            await rpc(p, "eth_call", [call, hex(BigInt(common))]);
            gas.push(
              BigInt(
                await rpc(p, "eth_estimateGas", [call, hex(BigInt(common))]),
              ),
            );
          }
          checks.simulation = {
            status: "PASS",
            evidence: {
              unsigned: true,
              gas: gas.map(String),
              amount: amount.toString(),
              stateHeight: common,
            },
          };
          checks.totalFeeCap = {
            status: "BLOCKED",
            reason:
              "BASE_L1_DATA_AND_OPERATOR_FEES_REQUIRE_SIGNER_POLICY_AND_FRESH_BOUND",
          };
        } else {
          for (const p of providers)
            for (const key of [profile.relayer, recipient]) {
              const a = await rpc(p, "getAccountInfo", [
                key,
                {
                  encoding: "base64",
                  commitment: "finalized",
                  minContextSlot: common,
                },
              ]);
              if (
                a.value &&
                (a.value.executable ||
                  a.value.owner !== "11111111111111111111111111111111")
              )
                throw Error("SYSTEM_ACCOUNT_REQUIRED");
            }
          const life = await rpc(providers[0], "getLatestBlockhash", [
            { commitment: "finalized" },
          ]);
          const signer = createNoopSigner(address(profile.relayer)),
            tx = compileTransaction(
              pipe(
                createTransactionMessage({ version: "legacy" }),
                (m) => setTransactionMessageFeePayer(signer.address, m),
                (m) =>
                  setTransactionMessageLifetimeUsingBlockhash(
                    {
                      blockhash: blockhash(life.value.blockhash),
                      lastValidBlockHeight: BigInt(
                        asInt(life.value.lastValidBlockHeight),
                      ),
                    },
                    m,
                  ),
                (m) =>
                  appendTransactionMessageInstructions(
                    [
                      getTransferSolInstruction({
                        source: signer,
                        destination: address(recipient),
                        amount,
                      }),
                    ],
                    m,
                  ),
              ),
            );
          const wire = getBase64EncodedWireTransaction(tx),
            fees: bigint[] = [];
          for (const p of providers) {
            if (
              (
                await rpc(p, "isBlockhashValid", [
                  life.value.blockhash,
                  { commitment: "finalized" },
                ])
              ).value !== true
            )
              throw Error("BLOCKHASH_UNAVAILABLE");
            const sim = await rpc(p, "simulateTransaction", [
              wire,
              {
                encoding: "base64",
                sigVerify: false,
                replaceRecentBlockhash: false,
                commitment: "finalized",
                minContextSlot: common,
              },
            ]);
            if (!sim?.value || sim.value.err) throw Error("SIMULATION_FAILED");
            const fee = await rpc(p, "getFeeForMessage", [
              Buffer.from(tx.messageBytes).toString("base64"),
              { commitment: "finalized" },
            ]);
            fees.push(BigInt(asInt(fee.value)));
          }
          if (fees.some((f) => f !== fees[0] || f > BigInt(profile.feeCap)))
            throw Error("FEE_CAP_OR_DISAGREEMENT");
          checks.simulation = {
            status: "PASS",
            evidence: {
              unsigned: true,
              digest: createHash("sha256")
                .update(Buffer.from(wire, "base64"))
                .digest("hex"),
              fee: fees[0].toString(),
              amount: amount.toString(),
              lastValidBlockHeight: life.value.lastValidBlockHeight,
              approvalGranted: false,
            },
          };
        }
      }
    }
  } catch (e) {
    checks.rpcValidation = {
      status: "FAIL",
      reason:
        e instanceof Error &&
        [
          "PROVIDER_DISAGREEMENT",
          "WRONG_NETWORK",
          "WRONG_OR_STALE_NETWORK",
          "STALE_FINALIZED_HEAD",
          "SIMULATION_FAILED",
          "FEE_CAP_OR_DISAGREEMENT",
          "EOA_REQUIRED",
          "SYSTEM_ACCOUNT_REQUIRED",
          "SELF_TRANSFER",
        ].includes(e.message)
          ? e.message
          : "PUBLIC_READ_UNAVAILABLE_OR_INVALID_CONFIGURATION",
    };
  }
  const confidence = checks.rpcValidation
    ? "DEGRADED"
    : independent && checks.independentAgreement?.status === "PASS"
      ? "CORROBORATED_READ_SCOPE"
      : identity.length
        ? "PRIMARY_ONLY"
        : "UNAVAILABLE";
  return {
    network: profile.network,
    enabled: profile.enabled,
    spendingEnabled: false,
    productionReady: false,
    confidence,
    checks,
  };
}
