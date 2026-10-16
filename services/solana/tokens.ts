import { findAssociatedTokenPda } from "@solana-program/token";
import { Devnet, TOKEN, TOKEN2022, SolanaError, publicKey } from "./network.ts";
export function decimal(raw: string, decimals: number) {
  if (
    !/^\d+$/.test(raw) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    throw new SolanaError("INVALID_TOKEN_AMOUNT");
  const n = BigInt(raw),
    base = 10n ** BigInt(decimals);
  return `${n / base}${decimals ? "." + (n % base).toString().padStart(decimals, "0") : ""}`;
}
export async function tokenView(row: any, owner: string, program: string) {
  const info = row.account?.data?.parsed?.info;
  if (!info || row.account.owner !== program || info.owner !== owner)
    throw new SolanaError("INVALID_TOKEN_ACCOUNT");
  const mint = publicKey(info.mint),
    key = publicKey(row.pubkey);
  const extensions = info.extensions ?? [];
  if (!Array.isArray(extensions))
    throw new SolanaError("INVALID_TOKEN_ACCOUNT");
  const encrypted = extensions.some((e: any) =>
    /confidential/i.test(String(e.extension)),
  );
  const associated = (
    await findAssociatedTokenPda({
      owner: publicKey(owner),
      mint,
      tokenProgram: publicKey(program),
    })
  )[0];
  return {
    address: key,
    mint,
    program,
    decimals: info.tokenAmount.decimals,
    raw: info.tokenAmount.amount,
    balance: encrypted
      ? null
      : decimal(info.tokenAmount.amount, info.tokenAmount.decimals),
    encrypted,
    associated: associated === key,
    associatedAddress: associated,
    status: info.state,
    extensions: extensions.map((e: any) => String(e.extension)),
    transferSupported:
      program === TOKEN &&
      info.state === "initialized" &&
      extensions.length === 0,
    metadata: null,
  };
}
export async function portfolio(net: Devnet, owner: string) {
  const lamports = await net.balance(owner);
  const tokens = [];
  for (const program of [TOKEN, TOKEN2022]) {
    const response = await net.tokens(owner, program);
    for (const row of response.value)
      tokens.push(await tokenView(row, owner, program));
  }
  return {
    owner,
    network: "solana:devnet",
    lamports: lamports.toString(),
    sol: decimal(lamports.toString(), 9),
    tokens,
    observedAt: new Date().toISOString(),
  };
}
