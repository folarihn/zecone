import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyMessage, type Hex } from "viem";
import { ApiError, ORIGIN, type Sessions, type Session } from "./security.ts";
import type { Dashboard } from "./view.ts";
const KEY = ".secrets/phase7a-evm/user.json";
export function disposableEvm() {
  mkdirSync(".secrets/phase7a-evm", { recursive: true });
  if (!existsSync(KEY)) {
    const key = generatePrivateKey();
    writeFileSync(
      KEY,
      JSON.stringify({ key, address: privateKeyToAccount(key).address }),
      { flag: "wx", mode: 0o600 },
    );
  }
  return privateKeyToAccount(
    (JSON.parse(readFileSync(KEY, "utf8")) as { key: Hex }).key,
  ).address;
}
export function phase7Backend(sessions: Sessions) {
  const address = disposableEvm();
  sessions.db.exec(
    "CREATE TABLE IF NOT EXISTS test_challenges(id TEXT PRIMARY KEY,session TEXT NOT NULL,message TEXT NOT NULL,expires INTEGER NOT NULL)",
  );
  const disabled = (): never => {
    throw new ApiError(403, "Disabled in isolated Phase 7A validation.");
  };
  return {
    dashboard: (): Dashboard => ({
      address,
      contract: "",
      priceZatoshis: "0",
      zcash: null,
      base: null,
      nfts: [],
      checkouts: [],
      baseActivity: [],
      health: {
        zcash: "Historical wallet not opened",
        base: "Read-only devnet checks",
        worker: "No settlement workers",
        busy: false,
      },
      readOnlyNotice:
        "Isolated Phase 7A disposable account. EVM connection proofs only; dApp signing, payments, refunds and broadcasts disabled.",
    }),
    challenge: (s: Session) => {
      const id = randomUUID(),
        expires = Date.now() + 120000,
        message = `ZecOne disposable account ownership\nOrigin: ${ORIGIN}\nAccount: ${address}\nNonce: ${id}\nExpires: ${expires}\nNo spending authorization.`;
      sessions.db
        .prepare("DELETE FROM test_challenges WHERE session=?")
        .run(s.id);
      sessions.db
        .prepare("INSERT INTO test_challenges VALUES(?,?,?,?)")
        .run(id, s.id, message, expires);
      return { id, message, expires };
    },
    connect: async (s: Session, id: string, approved: unknown) => {
      if (approved !== true)
        throw new ApiError(403, "Explicit ownership approval required.");
      const row = sessions.db
        .prepare(
          "DELETE FROM test_challenges WHERE id=? AND session=? AND expires>? RETURNING message",
        )
        .get(id, s.id, Date.now());
      if (!row) throw new ApiError(409, "Challenge expired or used.");
      const signer = privateKeyToAccount(
        JSON.parse(readFileSync(KEY, "utf8")).key,
      );
      if (signer.address !== address)
        throw new ApiError(403, "Disposable account mismatch.");
      const message = String(row.message),
        signature = await signer.signMessage({ message });
      if (!(await verifyMessage({ address, message, signature })))
        throw new ApiError(403, "Ownership verification failed.");
      sessions.db
        .prepare("UPDATE sessions SET connected=1 WHERE id=? AND expires>?")
        .run(s.id, Date.now());
      return { connected: true, address };
    },
    refresh: disabled,
    create: disabled,
    quote: disabled,
    pay: disabled,
    recheck: disabled,
    paymentRequest: disabled,
  };
}
