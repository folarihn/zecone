// Manual operator CLI only. Never start this from a web endpoint or automatic worker.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { Accounts } from "../services/solana/accounts.ts";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { EncryptedAccounts } from "../services/solana/encrypted-accounts.ts";
import { WindowsUnlock } from "../services/solana/windows-unlock.ts";
import { swapBrowserView } from "../services/solana/privacy.ts";
import { phase7cRuntime } from "../services/solana/phase7c-runtime.ts";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
import { json, SolanaError } from "../services/solana/network.ts";
import { retireExpiredUnsignedSwap } from "../services/solana/swap-review.ts";
import {
  economicReview,
  checkEconomicReview,
  approvalDeadline,
  quoteDeadline,
  assertReviewCurrent,
} from "../services/solana/swap-approval.ts";
import { createInterface } from "node:readline/promises";
import { blockhash } from "@solana/kit";
import {
  authorizePaidPreparation,
  recoveryRecord,
  authorizeExactRecoveredTransaction,
  authorizeBoundedSettlement,
} from "../services/solana/paid-recovery.ts";
const x = phase7cRuntime(),
  { p, root, service, store } = x;
const id = `0x${(await import("../services/solana/transactions.ts")).digest(`phase7c:${p.id}:${p.orderId}`)}`;
async function freshScan(watch: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await new WatchOnlyZcash(watch).observe();
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
    }
  }
  throw Error("Fresh scan unavailable");
}
async function native(args: string[], seed?: Buffer): Promise<any> {
  return new Promise((yes, no) => {
    const child = spawn(
      resolve("target/debug/zecone-zcash.exe"),
      ["--wallet", join(root, "payer-native"), ...args],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let data = "";
    const timer = setTimeout(() => {
      child.kill();
      no(Error("Native timeout; preserve all claims"));
    }, 600000);
    child.stderr.resume();
    child.stdout.on("data", (b) => {
      data += b;
      if (data.length > 65536) {
        child.kill();
        no(Error("Native output limit"));
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      seed?.fill(0);
      no(Error("Native payment helper unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      seed?.fill(0);
      if (code !== 0)
        return no(Error("Native payment failed; no automatic retry"));
      try {
        yes(JSON.parse(data));
      } catch {
        no(Error("Invalid native result"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(seed, () => seed?.fill(0));
  });
}
function fundingInventory(watch: string, tip: number) {
  const db = new DatabaseSync(join(watch, "wallet.sqlite"), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT n.value FROM ironwood_received_notes n JOIN transactions t ON t.id_tx=n.transaction_id JOIN blocks b ON b.height=t.mined_height WHERE n.value>0 AND t.mined_height<=? AND n.nf IS NOT NULL AND n.commitment_tree_position IS NOT NULL AND n.lock_owner IS NULL AND NOT EXISTS(SELECT 1 FROM ironwood_received_note_spends s WHERE s.ironwood_received_note_id=n.id)",
      )
      .all(tip - 9)
      .reduce((n, i) => n + BigInt(String(i.value)), 0n);
  } finally {
    db.close();
  }
}
async function approvedExecution(
  hash: string,
  authority: "HUMAN_EXACT" | "BOUNDED_ORDER" = "HUMAN_EXACT",
) {
  if (
    !process.argv.includes("--allow-devnet-broadcast") ||
    !process.argv.includes("--unlock-local-dpapi")
  )
    throw Error("Explicit broadcast and local unlock flags required");
  service.eligible(id, true);
  const saved = service.row(id).prepared;
  if (!saved || JSON.parse(saved).digest !== hash)
    throw Error("Current exact digest required before unlock");
  assertReviewCurrent(JSON.parse(saved), service.now());
  if (
    !(await service.network.valid(
      blockhash(JSON.parse(saved).lifetime.blockhash),
    ))
  )
    throw new SolanaError("BLOCKHASH_EXPIRED");
  if (recoveryRecord(service, id))
    await authorizeExactRecoveredTransaction(
      service,
      id,
      hash,
      true,
      authority,
    );
  service.eligible(id);
  const accounts = new EncryptedAccounts(),
    unlock = new WindowsUnlock();
  try {
    if (p.relayerSource === "phase7b") {
      const prior = new Accounts();
      try {
        await prior.unlock("payer", true);
        return await service.execute(
          id,
          { orderId: id, digest: hash, approved: true },
          prior.signer(p.relayer),
        );
      } finally {
        prior.lock();
      }
    }
    await accounts.unlock(
      "relayer",
      await unlock.unlock("relayer", true),
      true,
    );
    return await service.execute(
      id,
      { orderId: id, digest: hash, approved: true },
      accounts.signer("relayer"),
    );
  } finally {
    accounts.lock();
  }
}
async function refreshedUnsigned() {
  const previous = service.row(id).prepared;
  if (previous) {
    const saved = JSON.parse(previous);
    if (
      quoteDeadline(saved) <= service.now() ||
      !(await service.network.valid(blockhash(saved.lifetime.blockhash)))
    )
      await retireExpiredUnsignedSwap(service, id, true);
  }
  return service.prepare(id);
}
function exactReview(prepared: any) {
  const original = service.intent(id);
  return {
    network: "solana:devnet",
    relayer: original.relayer,
    recipient: original.recipient,
    swap: prepared.swap,
    currentQuotedOutput: prepared.quotedOutput ?? prepared.swap.expectedOut,
    exactTransactionBase64: prepared.wire,
    digest: prepared.digest,
    simulated: prepared.simulation,
    estimatedFee: prepared.fee,
    feeCap: "10000",
    rentCap: "6000000",
    maximumDebit: "7010000",
    quoteExpiresAt: quoteDeadline(prepared),
    userApprovalExpiresAt: approvalDeadline(prepared),
    lifetime: prepared.lifetime,
    blockhashValidityIsChainEnforced: true,
    approvalCarriesToReplacement: false,
    liveRefundsEnabled: false,
  };
}
try {
  const command = process.argv[2];
  let result: unknown;
  const quote = async () =>
    service.quote(
      {
        profileId: p.id,
        requestId: p.orderId,
        recipient: p.recipient,
        relayer: p.relayer,
        lamports: "1000000",
        account: x.manifest.keyId,
        paymentAddress: x.manifest.address,
      },
      await x.policy.terms(),
    );
  if (command === "attach-history") {
    if (!process.argv.includes("--allow-local-history-recovery"))
      throw Error("Explicit local history recovery required");
    const sessions = new DatabaseSync(".state/phase7c/browser/browser.sqlite", {
      readOnly: true,
    });
    const active = sessions
      .prepare("SELECT id FROM sessions WHERE connected=1 AND expires>?")
      .all(Date.now());
    sessions.close();
    if (active.length !== 1)
      throw Error("Pair and verify exactly one local browser session first");
    store.atomic(() => {
      const handle = randomBytes(24).toString("hex");
      store.db
        .prepare("DELETE FROM swap_history_handles WHERE order_id=?")
        .run(id);
      store.db
        .prepare("INSERT INTO swap_history_handles VALUES(?,?,?)")
        .run(handle, String(active[0].id), id);
      store.event(
        id,
        "operator_history_reattached",
        { handlesRotated: true },
        service.now(),
      );
    });
    result = {
      historyReattached: true,
      oldHandlesRevoked: true,
      noBroadcast: true,
    };
  } else if (command === "inspect-paid-recovery") {
    const row = service.row(id),
      order = store.get(id)!;
    result = {
      orderId: id,
      state: row.state,
      orderState: order.state,
      originalDeadline: service.intent(id).expiry,
      recipient: p.recipient,
      swap: service.intent(id).swap,
      signingClaim: row.claimed,
      signature: row.signature,
      signedWireExists: !!row.wire,
      confirmations: service.view(id).confirmations,
      confirmedZatoshis: service.view(id).confirmedZatoshis,
      reasons: store.db
        .prepare("SELECT reason,status FROM recoveries WHERE order_id=?")
        .all(id),
      recovery: recoveryRecord(service, id)
        ? {
            scope: recoveryRecord(service, id)!.scope,
            prepareUntil: recoveryRecord(service, id)!.prepare_until,
          }
        : null,
      noSigningKeysLoaded: true,
    };
  } else if (command === "authorize-paid-recovery") {
    if (process.argv[3] !== id)
      throw Error("Exact persisted original order identifier required");
    const grant = await authorizePaidPreparation(
      service,
      id,
      process.argv[4] ?? "",
      process.argv.includes("--user-authorized-preparation"),
      await freshScan(x.watch),
    );
    result = {
      orderId: id,
      attemptId: grant.attempt_id,
      scope: grant.scope,
      prepareUntil: grant.prepare_until,
      originalDeadline: service.intent(id).expiry,
      noSigningKeysLoaded: true,
      noBroadcast: true,
    };
  } else if (command === "recovery-rehearsal") {
    service.authorize(id, await freshScan(x.watch));
    const review = economicReview(service, id);
    const before = service.row(id).prepared;
    const prepared = await refreshedUnsigned();
    result = {
      noBroadcast: true,
      signingKeysLoaded: false,
      originalOrderRetained: true,
      economicReview: review,
      exactReview: exactReview(prepared),
      digestChanged: before
        ? JSON.parse(before).digest !== prepared.digest
        : true,
      confirmedZatoshis: service.view(id).confirmedZatoshis,
      confirmations: service.view(id).confirmations,
    };
  } else if (command === "execute-bounded-swap") {
    if (
      !process.argv.includes("--user-authorized-bounded-order") ||
      !process.argv.includes("--allow-devnet-broadcast") ||
      !process.argv.includes("--unlock-local-dpapi")
    )
      throw Error("Explicit scoped human execution authorization required");
    service.authorize(id, await freshScan(x.watch));
    await authorizeBoundedSettlement(
      service,
      id,
      JSON.parse(
        readFileSync(".state/phase7c/user-bounded-scope.private.json", "utf8"),
      ),
      true,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        service.authorize(id, await freshScan(x.watch));
        const prepared = await refreshedUnsigned();
        result = await approvedExecution(prepared.digest, "BOUNDED_ORDER");
        break; // A submission attempt is never automatically repeated.
      } catch (e) {
        const r = service.row(id);
        if (
          r.claimed ||
          r.wire ||
          r.signature ||
          !(e instanceof SolanaError) ||
          ![
            "BLOCKHASH_EXPIRED",
            "SWAP_QUOTE_EXPIRED",
            "USER_APPROVAL_EXPIRED",
          ].includes(e.code) ||
          attempt === 2
        )
          throw e;
      }
    }
  } else if (command === "review-swap") {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw Error("Local interactive terminal required; no piped approval");
    if (
      !process.argv.includes("--allow-devnet-broadcast") ||
      !process.argv.includes("--unlock-local-dpapi")
    )
      throw Error(
        "Explicit broadcast and unlock flags required; flags alone never approve",
      );
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      service.authorize(id, await freshScan(x.watch));
      const review = economicReview(service, id);
      console.log(json(review));
      const ready = await terminal.question(
        "Review these economic terms (30 minutes maximum). Type READY to prepare fresh bytes; READY does NOT authorize signing: ",
        {
          signal: AbortSignal.timeout(
            Math.max(1, (review.reviewUntil - service.now()) * 1000),
          ),
        },
      );
      if (ready !== "READY") throw Error("Cancelled without signing");
      service.authorize(id, await freshScan(x.watch));
      checkEconomicReview(service, id, review.termsDigest);
      const prepared = await refreshedUnsigned();
      console.log(json(exactReview(prepared)));
      const answer = await terminal.question(
        `Approve ONLY these bytes by typing APPROVE ${prepared.digest} (expiry needs a new review): `,
        {
          signal: AbortSignal.timeout(
            Math.max(
              1,
              (quoteDeadline(prepared as any) - service.now()) * 1000,
            ),
          ),
        },
      );
      if (answer !== `APPROVE ${prepared.digest}`)
        throw Error("Exact approval not supplied; no signing");
      service.authorize(id, await freshScan(x.watch));
      checkEconomicReview(service, id, review.termsDigest);
      result = await approvedExecution(prepared.digest);
    } finally {
      terminal.close();
    }
  } else if (command === "quote") result = await quote();
  else if (command === "status") result = service.view(id);
  else if (command === "funding-solana")
    result = {
      network: "solana:devnet",
      address: p.relayer,
      lamports: (await service.network.balance(p.relayer)).toString(),
      suggestedSOL: "0.02",
      fundingIsNotApproval: true,
    };
  else if (command === "funding") {
    const fundingWatch = join(
      root,
      p.payerSourceProfileId ? "payment-source-watch" : "payer-watch",
    );
    const s = await new WatchOnlyZcash(fundingWatch).observe();
    result = {
      network: s.network,
      suggestedTAZ: "0.002",
      fundingIsNotApproval: true,
      address: s.address,
      tip: s.tip,
      scanned: s.scanned,
      confirmedUnspentZatoshis: fundingInventory(
        fundingWatch,
        s.tip,
      ).toString(),
      source: s.source,
    };
  } else if (command === "prepare-payment") {
    const view = service.view(id);
    if (
      view.expires <= Math.floor(Date.now() / 1000) ||
      view.receivedZatoshis !== "0"
    )
      throw Error("Expired or paid order; no new payment");
    const sourceWatch = join(
      root,
      p.payerSourceProfileId ? "payment-source-watch" : "payer-watch",
    );
    const snap = await new WatchOnlyZcash(sourceWatch).observe();
    if (fundingInventory(sourceWatch, snap.tip) < 110000n)
      throw Error(
        "Selected payer requires mature unspent notes for 110000 zatoshis",
      );
    const birthday = JSON.parse(
      readFileSync(join(sourceWatch, "watch-only.json"), "utf8"),
    ).birthday;
    result = await native(
      [
        "prepare-phase7c-payment",
        "--profile-id",
        p.id,
        "--request-id",
        p.orderId,
        "--birthday",
        String(birthday),
      ],
      readFileSync(
        resolve(
          p.payerSourceProfileId ? ".secrets/phase7b" : ".secrets/phase7c",
          p.payerSourceProfileId ?? p.id,
          "payer/isolated-seed.bin",
        ),
      ),
    );
  } else if (command === "broadcast-payment") {
    const approved = process.argv[3];
    if (
      !/^[a-f0-9]{64}$/.test(approved ?? "") ||
      !process.argv.includes("--allow-testnet-broadcast")
    )
      throw Error("Explicit exact transaction approval required");
    const view = service.view(id);
    if (
      view.expires <= Math.floor(Date.now() / 1000) ||
      view.receivedZatoshis !== "0"
    )
      throw Error("Order expired or already paid");
    result = await native([
      "broadcast-phase7c-payment",
      "--profile-id",
      p.id,
      "--request-id",
      p.orderId,
      "--approved-txid",
      approved,
      "--allow-testnet-broadcast",
    ]);
  } else if (command === "observe")
    result = service.authorize(id, await freshScan(x.watch));
  else if (command === "retire-expired-unsigned") {
    service.authorize(id, await freshScan(x.watch));
    await retireExpiredUnsignedSwap(
      service,
      id,
      process.argv.includes("--review-expired-unsigned"),
    );
    result = { noBroadcast: true, newExactApprovalRequired: true };
  } else if (command === "prepare-solana") {
    service.authorize(id, await freshScan(x.watch));
    result = await service.prepare(id);
    const prepared = result as any;
    result = {
      ...service.view(id),
      simulation: prepared.simulation,
      approvalDigest: prepared.digest,
      approvalExpiresAt: approvalDeadline(prepared),
      quoteExpiresAt: quoteDeadline(prepared),
    };
  } else if (command === "broadcast-solana") {
    const hash = process.argv[3];
    if (
      !/^[a-f0-9]{64}$/.test(hash ?? "") ||
      !process.argv.includes("--allow-devnet-broadcast")
    )
      throw Error("Explicit exact Solana digest approval required");
    service.authorize(id, await freshScan(x.watch));
    result = await approvedExecution(hash);
  } else if (command === "reconcile") result = await service.reconcile(id);
  else
    throw Error(
      "Use quote, status, funding, prepare-payment, broadcast-payment, observe, prepare-solana, broadcast-solana or reconcile",
    );
  // Full operator evidence stays private; ordinary output cannot join both chains.
  writeFileSync(
    join(root, `operator-${command}-${Date.now()}.json`),
    json({ at: new Date().toISOString(), result }),
    { mode: 0o600, flag: "wx" },
  );
  if (
    [
      "status",
      "observe",
      "prepare-solana",
      "broadcast-solana",
      "execute-bounded-swap",
      "reconcile",
      "quote",
    ].includes(command ?? "")
  ) {
    const view = service.view(id);
    console.log(
      json({
        ...swapBrowserView(view, "operator-local"),
        ...(command === "prepare-solana"
          ? {
              approvalDigest: view.prepared?.digest,
              simulation: (result as any).simulation,
              approvalExpiresAt: (result as any).approvalExpiresAt,
            }
          : {}),
      }),
    );
  } else if (command === "recovery-rehearsal") {
    const report = result as any;
    console.log(
      json({
        ...report,
        exactReview: {
          ...report.exactReview,
          exactTransactionBase64: "stored privately for local review",
        },
      }),
    );
  } else if (command === "review-swap")
    console.log(json(swapBrowserView(service.view(id), "operator-local")));
  else console.log(json(result));
} finally {
  store.close();
}
