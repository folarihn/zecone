import {
  network,
  chainHex,
  parseChain,
  validateAddChain,
} from "../evm/networks.ts";
import { READ_METHODS, readParams } from "./read-rpc.ts";
import { adapterFor } from "../evm/adapter.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { exclusiveJson, readJson } from "../execution/io.ts";
import { type Session, ApiError } from "./security.ts";
import type { Purchases } from "../marketplace/service.ts";
import type { IntentReviews, Scope } from "./transaction-intents.ts";
import type { IntentCheckout, IntentContext } from "./intent-checkout.ts";
import { uuid, requireApproval } from "./engine.ts";
import {
  DAPP_CHAIN,
  RpcError,
  originOf,
  rpcParams,
  transaction,
  message,
  typedMessage,
  describeCall,
} from "./dapp-policy.ts";
const exec = promisify(execFile);
export const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Row = {
  id: string;
  channel: string;
  origin: string;
  session: string;
  method: string;
  params: string;
  fingerprint: string;
  review: string;
  review_hash: string;
  state: string;
  result: string | null;
  error: string | null;
  expires: number;
  tx_hash: Hex | null;
  created: number;
};
type CheckoutSession = Session | (() => Session);
export class Dapps {
  db: DatabaseSync;
  public = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org", {
      timeout: 20000,
      retryCount: 1,
    }),
  });
  busy = false;
  constructor(
    readonly user: Address,
    path = ".state/dapps.sqlite",
    readonly purchases?: Purchases,
    readonly policy: {
      signingDisabled?: boolean;
      intents?: IntentReviews;
      checkoutPreview?: IntentCheckout;
    } = {},
  ) {
    if (
      policy.checkoutPreview &&
      (!policy.intents ||
        policy.signingDisabled !== true ||
        purchases !== undefined)
    )
      throw new RpcError(
        4200,
        "Dry-run checkout requires intent interception, disabled signing and no financial purchase service",
      );
    mkdirSync(".state", { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS origin_networks(origin TEXT PRIMARY KEY,chain_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS permissions(origin TEXT PRIMARY KEY,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,origin TEXT NOT NULL,session TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,channel TEXT NOT NULL,origin TEXT NOT NULL,session TEXT NOT NULL,method TEXT NOT NULL,params TEXT NOT NULL,fingerprint TEXT NOT NULL,review TEXT NOT NULL,review_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT,expires INTEGER NOT NULL,tx_hash TEXT,created INTEGER NOT NULL);`);
    this.db
      .prepare(
        "UPDATE requests SET state='review',error='Interrupted signing: reconcile saved transaction; no automatic re-signing.' WHERE state='signing'",
      )
      .run();
  }
  selected(origin: string): number {
    return Number(
      (
        this.db
          .prepare("SELECT chain_id FROM origin_networks WHERE origin=?")
          .get(origin) as any
      )?.chain_id ?? 84532,
    );
  }
  async checkNetwork(id: number) {
    await adapterFor(id).health();
  }
  client(id: number) {
    return id === 84532 ? this.public : adapterFor(id).client;
  }
  row(id: string) {
    return this.db.prepare("SELECT * FROM requests WHERE id=?").get(id) as
      Row | undefined;
  }
  permitted(origin: string) {
    return !!this.db
      .prepare("SELECT origin FROM permissions WHERE origin=?")
      .get(origin);
  }
  intentScope(s: Session, r: Pick<Row, "channel" | "origin">): Scope {
    return {
      session: s.id,
      channel: r.channel,
      origin: r.origin,
      account: this.user,
      chainId: this.selected(r.origin),
      permitted: this.permitted(r.origin),
      expires: s.expires,
    };
  }
  checkoutContext(source: CheckoutSession, id: string): IntentContext {
    return () => {
      const s = typeof source === "function" ? source() : source;
      requireApproval(s, true);
      const r = this.row(uuid(id));
      if (
        !r ||
        r.session !== s.id ||
        r.method !== "eth_sendTransaction" ||
        r.state !== "rejected"
      )
        throw new RpcError(4100, "Consented preview required");
      const review = JSON.parse(r.review);
      if (
        !this.policy.checkoutPreview ||
        review.previewConsent?.scope !== "preview-only" ||
        review.intent?.approval !== "consented-preview-only" ||
        digest(review) !== r.review_hash
      )
        throw new RpcError(4100, "Exact preview consent required");
      return {
        scope: this.intentScope(s, r),
        intent: review.intent,
        params: JSON.parse(r.params),
      };
    };
  }
  nativeTransferContext(source: CheckoutSession, id: string): IntentContext {
    return () => {
      const s = typeof source === "function" ? source() : source;
      requireApproval(s, true);
      const r = this.row(uuid(id));
      if (
        !this.policy.signingDisabled ||
        !this.policy.intents ||
        !r ||
        r.session !== s.id ||
        r.method !== "eth_sendTransaction" ||
        r.state !== "rejected" ||
        r.expires <= Date.now()
      )
        throw new RpcError(4100, "Explicit preview consent required");
      const review = JSON.parse(r.review);
      if (
        review.intent?.approval !== "consented-preview-only" ||
        digest(review) !== r.review_hash
      )
        throw new RpcError(4100, "Exact preview consent required");
      return {
        scope: this.intentScope(s, r),
        intent: review.intent,
        params: JSON.parse(r.params),
      };
    };
  }
  quoteIntent(s: CheckoutSession, id: string) {
    if (!this.policy.checkoutPreview)
      throw new RpcError(4200, "Checkout preview unavailable");
    return this.policy.checkoutPreview.quote(this.checkoutContext(s, id));
  }
  reviewIntentQuote(
    s: CheckoutSession,
    id: string,
    quoteId: string,
    quoteDigest: string,
    approved: unknown,
  ) {
    if (!this.policy.checkoutPreview)
      throw new RpcError(4200, "Checkout preview unavailable");
    return this.policy.checkoutPreview.review(
      this.checkoutContext(s, id),
      uuid(quoteId),
      quoteDigest,
      approved,
    );
  }
  createIntentCheckoutPreview(
    s: CheckoutSession,
    id: string,
    quoteId: string,
    quoteDigest: string,
    approved: unknown,
  ) {
    if (!this.policy.checkoutPreview)
      throw new RpcError(4200, "Checkout preview unavailable");
    return this.policy.checkoutPreview.create(
      this.checkoutContext(s, id),
      uuid(quoteId),
      quoteDigest,
      approved,
    );
  }
  intentCheckoutStatus(s: CheckoutSession, id: string) {
    if (!this.policy.checkoutPreview)
      throw new RpcError(4200, "Checkout preview unavailable");
    return this.policy.checkoutPreview.status(this.checkoutContext(s, id));
  }
  list() {
    return {
      networks: this.db
        .prepare("SELECT origin,chain_id AS chainId FROM origin_networks")
        .all(),
      connections: this.db
        .prepare("SELECT origin,created FROM permissions ORDER BY created DESC")
        .all(),
      requests: (
        this.db
          .prepare(
            "SELECT * FROM requests WHERE json_extract(review,'$.intent') IS NULL ORDER BY created DESC LIMIT 100",
          )
          .all() as Row[]
      ).map((r) => ({
        id: r.id,
        origin: r.origin,
        method: r.method,
        state: r.state,
        txHash: r.tx_hash,
        error: r.error,
        created: r.created,
        chainId: JSON.parse(r.review).chainId ?? 84532,
      })),
    };
  }
  revoke(origin: string) {
    originOf(origin);
    for (const r of this.db
      .prepare(
        "SELECT id FROM requests WHERE origin=? AND method='zecone_payWithZec' AND state='pending'",
      )
      .all(origin))
      this.purchases?.cancelDraft(String(r.id));
    this.db.prepare("DELETE FROM permissions WHERE origin=?").run(origin);
    // Reconnection is account permission only; it cannot revive old preview or
    // quote consent. This touches preview records, never financial orders.
    this.db
      .prepare(
        "UPDATE requests SET review=json_set(review,'$.intent.approval','cancelled'),state='rejected',error='Connection revoked; request fresh intent consent' WHERE origin=? AND json_type(review,'$.intent')='object'",
      )
      .run(origin);
    this.db
      .prepare(
        "UPDATE requests SET state='rejected',error='Connection revoked' WHERE origin=? AND state IN ('pending','preparing')",
      )
      .run(origin);
  }
  bind(s: Session, channel: string, origin: string) {
    requireApproval(s, true);
    uuid(channel);
    originOf(origin);
    const old = this.db
      .prepare("SELECT * FROM channels WHERE id=?")
      .get(channel) as { origin: string; session: string } | undefined;
    if (old && (old.origin !== origin || old.session !== s.id))
      throw new RpcError(4100, "Channel origin or session mismatch");
    this.db
      .prepare("INSERT OR IGNORE INTO channels VALUES(?,?,?)")
      .run(channel, origin, s.id);
  }
  response(r: Row) {
    if (r.state === "done")
      return { done: true, result: JSON.parse(r.result!) };
    if (["rejected", "error", "expired"].includes(r.state)) {
      const intent = JSON.parse(r.review).intent;
      const config = this.policy.checkoutPreview?.adapter.config;
      const checkoutCandidate =
        config &&
        r.origin === config.market.origin &&
        intent?.approval === "consented-preview-only" &&
        intent?.operation === "nft-purchase" &&
        intent.support?.recognized === true &&
        intent.destination?.chainId === "eip155:84532" &&
        typeof intent.target === "string" &&
        intent.target.toLowerCase() === config.market.marketplace.toLowerCase();
      return {
        ...(checkoutCandidate ? { previewConsentRecorded: true } : {}),
        done: true,
        error: {
          code: r.state === "rejected" ? 4001 : -32603,
          message: r.error ?? "Request expired",
        },
      };
    }
    return {
      done: false,
      id: r.id,
      state: r.state,
      origin: r.origin,
      method: r.method,
      review: JSON.parse(r.review),
      reviewHash: r.review_hash,
      expires: r.expires,
      txHash: r.tx_hash,
      error: r.error,
    };
  }
  status(s: Session, id: string) {
    const r = this.row(uuid(id));
    if (!r || r.session !== s.id)
      throw new RpcError(4100, "Request session mismatch");
    if (r.state === "pending" && r.expires <= Date.now()) {
      if (r.method === "zecone_payWithZec") this.purchases?.cancelDraft(id);
      this.db
        .prepare(
          "UPDATE requests SET state='expired',error='Approval expired' WHERE id=?",
        )
        .run(id);
    }
    return this.response(this.row(id)!);
  }
  async request(s: Session, input: Record<string, unknown>) {
    const channel = uuid(input.channel),
      id = uuid(input.id),
      origin = originOf(input.origin);
    this.bind(s, channel, origin);
    const method = input.method;
    if (typeof method !== "string" || method.length > 80)
      throw new RpcError(-32600, "Invalid method");
    if (
      this.policy.checkoutPreview &&
      ["personal_sign", "eth_signTypedData_v4", "zecone_payWithZec"].includes(
        method,
      )
    )
      throw new RpcError(
        4200,
        "Signing and financial purchase methods are unavailable in checkout rehearsal mode",
      );
    const p = rpcParams(input.params ?? []),
      fingerprint = digest({ channel, origin, method, p });
    const old = this.row(id);
    if (old) {
      if (old.fingerprint !== fingerprint || old.session !== s.id)
        throw new RpcError(4100, "Request ID replay with different payload");
      return this.status(s, id);
    }
    const allowed = this.permitted(origin),
      chainId = this.selected(origin),
      policy = network(chainId);
    if (method === "zecone_getPurchaseStatus") {
      if (!allowed || !this.purchases)
        throw new RpcError(4100, "Connect the marketplace first");
      if (p.length !== 1 || typeof p[0] !== "string")
        throw new RpcError(-32602, "Purchase reference required");
      return {
        done: true,
        result: this.purchases.externalStatus(origin, uuid(p[0])),
      };
    }
    if (method === "eth_chainId") {
      if (p.length) throw new RpcError(-32602, "No parameters");
      return { done: true, result: chainHex(chainId) };
    }
    if (method === "eth_accounts") {
      if (p.length) throw new RpcError(-32602, "No parameters");
      return { done: true, result: allowed ? [this.user] : [] };
    }
    if (READ_METHODS.includes(method)) {
      if (!allowed) throw new RpcError(4100, "Connect before RPC reads");
      const params = readParams(method, p);
      if (method === "net_version")
        return { done: true, result: String(chainId) };
      const client = this.client(chainId);
      if ((await client.getChainId()) !== chainId)
        throw new RpcError(4901, "RPC chain mismatch");
      try {
        return {
          done: true,
          result: await client.request({ method, params } as any),
        };
      } catch {
        throw new RpcError(-32603, "Configured testnet RPC read unavailable");
      }
    }
    let targetNetwork: ReturnType<typeof network> | undefined;
    if (
      ["wallet_switchEthereumChain", "wallet_addEthereumChain"].includes(method)
    ) {
      if (!allowed) throw new RpcError(4100, "Connect the application first");
      try {
        if (p.length !== 1) throw Error();
        if (method === "wallet_addEthereumChain")
          targetNetwork = validateAddChain(p[0]);
        else {
          if (
            !p[0] ||
            typeof p[0] !== "object" ||
            Object.keys(p[0]).length !== 1
          )
            throw Error();
          targetNetwork = parseChain((p[0] as any).chainId);
        }
      } catch {
        throw new RpcError(
          method === "wallet_switchEthereumChain" ? 4901 : 4902,
          "Only exact configured testnets are accepted",
        );
      }
    }
    if (method === "wallet_revokePermissions") {
      if (!allowed) throw new RpcError(4100, "Not connected");
      this.revoke(origin);
      return { done: true, result: null };
    }
    if (
      ![
        "wallet_switchEthereumChain",
        "wallet_addEthereumChain",
        "eth_requestAccounts",
        "personal_sign",
        "eth_signTypedData_v4",
        "eth_sendTransaction",
        "zecone_payWithZec",
      ].includes(method)
    )
      throw new RpcError(4200, "Unsupported RPC method");
    if (method !== "eth_requestAccounts" && !allowed)
      throw new RpcError(4100, "Account access has not been approved");
    if (method === "eth_requestAccounts" && p.length)
      throw new RpcError(-32602, "No parameters");
    if (method === "eth_requestAccounts" && allowed)
      return { done: true, result: [this.user] };
    const active = this.db
      .prepare(
        "SELECT count(*) n FROM requests WHERE state IN ('pending','preparing','signing')",
      )
      .get() as { n: number };
    if (active.n >= 8) throw new RpcError(-32002, "Too many pending requests");
    let review: any = { account: this.user, chainId, networkName: policy.name };
    if (targetNetwork)
      review = {
        ...review,
        targetChainId: targetNetwork.id,
        targetNetwork: targetNetwork.name,
        rpc: targetNetwork.rpc,
        warning:
          "Approve this network configuration. Switching invalidates other pending requests for this origin.",
      };
    if (method === "zecone_payWithZec") {
      if (!this.purchases)
        throw new RpcError(4200, "Marketplace funding is unavailable");
      review = await this.purchases.review(s, origin, id, p, chainId);
    }
    if (method === "personal_sign") {
      const raw = message(p, this.user);
      review = {
        ...review,
        raw,
        text: Buffer.from(raw.slice(2), "hex").toString("utf8"),
        warning:
          "A message signature may authorize login, orders or asset access. Only sign content you understand. It is not necessarily harmless.",
      };
    }
    if (method === "eth_signTypedData_v4")
      review = {
        ...review,
        typedData: typedMessage(p, this.user, chainId),
        warning:
          "Typed signatures can grant spending permissions or authorize external orders. Check domain, spender, amount, nonce and expiry. The external protocol controls replay protection.",
      };
    if (method === "eth_sendTransaction")
      review = { ...review, ...transaction(p, this.user, chainId) };
    if (method === "eth_sendTransaction" && this.policy.intents)
      review = {
        ...review,
        intent: await this.policy.intents.prepare(
          this.intentScope(s, { channel, origin }),
          id,
          p,
        ),
        warning:
          "Non-executing intent preview. Consent cannot sign, pay or broadcast.",
      };
    const expires = Date.now() + 300000;
    this.db
      .prepare("INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        channel,
        origin,
        s.id,
        method,
        JSON.stringify(p),
        fingerprint,
        JSON.stringify(review),
        digest(review),
        method === "eth_sendTransaction" && !review.intent
          ? "preparing"
          : "pending",
        null,
        null,
        expires,
        null,
        Date.now(),
      );
    if (method === "eth_sendTransaction" && !review.intent) {
      try {
        const client = this.client(chainId);
        if ((await client.getChainId()) !== chainId) throw Error("Wrong chain");
        const call = {
          account: this.user,
          to: review.to as Address,
          data: review.data as Hex,
          value: BigInt(review.value),
        };
        await client.call(call);
        const [estimated, fees, nonce] = await Promise.all([
          client.estimateGas(call),
          client.estimateFeesPerGas(),
          client.getTransactionCount({
            address: this.user,
            blockTag: "pending",
          }),
        ]);
        const gas = (estimated * 12n) / 10n + 1n;
        if (
          gas > policy.maxGas ||
          fees.maxFeePerGas > policy.maxFee ||
          gas * fees.maxFeePerGas + policy.dataReserve > 5000000000000000n
        )
          throw Error("Fee cap");
        review = {
          ...review,
          nonce,
          gas: gas.toString(),
          estimatedGas: estimated.toString(),
          maxFeePerGas: fees.maxFeePerGas.toString(),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
          executionFeeCapWei: (
            gas * fees.maxFeePerGas +
            policy.dataReserve
          ).toString(),
          ...describeCall(review.data),
          simulation: `eth_call and gas estimation succeeded. State can change. Fee model: ${policy.feeModel}. Simulation does not guarantee safety.`,
        };
        this.db
          .prepare(
            "UPDATE requests SET review=?,review_hash=?,state='pending' WHERE id=? AND state='preparing'",
          )
          .run(JSON.stringify(review), digest(review), id);
      } catch {
        this.db
          .prepare(
            "UPDATE requests SET state='error',error='Simulation or fee preparation failed. No transaction was signed.' WHERE id=? AND state='preparing'",
          )
          .run(id);
      }
    }
    return this.status(s, id);
  }
  async approve(s: Session, id: string, reviewHash: string, approved: unknown) {
    requireApproval(s, true);
    const r = this.row(uuid(id));
    if (!r || r.session !== s.id)
      throw new RpcError(4100, "Request session mismatch");
    if (approved === false) {
      const review = JSON.parse(r.review);
      if (review.intent && r.state === "pending") {
        try {
          this.policy.intents?.consent(
            this.intentScope(s, r),
            id,
            review.intent.requestDigest,
            false,
          );
        } catch {
          /* Expired/restarted previews still permit cancellation, never execution. */
        }
        review.intent.approval = "cancelled";
        this.db
          .prepare(
            "UPDATE requests SET review=?,review_hash=? WHERE id=? AND state='pending'",
          )
          .run(JSON.stringify(review), digest(review), id);
      }
      if (r.method === "zecone_payWithZec" && r.state === "pending")
        this.purchases?.cancelDraft(id);
      this.db
        .prepare(
          "UPDATE requests SET state='rejected',error='User rejected request' WHERE id=? AND state='pending'",
        )
        .run(id);
      return this.status(s, id);
    }
    if (
      approved !== true ||
      reviewHash !== r.review_hash ||
      r.expires <= Date.now() ||
      s.expires <= Date.now()
    )
      throw new RpcError(4001, "Exact approval required before expiry");
    if (r.method !== "eth_requestAccounts" && !this.permitted(r.origin))
      throw new RpcError(4100, "Connection revoked");
    if (r.state !== "pending") return this.status(s, id);
    // Persisted preview marker remains non-executing even after restart without
    // the opt-in policy. Never return intent JSON as an EIP-1193 transaction hash.
    if (JSON.parse(r.review).intent) {
      if (!this.policy.intents)
        throw new RpcError(
          4001,
          "Preview session ended; request a new preview",
        );
      const review = JSON.parse(r.review),
        preview = review.intent;
      review.intent = this.policy.intents.consent(
        this.intentScope(s, r),
        id,
        preview.requestDigest,
        true,
      );
      review.previewConsent = {
        reviewHash: r.review_hash,
        at: Date.now(),
        scope: "preview-only",
      };
      this.db
        .prepare(
          "UPDATE requests SET review=?,review_hash=?,state='rejected',error='Preview consent recorded; execution is unavailable. No transaction was signed.' WHERE id=? AND state='pending'",
        )
        .run(JSON.stringify(review), digest(review), id);
      return this.status(s, id);
    }
    if (
      this.policy.signingDisabled &&
      [
        "personal_sign",
        "eth_signTypedData_v4",
        "eth_sendTransaction",
        "zecone_payWithZec",
      ].includes(r.method)
    )
      throw new RpcError(
        4001,
        "Rejection-only validation: signing and broadcasts disabled",
      );
    const selected = JSON.parse(r.review).chainId ?? 84532;
    if (this.selected(r.origin) !== selected)
      throw new RpcError(4901, "Selected network changed; request again");
    if (
      r.method === "eth_sendTransaction" &&
      this.db
        .prepare(
          "SELECT id FROM requests WHERE method='eth_sendTransaction' AND (state IN ('signing','review') OR (tx_hash IS NOT NULL AND state='done')) AND error IS NULL AND COALESCE(json_extract(review,'$.chainId'),84532)=? LIMIT 1",
        )
        .get(selected)
    )
      throw new RpcError(
        -32002,
        "Reconcile the previous EVM transaction before signing another",
      );
    const changed = this.db
      .prepare(
        "UPDATE requests SET state='signing' WHERE id=? AND state='pending'",
      )
      .run(id);
    if (changed.changes !== 1)
      throw new RpcError(-32002, "Request already handled");
    try {
      let result: unknown;
      if (r.method === "eth_requestAccounts") {
        this.db
          .prepare("INSERT OR IGNORE INTO permissions VALUES(?,?)")
          .run(r.origin, Date.now());
        result = [this.user];
      } else if (
        ["wallet_switchEthereumChain", "wallet_addEthereumChain"].includes(
          r.method,
        )
      ) {
        const target = network(JSON.parse(r.review).targetChainId);
        await this.checkNetwork(target.id);
        if (r.method === "wallet_switchEthereumChain") {
          this.db
            .prepare(
              "INSERT INTO origin_networks VALUES(?,?) ON CONFLICT(origin) DO UPDATE SET chain_id=excluded.chain_id",
            )
            .run(r.origin, target.id);
          for (const other of this.db
            .prepare(
              "SELECT id,method FROM requests WHERE origin=? AND state='pending' AND id!=?",
            )
            .all(r.origin, id)) {
            if (other.method === "zecone_payWithZec")
              this.purchases?.cancelDraft(String(other.id));
          }
          this.db
            .prepare(
              "UPDATE requests SET state='rejected',error='Network changed; review a new request' WHERE origin=? AND state IN ('pending','preparing') AND id!=?",
            )
            .run(r.origin, id);
        }
        result = null;
      } else if (r.method === "zecone_payWithZec") {
        if (!this.purchases) throw Error("Marketplace unavailable");
        result = await this.purchases.approve(s, id);
      } else {
        const path = resolve(".state/dapp-approvals", `${id}.json`);
        exclusiveJson(path, {
          id,
          origin: r.origin,
          method: r.method,
          approved: true,
          expires: Math.min(r.expires, s.expires),
          review: JSON.parse(r.review),
          reviewHash: r.review_hash,
        });
        const { stdout } = await exec(
          process.execPath,
          ["--import", "tsx", "scripts/local-dapp-sign.ts", path],
          { timeout: 90000, maxBuffer: 100000, windowsHide: true },
        );
        const signed = JSON.parse(stdout) as { signature?: Hex; hash?: Hex };
        if (signed.hash) {
          this.db
            .prepare("UPDATE requests SET tx_hash=? WHERE id=?")
            .run(signed.hash, id);
          const saved = readJson<{ raw: Hex; hash: Hex }>(
            path.replace(/\.json$/, ".signed.json"),
          );
          if (keccak256(saved.raw) !== signed.hash)
            throw Error("Hash mismatch");
          if ((await this.client(selected).getChainId()) !== selected)
            throw Error("Wrong chain");
          const hash = await this.client(selected).sendRawTransaction({
            serializedTransaction: saved.raw,
          });
          if (hash !== signed.hash) throw Error("Hash mismatch");
          result = hash;
        } else {
          if (!signed.signature) throw Error("Missing signature");
          result = signed.signature;
        }
      }
      this.db
        .prepare("UPDATE requests SET state='done',result=? WHERE id=?")
        .run(JSON.stringify(result), id);
    } catch {
      this.db
        .prepare(
          "UPDATE requests SET state='review',error='Signing or broadcast interrupted. Reconcile the saved request; do not create a replacement transaction.' WHERE id=?",
        )
        .run(id);
    }
    return this.status(s, id);
  }
  async reconcile() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.purchases) {
        for (const request of this.db
          .prepare(
            "SELECT id FROM requests WHERE method='zecone_payWithZec' AND state='review'",
          )
          .all()) {
          const id = String(request.id),
            saved = this.purchases.store.row(id);
          if (saved?.order_id)
            this.db
              .prepare(
                "UPDATE requests SET state='done',result=?,error=NULL WHERE id=? AND state='review'",
              )
              .run(JSON.stringify({ purchaseId: id }), id);
        }
      }

      const rows = this.db
        .prepare(
          "SELECT * FROM requests WHERE method='eth_sendTransaction' AND state IN ('done','review')",
        )
        .all() as Row[];
      for (const r of rows) {
        const chainId = JSON.parse(r.review).chainId ?? 84532,
          client = this.client(chainId),
          policy = network(chainId);
        if ((await client.getChainId()) !== chainId) continue;
        const file = resolve(".state/dapp-approvals", `${r.id}.signed.json`);
        if (!existsSync(file)) {
          if (r.state === "review" && !r.tx_hash)
            this.db
              .prepare(
                "UPDATE requests SET state='error',error='No signed transaction was persisted. This request is closed safely; create a new request if still needed.' WHERE id=?",
              )
              .run(r.id);
          continue;
        }
        const saved = readJson<{ raw: Hex; hash: Hex }>(file);
        if (keccak256(saved.raw) !== saved.hash) continue;
        this.db
          .prepare("UPDATE requests SET tx_hash=? WHERE id=?")
          .run(saved.hash, r.id);
        const receipt = await client
          .getTransactionReceipt({ hash: saved.hash })
          .catch(() => null);
        const previouslyConfirmed = r.error?.startsWith("Confirmed") ?? false;
        if (!receipt) {
          if (previouslyConfirmed)
            this.db
              .prepare(
                "UPDATE requests SET state='review',error='Previously confirmed receipt is now missing; possible chain reorganization. Verify canonical history manually; no replacement transaction was sent.' WHERE id=?",
              )
              .run(r.id);
          continue;
        }
        const head = await client.getBlockNumber();
        if (head - receipt.blockNumber + 1n < BigInt(policy.confirmations)) {
          if (previouslyConfirmed)
            this.db
              .prepare(
                "UPDATE requests SET state='review',error='Previously confirmed transaction fell below its confirmation threshold; possible chain reorganization. Inspect the canonical chain; no replacement was sent.' WHERE id=?",
              )
              .run(r.id);
          continue;
        }
        const canonical = await client.getBlock({
          blockNumber: receipt.blockNumber,
        });
        if (
          /^0x0+$/.test(receipt.blockHash) ||
          canonical.hash !== receipt.blockHash
        ) {
          if (previouslyConfirmed)
            this.db
              .prepare(
                "UPDATE requests SET state='review',error='Previously confirmed transaction block is no longer canonical; possible chain reorganization. Inspect the canonical chain; no replacement was sent.' WHERE id=?",
              )
              .run(r.id);
          continue;
        }
        this.db
          .prepare(
            "UPDATE requests SET state='done',result=?,error=? WHERE id=?",
          )
          .run(
            JSON.stringify(saved.hash),
            receipt.status === "success"
              ? `Confirmed (${policy.confirmations}+ blocks)`
              : "Confirmed revert — gas was spent",
            r.id,
          );
      }
    } catch {
      /* RPC failure never invents a receipt. */
    } finally {
      this.busy = false;
    }
  }
}
