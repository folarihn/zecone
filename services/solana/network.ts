import {
  address,
  createSolanaRpc,
  signature,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
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
  constructor(
    readonly rpc = createSolanaRpc(DEVNET),
    readonly timeoutMs = 10000,
  ) {}
  // One operation at a time per adapter; bounded retries and no endpoint fallback.
  async read<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active) throw new SolanaError("RPC_BUSY");
    this.active = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise((r) =>
          setTimeout(r, Math.max(0, this.last + 350 - Date.now())),
        );
        this.last = Date.now();
        const signal = AbortSignal.timeout(this.timeoutMs);
        try {
          const genesis = await this.rpc
            .getGenesisHash()
            .send({ abortSignal: signal });
          if (genesis !== GENESIS) throw new SolanaError("WRONG_NETWORK");
          return await operation(signal);
        } catch (e) {
          if (e instanceof SolanaError) throw e;
          if (attempt === 2) throw new SolanaError("RPC_UNAVAILABLE");
          await new Promise((r) => setTimeout(r, (attempt + 1) * 750));
        }
      }
      throw new SolanaError("RPC_UNAVAILABLE");
    } finally {
      this.active = false;
    }
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
    return this.read((s) =>
      this.rpc
        .getTokenAccountsByOwner(
          a,
          { programId: address(program) },
          { encoding: "jsonParsed", commitment: "confirmed" },
        )
        .send({ abortSignal: s }),
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
