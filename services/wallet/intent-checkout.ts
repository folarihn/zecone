// Durable dry-run ledger only. Cannot create payment requests or financial orders.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  fingerprint,
  intentId,
  type Intent,
  type Scope,
} from "./transaction-intents.ts";
import {
  PurchaseIntentQuote,
  type AdapterQuote,
} from "./purchase-intent-quote.ts";
import { unifiedCheckouts } from "./checkouts.ts";
import { checkoutBrowserView } from "./privacy.ts";
type Context = { scope: Scope; intent: Intent; params: unknown[] };
export type IntentContext = () => Context;
type Row = {
  id: string;
  scope: string;
  binding: string;
  status: string;
  quote_id: string | null;
  handoff: string | null;
};
type QuoteRow = {
  id: string;
  request_id: string;
  digest: string;
  quote: string;
  state: string;
};
const appId = 1513636914;
const binding = (c: Context) =>
  fingerprint({
    id: c.intent.id,
    digest: c.intent.requestDigest,
    params: c.params,
  });
const scopeHash = (s: Scope) =>
  fingerprint({
    session: s.session,
    channel: s.channel,
    origin: s.origin,
    chain: s.chainId,
    account: s.account,
  });
export class IntentCheckout {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly adapter: PurchaseIntentQuote,
    readonly now = Date.now,
  ) {
    if (path !== ":memory:") {
      if (!path.endsWith(".sqlite")) throw Error("DRY_RUN_DATABASE_REQUIRED");
      if (existsSync(path)) {
        const check = new DatabaseSync(path, { readOnly: true });
        try {
          if (
            (check.prepare("PRAGMA application_id").get() as any)
              .application_id !== appId
          )
            throw Error("NOT_A_DRY_RUN_DATABASE");
        } finally {
          check.close();
        }
      }
    }
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA application_id=${appId}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS intent_checkouts(id TEXT PRIMARY KEY,scope TEXT NOT NULL,binding TEXT NOT NULL,status TEXT NOT NULL,quote_id TEXT,handoff TEXT);
      CREATE TABLE IF NOT EXISTS intent_quotes(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,digest TEXT NOT NULL,quote TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intent_audit(seq INTEGER PRIMARY KEY,request_id TEXT NOT NULL,event TEXT NOT NULL,at INTEGER NOT NULL);
      UPDATE intent_checkouts SET status='RECOVERY_REQUIRED' WHERE status IN ('PREPARING','CREATING');
      UPDATE intent_quotes SET state='INTERRUPTED' WHERE state='CREATING';`);
  }
  private context(resolve: IntentContext): Context {
    const c = structuredClone(resolve());
    if (
      !c.scope.permitted ||
      !c.scope.session ||
      !c.scope.channel ||
      c.scope.expires <= this.now() ||
      c.scope.chainId !== 84532 ||
      c.intent.expires <= this.now() ||
      c.intent.approval !== "consented-preview-only" ||
      !intentId(c.intent.id)
    )
      throw Error("CURRENT_APPROVED_INTENT_REQUIRED");
    return c;
  }
  private row(c: Context): Row {
    const row = this.db
      .prepare("SELECT * FROM intent_checkouts WHERE id=?")
      .get(c.intent.id) as Row | undefined;
    if (!row || row.scope !== scopeHash(c.scope) || row.binding !== binding(c))
      throw Error("CHECKOUT_SCOPE_MISMATCH");
    return row;
  }
  private event(id: string, event: string) {
    this.db
      .prepare("INSERT INTO intent_audit(request_id,event,at) VALUES(?,?,?)")
      .run(id, event, this.now());
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async quote(resolve: IntentContext) {
    const c = this.context(resolve);
    this.atomic(() => {
      const old = this.db
        .prepare("SELECT * FROM intent_checkouts WHERE id=?")
        .get(c.intent.id) as Row | undefined;
      if (old) {
        this.row(c);
        if (
          !["QUOTED", "QUOTE_REVIEWED", "REQUOTE_REQUIRED"].includes(old.status)
        )
          throw Error("CHECKOUT_ALREADY_HANDLED_OR_RECOVERY_REQUIRED");
      } else
        this.db
          .prepare("INSERT INTO intent_checkouts VALUES(?,?,?,'NEW',NULL,NULL)")
          .run(c.intent.id, scopeHash(c.scope), binding(c));
      this.db
        .prepare(
          "UPDATE intent_quotes SET state='SUPERSEDED' WHERE request_id=? AND state IN ('QUOTED','REVIEWED')",
        )
        .run(c.intent.id);
      this.db
        .prepare("UPDATE intent_checkouts SET status='PREPARING' WHERE id=?")
        .run(c.intent.id);
      this.event(c.intent.id, "QUOTE_PREPARATION_CLAIMED");
    });
    try {
      const q = await this.adapter.quote(c.scope, c.intent, c.params);
      const current = this.context(resolve);
      this.row(current);
      if (binding(current) !== binding(c)) throw Error("INTENT_CHANGED");
      const id = randomUUID(),
        digest = fingerprint({
          version: 1,
          id,
          requestId: c.intent.id,
          scope: scopeHash(c.scope),
          quote: q,
        });
      this.atomic(() => {
        if (
          this.row(this.context(resolve)).status !== "PREPARING" ||
          this.now() >= q.expires
        )
          throw Error("PREPARATION_INTERRUPTED");
        this.db
          .prepare("INSERT INTO intent_quotes VALUES(?,?,?,?,'QUOTED')")
          .run(id, c.intent.id, digest, JSON.stringify(q));
        this.db
          .prepare(
            "UPDATE intent_checkouts SET status='QUOTED',quote_id=? WHERE id=?",
          )
          .run(id, c.intent.id);
        this.event(c.intent.id, "QUOTE_READY");
      });
      return this.view(resolve, id);
    } catch {
      this.db
        .prepare(
          "UPDATE intent_checkouts SET status='REQUOTE_REQUIRED' WHERE id=? AND status='PREPARING'",
        )
        .run(c.intent.id);
      this.event(c.intent.id, "QUOTE_FAILED_CLOSED");
      throw Error("QUOTE_UNAVAILABLE_OR_SCOPE_CHANGED");
    }
  }
  private quoteRow(resolve: IntentContext, id: string, digest?: string) {
    const c = this.context(resolve),
      row = this.row(c);
    if (!intentId(id) || row.quote_id !== id)
      throw Error("CURRENT_QUOTE_REQUIRED");
    const qr = this.db
      .prepare("SELECT * FROM intent_quotes WHERE id=? AND request_id=?")
      .get(id, c.intent.id) as QuoteRow;
    if (!qr || (digest !== undefined && digest !== qr.digest))
      throw Error("EXACT_QUOTE_REQUIRED");
    const quote = JSON.parse(qr.quote) as AdapterQuote;
    if (quote.expires <= this.now()) throw Error("QUOTE_EXPIRED");
    return { c, row, qr, quote };
  }
  review(
    resolve: IntentContext,
    id: string,
    digest: string,
    approved: unknown,
  ) {
    return this.atomic(() => {
      const { c, row, qr } = this.quoteRow(resolve, id, digest);
      if (
        row.status !== "QUOTED" ||
        qr.state !== "QUOTED" ||
        typeof approved !== "boolean"
      )
        throw Error("FRESH_QUOTE_REVIEW_REQUIRED");
      this.db
        .prepare("UPDATE intent_quotes SET state=? WHERE id=?")
        .run(approved ? "REVIEWED" : "CANCELLED", id);
      this.db
        .prepare("UPDATE intent_checkouts SET status=? WHERE id=?")
        .run(approved ? "QUOTE_REVIEWED" : "CANCELLED", c.intent.id);
      this.event(
        c.intent.id,
        approved ? "QUOTE_REVIEW_ONLY" : "QUOTE_CANCELLED",
      );
      return {
        reviewed: approved,
        checkoutCreated: false,
        executionAuthorized: false,
      };
    });
  }
  async create(
    resolve: IntentContext,
    id: string,
    digest: string,
    approved: unknown,
  ) {
    if (approved !== true)
      throw Error("SEPARATE_CHECKOUT_AUTHORIZATION_REQUIRED");
    const { c, quote } = this.atomic(() => {
      const record = this.quoteRow(resolve, id, digest);
      if (
        record.row.status !== "QUOTE_REVIEWED" ||
        record.qr.state !== "REVIEWED"
      )
        throw Error("CHECKOUT_DUPLICATE_OR_NOT_REVIEWED");
      this.db
        .prepare("UPDATE intent_checkouts SET status='CREATING' WHERE id=?")
        .run(record.c.intent.id);
      this.db
        .prepare("UPDATE intent_quotes SET state='CREATING' WHERE id=?")
        .run(id);
      this.event(record.c.intent.id, "DRY_RUN_CHECKOUT_AUTHORIZED");
      return record;
    });
    try {
      const fresh = await this.adapter.quote(c.scope, c.intent, c.params);
      const current = this.context(resolve);
      this.row(current);
      if (
        this.now() >= quote.expires ||
        fingerprint(fresh.terms) !== fingerprint(quote.terms) ||
        fresh.configDigest !== quote.configDigest ||
        fresh.requestDigest !== quote.requestDigest
      )
        throw Error("QUOTE_CHANGED_OR_EXPIRED");
      const handoffId = randomUUID();
      const projected = unifiedCheckouts(
        [
          {
            kind: "purchase",
            rows: [
              {
                id: handoffId,
                status: "Awaiting approval",
                stage: "draft",
                expiry: quote.destinationExpiry,
                chainId: 84532,
                networkName: "Base Sepolia",
                recipient: quote.terms.recipient,
                zatoshis: quote.terms.zatoshis,
                confirmations: 0,
                requiredConfirmations: 10,
                nft: quote.terms.nft,
                tokenId: quote.terms.tokenId,
              },
            ],
          },
        ],
        quote.terms.recipient,
        this.now() / 1000,
      )[0]!;
      const handoff = {
        ...checkoutBrowserView(projected, handoffId),
        mode: "dry-run",
        financialCheckoutCreated: false,
        paymentRequestCreated: false,
        executionAuthorized: false,
        networkFeeCapWei: quote.terms.gasBudgetWei,
        quoteExpires: quote.expires,
        disclosure:
          "Preview only. The trusted relayer can correlate source funding with public destination activity. No payment address, signing or execution is available.",
      };
      this.atomic(() => {
        if (
          this.row(this.context(resolve)).status !== "CREATING" ||
          this.now() >= quote.expires
        )
          throw Error("CHECKOUT_INTERRUPTED");
        this.db
          .prepare(
            "UPDATE intent_checkouts SET status='HANDOFF_READY',handoff=? WHERE id=?",
          )
          .run(JSON.stringify(handoff), c.intent.id);
        this.db
          .prepare(
            "UPDATE intent_quotes SET state='CONSUMED_PREVIEW_ONLY' WHERE id=?",
          )
          .run(id);
        this.event(c.intent.id, "DRY_RUN_HANDOFF_READY");
      });
      return structuredClone(handoff);
    } catch {
      this.db
        .prepare(
          "UPDATE intent_checkouts SET status='RECOVERY_REQUIRED' WHERE id=? AND status='CREATING'",
        )
        .run(c.intent.id);
      this.event(c.intent.id, "HANDOFF_FAILED_CLOSED");
      throw Error("CHECKOUT_REQUIRES_RECONCILIATION_NO_PAYMENT_CREATED");
    }
  }
  view(resolve: IntentContext, id: string) {
    const { quote, qr } = this.quoteRow(resolve, id);
    return {
      id: qr.id,
      digest: qr.digest,
      ...structuredClone(quote),
      mode: "dry-run",
      checkoutCreated: false,
      executionAuthorized: false,
      pricing: "fixed-testnet-demo-not-market-rate",
      disclosure:
        "Trusted prefunded relayer; public NFT ownership. Fixed gas reserve is charged even if unused. Quote review is not checkout or settlement authorization.",
    };
  }
  status(resolve: IntentContext) {
    const c = this.context(resolve),
      row = this.row(c);
    return {
      state: row.status,
      handoff: row.handoff ? JSON.parse(row.handoff) : null,
      executionAuthorized: false,
      paymentRequestCreated: false,
    };
  }
}
