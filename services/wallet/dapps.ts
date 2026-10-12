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
  ) {
    mkdirSync(".state", { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS permissions(origin TEXT PRIMARY KEY,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,origin TEXT NOT NULL,session TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,channel TEXT NOT NULL,origin TEXT NOT NULL,session TEXT NOT NULL,method TEXT NOT NULL,params TEXT NOT NULL,fingerprint TEXT NOT NULL,review TEXT NOT NULL,review_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT,expires INTEGER NOT NULL,tx_hash TEXT,created INTEGER NOT NULL);`);
    this.db
      .prepare(
        "UPDATE requests SET state='review',error='Interrupted signing: reconcile saved transaction; no automatic re-signing.' WHERE state='signing'",
      )
      .run();
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
  list() {
    return {
      connections: this.db
        .prepare("SELECT origin,created FROM permissions ORDER BY created DESC")
        .all(),
      requests: (
        this.db
          .prepare("SELECT * FROM requests ORDER BY created DESC LIMIT 100")
          .all() as Row[]
      ).map((r) => ({
        id: r.id,
        origin: r.origin,
        method: r.method,
        state: r.state,
        txHash: r.tx_hash,
        error: r.error,
        created: r.created,
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
    if (["rejected", "error", "expired"].includes(r.state))
      return {
        done: true,
        error: {
          code: r.state === "rejected" ? 4001 : -32603,
          message: r.error ?? "Request expired",
        },
      };
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
    const p = rpcParams(input.params ?? []),
      fingerprint = digest({ channel, origin, method, p });
    const old = this.row(id);
    if (old) {
      if (old.fingerprint !== fingerprint || old.session !== s.id)
        throw new RpcError(4100, "Request ID replay with different payload");
      return this.status(s, id);
    }
    const allowed = this.permitted(origin);
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
      return { done: true, result: DAPP_CHAIN };
    }
    if (method === "eth_accounts") {
      if (p.length) throw new RpcError(-32602, "No parameters");
      return { done: true, result: allowed ? [this.user] : [] };
    }
    if (method === "wallet_switchEthereumChain") {
      if (
        p.length !== 1 ||
        !p[0] ||
        typeof p[0] !== "object" ||
        Object.keys(p[0]).length !== 1 ||
        (p[0] as any).chainId !== DAPP_CHAIN
      )
        throw new RpcError(4901, "Only Base Sepolia is supported");
      if (!allowed) throw new RpcError(4100, "Connect the application first");
      return { done: true, result: null };
    }
    if (method === "wallet_revokePermissions") {
      if (!allowed) throw new RpcError(4100, "Not connected");
      this.revoke(origin);
      return { done: true, result: null };
    }
    if (
      ![
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
    let review: any = { account: this.user, chainId: 84532 };
    if (method === "zecone_payWithZec") {
      if (!this.purchases)
        throw new RpcError(4200, "Marketplace funding is unavailable");
      review = await this.purchases.review(s, origin, id, p);
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
        typedData: typedMessage(p, this.user),
        warning:
          "Typed signatures can grant spending permissions or authorize external orders. Check domain, spender, amount, nonce and expiry. The external protocol controls replay protection.",
      };
    if (method === "eth_sendTransaction")
      review = { ...review, ...transaction(p, this.user) };
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
        method === "eth_sendTransaction" ? "preparing" : "pending",
        null,
        null,
        expires,
        null,
        Date.now(),
      );
    if (method === "eth_sendTransaction") {
      try {
        if ((await this.public.getChainId()) !== 84532)
          throw Error("Wrong chain");
        const call = {
          account: this.user,
          to: review.to as Address,
          data: review.data as Hex,
          value: BigInt(review.value),
        };
        await this.public.call(call);
        const [estimated, fees, nonce] = await Promise.all([
          this.public.estimateGas(call),
          this.public.estimateFeesPerGas(),
          this.public.getTransactionCount({
            address: this.user,
            blockTag: "pending",
          }),
        ]);
        const gas = (estimated * 12n) / 10n + 1n;
        if (gas * fees.maxFeePerGas > 5000000000000000n) throw Error("Fee cap");
        review = {
          ...review,
          nonce,
          gas: gas.toString(),
          estimatedGas: estimated.toString(),
          maxFeePerGas: fees.maxFeePerGas.toString(),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
          executionFeeCapWei: (gas * fees.maxFeePerGas).toString(),
          ...describeCall(review.data),
          simulation:
            "eth_call and gas estimation succeeded. State can change. Simulation does not guarantee safety. Base L1 data fees are additional.",
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
    if (
      r.method === "eth_sendTransaction" &&
      this.db
        .prepare(
          "SELECT id FROM requests WHERE method='eth_sendTransaction' AND (state IN ('signing','review') OR (tx_hash IS NOT NULL AND state='done')) AND error IS NULL LIMIT 1",
        )
        .get()
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
          const hash = await this.public.sendRawTransaction({
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
      if ((await this.public.getChainId()) !== 84532) return;
      const rows = this.db
        .prepare(
          "SELECT * FROM requests WHERE method='eth_sendTransaction' AND state IN ('done','review')",
        )
        .all() as Row[];
      for (const r of rows) {
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
        const receipt = await this.public
          .getTransactionReceipt({ hash: saved.hash })
          .catch(() => null);
        if (!receipt) continue;
        const head = await this.public.getBlockNumber();
        if (head - receipt.blockNumber + 1n < 3n) continue;
        if (
          (await this.public.getBlock({ blockNumber: receipt.blockNumber }))
            .hash !== receipt.blockHash
        )
          continue;
        this.db
          .prepare(
            "UPDATE requests SET state='done',result=?,error=? WHERE id=?",
          )
          .run(
            JSON.stringify(saved.hash),
            receipt.status === "success"
              ? "Confirmed (3+ blocks)"
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
