import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  http,
  getAddress,
  verifyMessage,
  type Address,
  type Hex,
  encodeFunctionData,
  hashTypedData,
} from "viem";
import { baseSepolia } from "viem/chains";
import { exclusiveJson, readJson, locked } from "../execution/io.ts";
import { PRICE, type Intent } from "../execution/intent.ts";
import { Store } from "../execution/store.ts";
import { Zcash } from "../execution/zcash.ts";
import { Base, abi } from "../execution/base.ts";
import { executeOne } from "../execution/worker.ts";
import {userWalletNative} from './native.ts';
import { AppState, type Checkout } from "./state.ts";
import { ApiError, ORIGIN, randomToken, type Session } from "./security.ts";
import { checkoutView, type Dashboard, type WalletSummary } from "./view.ts";
import {
  ActionBase,
  actionAbi,
  actionTyped,
  ACTION_BUDGET,
  NOTE,
  type ActionIntent,
} from "../execution/action.ts";
import { providerReserved } from "../marketplace/journal.ts";
const exec = promisify(execFile),
  now = () => Math.floor(Date.now() / 1000);
export const uuid = (v: unknown): string => {
  if (
    typeof v !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      v,
    )
  )
    throw new ApiError(400, "Invalid request reference.");
  return v;
};
export function requireApproval(s: Session, approved: unknown) {
  if (!s.connected) throw new ApiError(403, "Verify wallet ownership first.");
  if (approved !== true)
    throw new ApiError(400, "Explicit approval is required.");
}
export class Engine {
  readonly approvalDir = ".state/browser-approvals";
  readonly app = new AppState();
  readonly store = new Store(".state/orders.sqlite");
  readonly manifest = readJson<{
    base: { user: Address };
    zcash: { payer: { account: string } };
  }>("docs/PUBLIC_WALLETS.json");
  readonly contract = readJson<{ contract: Address }>(
    ".state/deployment-confirmed.json",
  ).contract;
  readonly address = getAddress(this.manifest.base.user);
  readonly public = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org", {
      timeout: 20000,
      retryCount: 1,
    }),
  });
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private refreshing = false;
  private zcash: WalletSummary | null = null;
  private base: Dashboard["base"] = null;
  private nfts: Dashboard["nfts"] = [];
  private health = {
    zcash: "Waiting for first sync",
    base: "Waiting for first sync",
    worker: "Ready",
  };
  recoverInterrupted() {
    for (const c of this.app.all())
      if (["sending", "creating"].includes(c.stage))
        this.app.update(
          c.id,
          "review",
          "Interrupted action requires reconciliation.",
        );
  }
  actionDraft(s: Session) {
    requireApproval(s, true);
    this.app.db.exec(
      "CREATE TABLE IF NOT EXISTS action_drafts(id TEXT PRIMARY KEY,session TEXT NOT NULL,intent TEXT NOT NULL,digest TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0)",
    );
    if (!existsSync(".state/actions-confirmed.json"))
      throw new ApiError(
        503,
        "The fixed-action contract has not been deployed.",
      );
    const contract = readJson<{ contract: Address }>(
        ".state/actions-confirmed.json",
      ).contract,
      id = randomUUID(),
      orderId = `0x${randomToken()}` as Hex;
    const intent: Omit<ActionIntent, "signature"> = {
      kind: "action",
      orderId,
      nonce: orderId,
      chainId: 84532,
      recipient: this.address,
      contract,
      target: contract,
      data: encodeFunctionData({
        abi: actionAbi,
        functionName: "recordFor",
        args: [this.address, NOTE],
      }),
      maxValue: "0",
      maxGasBudget: ACTION_BUDGET,
      zatoshis: PRICE.toString(),
      expiry: now() + 86400,
    };
    const digest = hashTypedData(actionTyped(intent));
    this.app.db
      .prepare(
        "INSERT INTO action_drafts(id,session,intent,digest) VALUES(?,?,?,?)",
      )
      .run(id, s.id, JSON.stringify(intent), digest);
    return {
      id,
      intent,
      digest,
      description:
        "Record one sponsored ZecOne test action for your EVM account. No NFT is minted. Prefunded testnet sponsorship; no ZEC-to-ETH conversion. Gas budget covers EVM execution; Base L1 data fees are additional.",
    };
  }
  async createAction(
    s: Session,
    id: string,
    digest: string,
    approved: unknown,
  ) {
    requireApproval(s, approved);
    return this.serial(async () => {
      const draft = this.app.db
        .prepare("SELECT * FROM action_drafts WHERE id=? AND session=?")
        .get(id, s.id) as
        { intent: string; digest: string; used: number } | undefined;
      if (!draft || draft.digest !== digest)
        throw new ApiError(403, "Exact action approval required");
      const old = this.app.get(id);
      if (old) return checkoutView(old, this.store, this.zcash?.tip ?? 0);
      const i = JSON.parse(draft.intent) as Omit<ActionIntent, "signature">;
      if (i.expiry <= now() || draft.used || s.expires <= Date.now())
        throw new ApiError(409, "Action expired or already approved");
      const active = this.app
        .all()
        .find(
          (c) =>
            !["Completed", "Failed"].includes(
              checkoutView(c, this.store, this.zcash?.tip ?? 0).status,
            ),
        );
      if (active)
        throw new ApiError(
          409,
          "Finish or reconcile the existing checkout first",
        );
      this.app.db.prepare("UPDATE action_drafts SET used=1 WHERE id=?").run(id);
      this.app.db
        .prepare(
          "INSERT INTO checkouts(id,intent,request_id,stage,created) VALUES(?,?,?,?,?)",
        )
        .run(id, draft.intent, randomUUID(), "creating", now());
      try {
        const path = resolve(this.approvalDir, `${id}.json`);
        exclusiveJson(path, {
          kind: "action-intent",
          approved: true,
          expires: Math.min(Date.now() + 300000, s.expires),
          intent: i,
        });
        const { intentFile } = await this.script<{ intentFile: string }>(
          "scripts/local-user-sign.ts",
          [path],
        );
        const order = await this.script<{ id: string }>("scripts/actions.ts", [
          "create",
          intentFile,
        ]);
        this.app.db
          .prepare(
            "UPDATE checkouts SET order_id=?,stage='awaiting' WHERE id=?",
          )
          .run(order.id, id);
      } catch (e) {
        this.app.update(id, "review");
        throw e;
      }
      return checkoutView(this.app.get(id)!, this.store, this.zcash?.tip ?? 0);
    });
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    this.queued++;
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {}).finally(() => this.queued--);
    return result;
  }
  private async native<T>(args: string[]): Promise<T> {
    try {
      return await userWalletNative<T>(args);
    } catch {
      throw new ApiError(
        503,
        "The local Zcash operation could not finish. No success is assumed. Recheck status before trying anything else.",
      );
    }
  }
  private async script<T>(name: string, args: string[]): Promise<T> {
    try {
      const { stdout } = await exec(
        process.execPath,
        ["--import", "tsx", name, ...args],
        { timeout: 600000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      return JSON.parse(stdout);
    } catch {
      throw new ApiError(
        503,
        "Local signing or order creation could not finish. Recheck the saved checkout; do not make another payment.",
      );
    }
  }
  dashboard(): Dashboard {
    const merchantTip = this.app.db
      .prepare("SELECT value FROM app_meta WHERE key='merchant_tip'")
      .get() as { value: string } | undefined;
    return {
      address: this.address,
      contract: this.contract,
      priceZatoshis: PRICE.toString(),
      zcash: this.zcash,
      base: this.base,
      health: { ...this.health, busy: this.queued > 0 },
      nfts: this.nfts,
      baseActivity: this.store
        .all()
        .filter(
          (o) =>
            o.tx_hash &&
            getAddress(JSON.parse(o.intent).recipient) === this.address,
        )
        .map((o) => ({
          hash: o.tx_hash!,
          kind:
            JSON.parse(o.intent).kind === "action"
              ? ("action" as const)
              : ("mint" as const),
          status:
            o.state === "settled"
              ? "Confirmed"
              : o.state === "failed"
                ? "Reverted"
                : "Pending / review",
          tokenId:
            JSON.parse(o.intent).kind === "action"
              ? null
              : BigInt(o.id).toString(),
        })),
      checkouts: this.app
        .all()
        .map((c) =>
          checkoutView(c, this.store, Number(merchantTip?.value ?? 0)),
        ),
    };
  }
  challenge(s: Session) {
    const id = randomUUID(),
      expires = Date.now() + 300000;
    const message = `ZecOne local wallet connection\nOrigin: ${ORIGIN}\nAccount: ${this.address}\nChain: 84532\nNonce: ${randomToken()}\nExpires: ${new Date(expires).toISOString()}\nThis proves ownership only. It does not spend funds or authorize a mint.`;
    this.app.db.prepare("DELETE FROM challenges WHERE session_id=?").run(s.id);
    this.app.db
      .prepare("INSERT INTO challenges VALUES(?,?,?,?,0)")
      .run(id, s.id, message, expires);
    return { id, message, expires };
  }
  async connect(s: Session, id: string, approved: unknown) {
    if (approved !== true)
      throw new ApiError(400, "Approve the connection signature first.");
    const row = this.app.db
      .prepare(
        "UPDATE challenges SET used=1 WHERE id=? AND session_id=? AND expires>? AND used=0 RETURNING message,expires",
      )
      .get(id, s.id, Date.now()) as
      { message: string; expires: number } | undefined;
    if (!row)
      throw new ApiError(
        409,
        "Connection challenge expired or was already used.",
      );
    const path = resolve(this.approvalDir, `${id}.json`);
    exclusiveJson(path, { kind: "ownership", approved: true, ...row });
    const { signature } = await this.script<{ signature: Hex }>(
      "scripts/local-user-sign.ts",
      [path],
    );
    if (
      !(await verifyMessage({
        address: this.address,
        message: row.message,
        signature,
      }))
    )
      throw new ApiError(403, "Wallet ownership could not be verified.");
    this.app.db
      .prepare("UPDATE sessions SET connected=1 WHERE id=? AND expires>?")
      .run(s.id, Date.now());
    return { connected: true, address: this.address };
  }
  async create(s: Session, id: string, approved: unknown) {
    requireApproval(s, approved);
    return this.serial(async () => {
      const old = this.app.get(id);
      if (old) return checkoutView(old, this.store, this.zcash?.tip ?? 0);
      const active = this.app
        .all()
        .find(
          (c) =>
            !["Completed", "Failed"].includes(
              checkoutView(c, this.store, this.zcash?.tip ?? 0).status,
            ),
        );
      if (active) return checkoutView(active, this.store, this.zcash?.tip ?? 0);
      // All terms originate here, not from browser-provided calldata or destinations.
      const intent: Omit<Intent, "signature"> = {
        recipient: this.address,
        contract: this.contract,
        zatoshis: PRICE.toString(),
        nonce: `0x${randomToken()}`,
        expiry: now() + 86400,
      };
      this.app.db
        .prepare(
          "INSERT INTO checkouts(id,intent,request_id,stage,created) VALUES(?,?,?,?,?)",
        )
        .run(id, JSON.stringify(intent), randomUUID(), "creating", now());
      try {
        const path = resolve(this.approvalDir, `${id}.json`);
        exclusiveJson(path, {
          kind: "mint-intent",
          approved: true,
          expires: Date.now() + 300000,
          intent,
        });
        const { intentFile } = await this.script<{ intentFile: string }>(
          "scripts/local-user-sign.ts",
          [path],
        );
        const order = await this.script<{ id: string }>(
          "services/execution/cli.ts",
          ["create", intentFile],
        );
        this.app.db
          .prepare(
            "UPDATE checkouts SET order_id=?,stage='awaiting' WHERE id=?",
          )
          .run(order.id, id);
      } catch (e) {
        this.app.update(id, "review");
        throw e;
      }
      return checkoutView(this.app.get(id)!, this.store, this.zcash?.tip ?? 0);
    });
  }
  private checkout(id: string) {
    const c = this.app.get(id);
    if (!c) throw new ApiError(404, "Checkout not found.");
    return c;
  }
  async quote(s: Session, id: string) {
    requireApproval(s, true);
    return this.serial(async () => {
      const c = this.checkout(id),
        o = c.order_id ? this.store.get(c.order_id) : undefined;
      if (
        !o ||
        !["awaiting", "quoted"].includes(c.stage) ||
        o.state !== "awaiting_payment" ||
        this.store.totals(o.id).received > 0n ||
        JSON.parse(c.intent).expiry <= now()
      )
        throw new ApiError(409, "This checkout cannot accept another payment.");
      const q = await this.native<{
        feeZatoshis: string;
        totalZatoshis: string;
      }>([
        "quote",
        "--account",
        this.manifest.zcash.payer.account,
        "--address",
        o.address,
        "--zatoshis",
        PRICE.toString(),
      ]);
      const quote = {
        id: randomUUID(),
        feeZatoshis: q.feeZatoshis,
        totalZatoshis: q.totalZatoshis,
        expires: Date.now() + 120000,
      };
      const changed = this.app.db
        .prepare(
          "UPDATE checkouts SET quote=?,quote_session=?,stage='quoted' WHERE id=? AND stage IN ('awaiting','quoted')",
        )
        .run(JSON.stringify(quote), s.id, id);
      if (changed.changes !== 1)
        throw new ApiError(
          409,
          "This checkout changed while calculating its fee. Recheck status.",
        );
      return checkoutView(this.checkout(id), this.store, this.zcash?.tip ?? 0);
    });
  }
  pay(s: Session, id: string, quoteId: string, approved: unknown) {
    requireApproval(s, approved);
    const c = this.checkout(id);
    if (["sending", "sent", "review"].includes(c.stage))
      return checkoutView(c, this.store, this.zcash?.tip ?? 0);
    const q = c.quote ? JSON.parse(c.quote) : null;
    if (
      c.stage !== "quoted" ||
      !q ||
      q.id !== quoteId ||
      c.quote_session !== s.id ||
      q.expires <= Date.now()
    )
      throw new ApiError(
        409,
        "Your fee quote expired. Review a fresh quote before approving.",
      );
    const o = c.order_id ? this.store.get(c.order_id) : undefined;
    if (
      !o ||
      o.state !== "awaiting_payment" ||
      this.store.totals(o.id).received > 0n ||
      JSON.parse(c.intent).expiry <= now()
    )
      throw new ApiError(409, "This order cannot accept payment.");
    // Durable CAS before launching any signer. Repeated HTTP submissions reuse this reference.
    const changed = this.app.db
      .prepare(
        "UPDATE checkouts SET stage='sending' WHERE id=? AND stage='quoted'",
      )
      .run(id);
    if (changed.changes !== 1)
      throw new ApiError(409, "Payment is already being processed.");
    void this.serial(async () => {
      try {
        // A queue delay may not silently extend approval lifetime.
        if (q.expires <= Date.now()) throw new Error("quote expired");
        const result = await this.native<{ txid: string }>([
          "send",
          "--request-id",
          c.request_id,
          "--account",
          this.manifest.zcash.payer.account,
          "--address",
          o.address,
          "--zatoshis",
          PRICE.toString(),
          "--max-fee-zatoshis",
          q.feeZatoshis,
          "--allow-testnet-broadcast",
        ]);
        this.app.db
          .prepare("UPDATE checkouts SET txid=?,stage='sent' WHERE id=?")
          .run(result.txid, id);
      } catch {
        // Native code durably writes started before any transaction construction.
        const uncertain =
          existsSync(
            `.secrets/user/zcash/request-${c.request_id}.started.json`,
          ) ||
          existsSync(`.secrets/user/zcash/request-${c.request_id}.json`) ||
          existsSync(".secrets/user/zcash/process.lock");
        this.app.update(id, uncertain ? "review" : "awaiting");
      }
    });
    return checkoutView(this.checkout(id), this.store, this.zcash?.tip ?? 0);
  }
  async recheck(s: Session, id: string) {
    requireApproval(s, true);
    return this.serial(async () => {
      const c = this.checkout(id);
      if (c.stage === "review" && !c.order_id) {
        const signed = resolve(this.approvalDir, `${id}.signed.json`);
        if (existsSync(signed)) {
          // Reuse the prior signature and nonce. Reconciliation never signs a new intent.
          const order = await this.script<{ id: string }>(
            JSON.parse(c.intent).kind === "action"
              ? "scripts/actions.ts"
              : "services/execution/cli.ts",
            ["create", signed],
          );
          this.app.db
            .prepare(
              "UPDATE checkouts SET order_id=?,stage='awaiting' WHERE id=?",
            )
            .run(order.id, id);
        }
      }
      if (c.stage === "review" && c.order_id) {
        const file = `.secrets/user/zcash/request-${c.request_id}.json`;
        if (existsSync(file)) {
          const r = await this.native<{ txid: string; status: string }>([
            "reconcile-send",
            "--request-id",
            c.request_id,
          ]);
          this.app.db
            .prepare("UPDATE checkouts SET txid=? WHERE id=?")
            .run(r.txid, id);
          if (r.status === "known-to-server-requires-wallet-confirmation")
            this.app.update(id, "sent");
        } else if (
          !existsSync(
            `.secrets/user/zcash/request-${c.request_id}.started.json`,
          ) &&
          !existsSync(".secrets/user/zcash/process.lock")
        ) {
          this.app.update(id, "awaiting");
        }
      }
      return checkoutView(this.checkout(id), this.store, this.zcash?.tip ?? 0);
    });
  }
  refresh() {
    if (this.refreshing || this.queued > 0) return;
    this.refreshing = true;
    void this.serial(async () => {
      const results = await Promise.allSettled([
        this.native<WalletSummary>(["summary"]),
        this.refreshBase(),
      ]);
      if (results[0].status === "fulfilled") {
        this.zcash = results[0].value;
        this.health.zcash = "Synced";
      } else this.health.zcash = "Sync unavailable — showing last known data";
      this.health.base =
        results[1].status === "fulfilled"
          ? "Connected"
          : "RPC unavailable — showing last known data";
      const approved = this.app
        .all()
        .filter((c) => ["sent", "sending"].includes(c.stage) && c.order_id);
      if (
        this.app
          .all()
          .filter((c) => c.order_id)
          .some(
            (c) =>
              !["settled", "expired"].includes(
                this.store.get(c.order_id!)?.state ?? "",
              ),
          )
      ) {
        try {
          await locked(".state/service.lock", async () => {
            const snapshot = await new Zcash().observe();
            this.store.observe(snapshot, now());
            this.app.db
              .prepare(
                "INSERT INTO app_meta(key,value) VALUES('merchant_tip',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              )
              .run(String(snapshot.tip));
            const pending = this.store
              .all()
              .find(
                (o) =>
                  o.tx_hash &&
                  ["prepared", "submitted", "recovery"].includes(o.state),
              );
            const next =
              pending ??
              approved
                .map((c) => this.store.get(c.order_id!)!)
                .find((o) => this.store.eligible(o, now()));
            // Respect another CLI order's nonce without authorizing its execution here.
            if (
              next &&
              (next.tx_hash || !providerReserved()) &&
              approved.some((c) => c.order_id === next.id)
            )
              await executeOne(
                this.store,
                next.id,
                JSON.parse(next.intent).kind === "action"
                  ? new ActionBase(
                      readJson<{ contract: Address }>(
                        ".state/actions-confirmed.json",
                      ).contract,
                    )
                  : new Base(this.contract),
                now,
              );
          });
          this.health.worker = "Ready";
        } catch {
          this.health.worker =
            "Settlement paused — retrying status checks safely";
        }
      }
    }).finally(() => {
      this.refreshing = false;
    });
  }
  private async refreshBase() {
    if ((await this.public.getChainId()) !== 84532)
      throw Error("Wrong network");
    const [wei, block] = await Promise.all([
      this.public.getBalance({ address: this.address }),
      this.public.getBlockNumber(),
    ]);
    const owned: Dashboard["nfts"] = [];
    for (const o of this.store
      .all()
      .filter((o) => o.state === "settled" && o.tx_hash)) {
      if (
        JSON.parse(o.intent).kind === "action" ||
        getAddress(JSON.parse(o.intent).recipient) !== this.address
      )
        continue;
      const tokenId = BigInt(o.id);
      const owner = await this.public.readContract({
        address: this.contract,
        abi,
        functionName: "ownerOf",
        args: [tokenId],
      });
      if (getAddress(owner) === this.address)
        owned.push({
          tokenId: tokenId.toString(),
          hash: o.tx_hash!,
          verifiedAt: now(),
        });
    }
    this.base = {
      wei: wei.toString(),
      block: block.toString(),
      observedAt: now(),
    };
    this.nfts = owned;
  }
}
