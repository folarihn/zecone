// Local paired-device consent only; explicitly not proof of wallet ownership.
// Every financial operation fails closed. No key loader is imported.
import { randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { ApiError, type Sessions, type Session } from "./security.ts";
import type { Dashboard } from "./view.ts";
export function reviewBackend(sessions: Sessions, displayAddress: string) {
  const address = getAddress(displayAddress);
  sessions.db.exec(
    "CREATE TABLE IF NOT EXISTS local_review_challenges(id TEXT PRIMARY KEY,session TEXT NOT NULL,expires INTEGER NOT NULL)",
  );
  const disabled = (): never => {
    throw new ApiError(
      403,
      "Economic review only. Financial operations are disabled.",
    );
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
        zcash: "Not opened",
        base: "Not opened",
        worker: "Disabled",
        busy: false,
      },
      readOnlyNotice:
        "Economic review only. Local pairing is not wallet ownership proof. No wallet keys, payment sender or execution worker is loaded.",
    }),
    challenge: (s: Session) => {
      const id = randomUUID(),
        expires = Date.now() + 120000;
      sessions.db
        .prepare("DELETE FROM local_review_challenges WHERE session=?")
        .run(s.id);
      sessions.db
        .prepare("INSERT INTO local_review_challenges VALUES(?,?,?)")
        .run(id, s.id, expires);
      return {
        id,
        expires,
        message:
          "Enable local economic review only. This is not a wallet signature, ownership proof, payment or execution approval.",
      };
    },
    connect: async (s: Session, id: string, approved: unknown) => {
      if (approved !== true)
        throw new ApiError(403, "Explicit local review consent required.");
      const row = sessions.db
        .prepare(
          "DELETE FROM local_review_challenges WHERE id=? AND session=? AND expires>? RETURNING id",
        )
        .get(id, s.id, Date.now());
      if (!row) throw new ApiError(409, "Local review consent expired.");
      sessions.db
        .prepare("UPDATE sessions SET connected=1 WHERE id=? AND expires>?")
        .run(s.id, Date.now());
      return {
        connected: true,
        address,
        walletOwnershipVerified: false,
        financialAuthority: false,
      };
    },
    refresh: disabled,
    create: disabled,
    quote: disabled,
    pay: disabled,
    recheck: disabled,
    paymentRequest: disabled,
  };
}
