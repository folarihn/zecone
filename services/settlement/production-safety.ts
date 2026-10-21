// Production control plane. No signer, payment sender or RPC broadcast capability.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID, verify, createPublicKey } from "node:crypto";
export type ProductionNetwork = "zcash" | "base" | "solana";
export type Provider = { endpoint: string; operator: string };
export type ProductionProfile = {
  network: ProductionNetwork;
  enabled: boolean;
  providers: Provider[];
  independenceAcknowledged: boolean;
  relayer?: string;
  recipients: string[];
  perTransaction: string;
  daily: string;
  feeCap: string;
  confirmations: number;
  priceAuthorities?: { operator: string; publicKey: string }[];
  signer?: {
    identity: string;
    publicKey: string;
    transport: "offline-bundle";
    separateDeviceValidated: boolean;
    attestationReference: string;
  };
  executionAuthority?: {
    identity: string;
    publicKey: string;
    separateDeviceValidated: boolean;
    attestationReference: string;
  };
};
const integer = (v: string) => {
  if (typeof v !== "string" || !/^[1-9]\d{0,30}$/.test(v))
    throw Error("INVALID_FINANCIAL_LIMIT");
  return BigInt(v);
};
export function independentProviders(p: ProductionProfile) {
  if (p.providers.length !== 2 || !p.independenceAcknowledged)
    throw Error("TWO_INDEPENDENT_PROVIDERS_REQUIRED");
  const [a, b] = p.providers.map((v) => {
    const u = new URL(v.endpoint);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      !v.operator.trim()
    )
      throw Error("INVALID_PROVIDER");
    return { host: u.hostname, operator: v.operator.trim().toLowerCase() };
  });
  if (a.host === b.host || a.operator === b.operator)
    throw Error("PROVIDER_INDEPENDENCE_REQUIRED");
}
export function validateProductionProfile(p: ProductionProfile) {
  if (
    !["zcash", "base", "solana"].includes(p.network) ||
    typeof p.enabled !== "boolean" ||
    !Array.isArray(p.recipients) ||
    !p.recipients.length ||
    new Set(p.recipients).size !== p.recipients.length
  )
    throw Error("INVALID_PRODUCTION_PROFILE");
  if (
    integer(p.perTransaction) > integer(p.daily) ||
    integer(p.feeCap) >= integer(p.perTransaction)
  )
    throw Error("INVALID_FINANCIAL_LIMIT");
  if (
    !Number.isSafeInteger(p.confirmations) ||
    p.confirmations < (p.network === "zcash" ? 20 : 1)
  )
    throw Error("CONFIRMATION_POLICY");
  independentProviders(p);
  if (
    !p.signer ||
    p.signer.transport !== "offline-bundle" ||
    !p.signer.separateDeviceValidated ||
    !p.signer.identity.trim() ||
    !p.signer.attestationReference.trim()
  )
    throw Error("SEPARATE_DEVICE_SIGNER_REQUIRED");
  const signerKey = createPublicKey(p.signer.publicKey),
    signerJwk = signerKey.export({ format: "jwk" }) as JsonWebKey,
    validSigner =
      p.network === "base"
        ? signerKey.asymmetricKeyType === "ec" && signerJwk.crv === "secp256k1"
        : signerKey.asymmetricKeyType === "ed25519";
  if (!validSigner)
    throw Error(
      p.network === "base"
        ? "SECP256K1_SIGNER_REQUIRED"
        : "ED25519_SIGNER_REQUIRED",
    );
  // A declaration is not attestation verification; activation remains separately gated.
  return structuredClone(p);
}
type Reservation = {
  order_id: string;
  terms: string;
  source: string;
  network: string;
  amount: string;
  day: number;
  state: string;
};
export class ProductionReservations {
  private token = randomUUID();
  constructor(
    readonly db: DatabaseSync,
    readonly now = () => Math.floor(Date.now() / 1000),
  ) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS production_writer(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS production_controls(id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL);
    INSERT OR IGNORE INTO production_controls VALUES(1,1);
    CREATE TABLE IF NOT EXISTS production_reservations(order_id TEXT PRIMARY KEY,terms TEXT NOT NULL,source TEXT NOT NULL UNIQUE,network TEXT NOT NULL,amount TEXT NOT NULL,day INTEGER NOT NULL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS production_policy(network TEXT PRIMARY KEY,digest TEXT NOT NULL);`);
  }
  private atomic<T>(fn: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  acquire() {
    this.atomic(() => {
      if (this.db.prepare("SELECT 1 FROM production_writer").get())
        throw Error("WRITER_ALREADY_CLAIMED_MANUAL_RECOVERY_REQUIRED");
      this.db
        .prepare("INSERT INTO production_writer VALUES(1,?)")
        .run(this.token);
    });
  }
  private owned() {
    if (
      this.db.prepare("SELECT token FROM production_writer WHERE id=1").get()
        ?.token !== this.token
    )
      throw Error("WRITER_FENCE_REQUIRED");
  }
  pause() {
    this.db.prepare("UPDATE production_controls SET paused=1 WHERE id=1").run();
  }
  unpause(operatorApproved: boolean) {
    this.atomic(() => {
      this.owned();
      if (!operatorApproved) throw Error("OPERATOR_APPROVAL_REQUIRED");
      this.db
        .prepare("UPDATE production_controls SET paused=0 WHERE id=1")
        .run();
    });
  }
  reserve(
    p: ProductionProfile,
    order: {
      id: string;
      terms: string;
      sourceCommitment: string;
      recipient: string;
      debit: string;
    },
    liquidity: bigint,
  ) {
    validateProductionProfile(p);
    if (
      !p.enabled ||
      !p.recipients.includes(order.recipient) ||
      !/^[a-f0-9]{64}$/.test(order.terms) ||
      !/^[a-f0-9]{64}$/.test(order.sourceCommitment) ||
      !order.id
    )
      throw Error("PRODUCTION_AUTHORIZATION_REQUIRED");
    const amount = integer(order.debit),
      day = Math.floor(this.now() / 86400);
    return this.atomic(() => {
      this.owned();
      if (
        this.db
          .prepare("SELECT paused FROM production_controls WHERE id=1")
          .get()?.paused !== 0
      )
        throw Error("EMERGENCY_PAUSED");
      const policyDigest = createHash("sha256")
        .update(JSON.stringify(p))
        .digest("hex");
      const policy = this.db
        .prepare("SELECT digest FROM production_policy WHERE network=?")
        .get(p.network);
      if (policy && policy.digest !== policyDigest)
        throw Error("POLICY_CHANGE_REQUIRES_RECONCILIATION");
      const old = this.db
        .prepare(
          "SELECT * FROM production_reservations WHERE order_id=? OR source=?",
        )
        .get(order.id, order.sourceCommitment) as Reservation | undefined;
      if (old) {
        if (
          old.order_id !== order.id ||
          old.terms !== order.terms ||
          old.source !== order.sourceCommitment ||
          old.amount !== order.debit ||
          old.network !== p.network ||
          old.state !== "HELD"
        )
          throw Error("RESERVATION_REPLAY_OR_CONFLICT");
        return old;
      }
      const rows = this.db
        .prepare("SELECT * FROM production_reservations WHERE network=?")
        .all(p.network) as Reservation[];
      // Uncertain claims never age out of the inventory reservation. Completed
      // spend consumes its original day's limit; unresolved spend also consumes today's.
      const outstanding = rows
        .filter((r) => ["HELD", "CLAIMED", "UNCERTAIN"].includes(r.state))
        .reduce((n, r) => n + BigInt(r.amount), 0n);
      const spent = rows
        .filter(
          (r) =>
            r.state !== "CANCELLED" &&
            (r.day === day ||
              ["HELD", "CLAIMED", "UNCERTAIN"].includes(r.state)),
        )
        .reduce((n, r) => n + BigInt(r.amount), 0n);
      if (
        amount > BigInt(p.perTransaction) ||
        spent + amount > BigInt(p.daily) ||
        outstanding + amount > liquidity
      )
        throw Error("RESERVATION_LIMIT_OR_LIQUIDITY");
      this.db
        .prepare("INSERT OR IGNORE INTO production_policy VALUES(?,?)")
        .run(p.network, policyDigest);
      this.db
        .prepare(
          "INSERT INTO production_reservations VALUES(?,?,?,?,?,?,'HELD')",
        )
        .run(
          order.id,
          order.terms,
          order.sourceCommitment,
          p.network,
          order.debit,
          day,
        );
      return this.db
        .prepare("SELECT * FROM production_reservations WHERE order_id=?")
        .get(order.id);
    });
  }
  claim(id: string, terms: string) {
    this.atomic(() => {
      this.owned();
      if (
        this.db.prepare("SELECT paused FROM production_controls").get()
          ?.paused !== 0
      )
        throw Error("EMERGENCY_PAUSED");
      if (
        this.db
          .prepare(
            "UPDATE production_reservations SET state='CLAIMED' WHERE order_id=? AND terms=? AND state='HELD'",
          )
          .run(id, terms).changes !== 1
      )
        throw Error("DUPLICATE_OR_CONFLICT");
    });
  }
  // No API releases CLAIMED/UNCERTAIN money or marks it successful. Canonical
  // finalized evidence must be integrated before such state transitions exist.
  uncertain(id: string) {
    this.atomic(() => {
      this.owned();
      if (
        this.db
          .prepare(
            "UPDATE production_reservations SET state='UNCERTAIN' WHERE order_id=? AND state='CLAIMED'",
          )
          .run(id).changes !== 1
      )
        throw Error("RESERVATION_STATE");
    });
  }
  releaseWriter() {
    this.atomic(() => {
      this.owned();
      if (
        this.db
          .prepare(
            "SELECT 1 FROM production_reservations WHERE state IN ('HELD','CLAIMED','UNCERTAIN')",
          )
          .get()
      )
        throw Error("OUTSTANDING_RESERVATIONS_MANUAL_RECOVERY_REQUIRED");
      this.db
        .prepare("DELETE FROM production_writer WHERE token=?")
        .run(this.token);
    });
  }
}
export type PriceStatement = {
  version: 1;
  operator: string;
  pair: "ETH/ZEC" | "SOL/ZEC";
  numerator: string;
  denominator: string;
  at: number;
  expires: number;
  network?: "base-mainnet" | "solana-mainnet";
  quoteContext?: string;
};
export type SignedPrice = { statement: PriceStatement; signature: string };
export function productionPrice(
  feeds: readonly { price: SignedPrice; publicKey: string }[],
  pair: PriceStatement["pair"],
  destinationUnits: bigint,
  decimals: 18 | 9,
  now: number,
  maximumSpreadBps = 100,
) {
  if (
    feeds.length !== 2 ||
    feeds[0].price.statement.operator.trim().toLowerCase() ===
      feeds[1].price.statement.operator.trim().toLowerCase() ||
    createPublicKey(feeds[0].publicKey)
      .export({ format: "der", type: "spki" })
      .equals(
        createPublicKey(feeds[1].publicKey).export({
          format: "der",
          type: "spki",
        }),
      ) ||
    !Number.isSafeInteger(maximumSpreadBps) ||
    maximumSpreadBps < 0 ||
    maximumSpreadBps > 100 ||
    destinationUnits <= 0n ||
    decimals !== (pair === "ETH/ZEC" ? 18 : 9)
  )
    throw Error("INDEPENDENT_PRICE_FEEDS_REQUIRED");
  const values = feeds.map(({ price, publicKey }) => {
    const s = price.statement,
      key = createPublicKey(publicKey);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      s.version !== 1 ||
      !s.operator.trim() ||
      s.pair !== pair ||
      !Number.isSafeInteger(s.at) ||
      !Number.isSafeInteger(s.expires) ||
      s.at > now + 5 ||
      now - s.at > 60 ||
      s.expires <= now ||
      s.expires <= s.at ||
      s.expires - s.at > 120 ||
      !verify(
        null,
        Buffer.from(JSON.stringify(s)),
        key,
        Buffer.from(price.signature, "base64"),
      )
    )
      throw Error("INVALID_OR_STALE_PRODUCTION_PRICE");
    return {
      n: integer(s.numerator),
      d: integer(s.denominator),
      expires: s.expires,
    };
  });
  const [a, b] = values;
  if (
    (a.n * b.d > b.n * a.d ? a.n * b.d - b.n * a.d : b.n * a.d - a.n * b.d) *
      10000n >
    (a.n * b.d < b.n * a.d ? a.n * b.d : b.n * a.d) * BigInt(maximumSpreadBps)
  )
    throw Error("PRICE_PROVIDER_DISAGREEMENT");
  const ceiling = (n: bigint, d: bigint) => (n + d - 1n) / d;
  const costs = values.map((v) =>
    ceiling(destinationUnits * v.n * 100000000n, 10n ** BigInt(decimals) * v.d),
  );
  return {
    zatoshis: (costs[0] > costs[1] ? costs[0] : costs[1]).toString(),
    expires: Math.min(a.expires, b.expires),
    confidence: "CORROBORATED_SIGNED_PRICES" as const,
  };
}
export function assertMainnetExecutionAvailable(): never {
  // Do not turn configuration declarations or synthetic checks into authority.
  throw Error(
    "MAINNET_DISABLED_NATIVE_SHIELDED_OBSERVER_AND_ISOLATED_SIGNER_VALIDATION_REQUIRED",
  );
}
