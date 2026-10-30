import {
  address,
  createSolanaRpc,
  signature,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  rpcCategory,
  rpcEndpoint,
  type RpcDiagnostic,
} from "./rpc-reliability.ts";
export const DEVNET = "https://api.devnet.solana.com";
export const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export class SolanaError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function publicKey(value: string) {
  try {
    return address(value);
  } catch {
    throw new SolanaError("INVALID_PUBLIC_KEY");
  }
}
export const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
export class Devnet {
  private last = 0;
  private active = false;
  private selected = 0;
  private readonly providers: ReturnType<typeof createSolanaRpc>[];
  private readonly checked = new Map<number, number>();
  readonly diagnostics: RpcDiagnostic[] = [];
  private minimumSlot = 0n;
  private readonly providerContext = new AsyncLocalStorage<number>();
  constructor(
    rpc = createSolanaRpc(
      rpcEndpoint(process.env.ZECONE_SOLANA_RPC_PRIMARY ?? DEVNET),
    ),
    readonly timeoutMs = 10000,
    secondary = process.env.ZECONE_SOLANA_RPC_SECONDARY
      ? createSolanaRpc(rpcEndpoint(process.env.ZECONE_SOLANA_RPC_SECONDARY))
      : undefined,
    readonly backoffMs = 750,
  ) {
    this.providers = secondary ? [rpc, secondary] : [rpc];
  }
  get rpc() {
    return this.providers[this.providerContext.getStore() ?? this.selected];
  }
  get providerIndex() {
    return this.selected;
  }
  get providerCount() {
    return this.providers.length;
  }
  // Only read operations may fail over. Exact transaction checks remain on their provider.
  async read<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    failover = true,
  ): Promise<T> {
    if (this.active) throw new SolanaError("RPC_BUSY");
    this.active = true;
    try {
      const start = this.selected;
      for (let n = 0; n < (failover ? this.providers.length : 1); n++) {
        this.selected = (start + n) % this.providers.length;
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((r) =>
            setTimeout(r, Math.max(0, this.last + 350 - Date.now())),
          );
          this.last = Date.now();
          const signal = AbortSignal.timeout(this.timeoutMs);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const provider = this.selected;
            const result = await Promise.race([
              this.providerContext.run(provider, async () => {
                const needsGenesis =
                  (this.checked.get(provider) ?? 0) + 30000 < Date.now();
                if (needsGenesis) {
                  const genesis = await this.rpc
                    .getGenesisHash()
                    .send({ abortSignal: signal });
                  if (genesis !== GENESIS)
                    throw new SolanaError("WRONG_NETWORK");
                }
                const value = await operation(signal);
                signal.throwIfAborted();
                if (needsGenesis) this.checked.set(provider, Date.now());
                return value;
              }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new DOMException("RPC timeout", "TimeoutError")),
                  this.timeoutMs,
                );
              }),
            ]);
            return result;
          } catch (e) {
            if (e instanceof SolanaError) throw e;
            const category = rpcCategory(e, signal.aborted);
            this.diagnostics.push({
              provider: this.selected,
              attempt: attempt + 1,
              category,
            });
            if (this.diagnostics.length > 100) this.diagnostics.shift();
            if (
              ["ACCESS_DENIED", "HTTP_CLIENT", "RPC_RESPONSE"].includes(
                category,
              )
            )
              throw new SolanaError(`RPC_${category}`);
            if (attempt < 2)
              await new Promise((r) =>
                setTimeout(r, this.backoffMs * 2 ** attempt),
              );
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
      throw new SolanaError("RPC_UNAVAILABLE");
    } finally {
      this.active = false;
    }
  }
  async consistentAccounts(keys: string[], corroborate = true) {
    return this.read(async (s) => {
      const first = await this.rpc
        .getMultipleAccounts(keys.map(publicKey), {
          encoding: "base64",
          commitment: "finalized",
          minContextSlot: this.minimumSlot,
        })
        .send({ abortSignal: s });
      if (first.context.slot < this.minimumSlot)
        throw new SolanaError("RPC_CONTEXT_REGRESSION");
      this.minimumSlot = first.context.slot;
      if (corroborate && this.providers.length > 1) {
        const chosen = this.providerContext.getStore()!;
        const other = this.providers[(chosen + 1) % this.providers.length];
        try {
          if (
            (await other.getGenesisHash().send({ abortSignal: s })) !== GENESIS
          )
            throw new SolanaError("WRONG_NETWORK");
          // No silent fallback to the first provider: both must corroborate this snapshot.
          const second = await other
            .getMultipleAccounts(keys.map(publicKey), {
              encoding: "base64",
              commitment: "finalized",
              minContextSlot: this.minimumSlot,
            })
            .send({ abortSignal: s });
          const fingerprint = (value: unknown) =>
            createHash("sha256").update(json(value)).digest("hex");
          if (
            second.context.slot < this.minimumSlot ||
            fingerprint(first.value) !== fingerprint(second.value)
          )
            throw new SolanaError("RPC_PROVIDER_DISAGREEMENT");
          this.minimumSlot = second.context.slot;
        } catch (e) {
          if (e instanceof SolanaError) throw e;
          this.diagnostics.push({
            provider: (chosen + 1) % this.providers.length,
            attempt: 1,
            category: `CORROBORATION_UNAVAILABLE_${rpcCategory(e, s.aborted)}`,
          });
          // An unavailable peer is not corroboration. Domain validation still applies;
          // any actual contradictory response above is a hard reconciliation veto.
          s.throwIfAborted();
        }
      }
      return first;
    });
  }
  health() {
    return this.read(async (s) => ({
      genesis: GENESIS,
      slot: await this.rpc
        .getSlot({ commitment: "confirmed" })
        .send({ abortSignal: s }),
      height: await this.rpc
        .getBlockHeight({ commitment: "confirmed" })
        .send({ abortSignal: s }),
    }));
  }
  latest() {
    return this.read(
      async (s) =>
        (
          await this.rpc
            .getLatestBlockhash({ commitment: "confirmed" })
            .send({ abortSignal: s })
        ).value,
    );
  }
  blockhashStatus(
    hash: Parameters<typeof this.valid>[0],
    lastValidBlockHeight: bigint,
  ) {
    return this.read(async (s) => {
      const height = await this.rpc
        .getBlockHeight({ commitment: "confirmed" })
        .send({ abortSignal: s });
      const valid = (
        await this.rpc
          .isBlockhashValid(hash, { commitment: "confirmed" })
          .send({ abortSignal: s })
      ).value;
      return {
        valid: valid && height <= lastValidBlockHeight,
        remaining: lastValidBlockHeight - height,
      };
    }, false);
  }
  balance(owner: string) {
    const a = publicKey(owner);
    return this.read(
      async (s) =>
        (
          await this.rpc
            .getBalance(a, { commitment: "confirmed" })
            .send({ abortSignal: s })
        ).value,
    );
  }
  tokens(owner: string, program = TOKEN) {
    if (![TOKEN, TOKEN2022].includes(program))
      throw new SolanaError("UNSUPPORTED_TOKEN_PROGRAM");
    const a = publicKey(owner);
    return this.read(
      (s) =>
        this.rpc
          .getTokenAccountsByOwner(
            a,
            { programId: address(program) },
            { encoding: "jsonParsed", commitment: "confirmed" },
          )
          .send({ abortSignal: s }),
      false,
    );
  }
  account(key: string) {
    const a = publicKey(key);
    return this.read(
      async (s) =>
        (
          await this.rpc
            .getAccountInfo(a, {
              encoding: "jsonParsed",
              commitment: "confirmed",
            })
            .send({ abortSignal: s })
        ).value,
    );
  }
  valid(
    hash: Parameters<ReturnType<typeof createSolanaRpc>["isBlockhashValid"]>[0],
  ) {
    return this.read(
      async (s) =>
        (
          await this.rpc
            .isBlockhashValid(hash, { commitment: "confirmed" })
            .send({ abortSignal: s })
        ).value,
      false,
    );
  }
  fee(message: string) {
    return this.read(
      async (s) =>
        (
          await this.rpc
            .getFeeForMessage(
              message as Parameters<typeof this.rpc.getFeeForMessage>[0],
              { commitment: "confirmed" },
            )
            .send({ abortSignal: s })
        ).value,
      false,
    );
  }
  simulate(wire: string) {
    return this.read(
      async (s) =>
        (
          await this.rpc
            .simulateTransaction(wire as Base64EncodedWireTransaction, {
              encoding: "base64",
              commitment: "confirmed",
              sigVerify: false,
              replaceRecentBlockhash: false,
            })
            .send({ abortSignal: s })
        ).value,
      false,
    );
  }
  status(value: string) {
    const sig = signature(value);
    return this.read(async (s) => {
      const result = (
        await this.rpc
          .getSignatureStatuses([sig], { searchTransactionHistory: true })
          .send({ abortSignal: s })
      ).value[0];
      return !result
        ? "UNKNOWN"
        : result.err
          ? "FAILED"
          : result.confirmationStatus === "finalized"
            ? "FINALIZED"
            : result.confirmationStatus === "confirmed"
              ? "CONFIRMED"
              : "PROCESSED";
    });
  }
  // No sendTransaction, requestAirdrop, or broadcast capability in Phase 7A.
}
