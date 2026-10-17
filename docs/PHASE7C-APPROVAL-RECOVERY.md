# Phase 7C expired approval recovery

16–17 October 2026. Status: **original paid order retained; no swap signed or submitted; original order deadline now expired**. Phase 7C is incomplete. Phase 8 has not begun.

On resuming at 03:12 Lagos time on 17 October, the original order deadline (22:35:59 Lagos on 16 October, Unix 1792186559) had elapsed. Read-only journal and independent RPC reconciliation again found zero signing/submission claims, zero signatures, no signed wire and no relevant relayer/recipient-token-account transactions. This is a distinct blocker from the old 90-second swap approval. The original payment remains recorded against the original order, but current policy cannot authorize new execution after that deadline. No deadline, intent, payment association or recovery veto is silently rewritten. Reopening this same paid order needs an explicitly reviewed recovery authorization; no second payment is requested.

## Initial reconciliation

`node --import tsx scripts/phase7c-recovery-audit.ts` opens the original settlement journal read-only, independently queries official devnet RPC signer and recipient **token-account** histories since order creation, checks known signatures with transaction-history search, and checks account existence and blockhash validity. The first recovery observation found one active confirmed payment, no execution/signing/broadcast claim, no signed wire, no signature, no relevant signer/token-account transactions, no recipient output account, and an invalid old blockhash. It saves full details only in gitignored private operator state. A full history page that does not reach order creation fails closed rather than assuming absence.

The original payment has previously recorded 30-confirmation evidence. Its transaction ID, note identity, receiver, authorized order, exact destination and immutable intent remain in the private journal/audit. Nothing creates or resends a payment. Histories from a single RPC provider are corroborating observations, not a global absence proof; a signed or uncertain local claim always vetoes refresh regardless of an RPC absence result. No original quarantined wallet, historical credential or unresolved transfer is changed.

## Root cause

The old prepared review set `expiresAt = min(order.expiry, now + 90)`, using it for both DEX quote and user approval. Chat review/response latency exceeded this fixed window: the replacement approval arrived 42 seconds late. Solana independently validates recent blockhash age; increasing a UI timer cannot extend it. The [official confirmation guide](https://solana.com/developers/cookbook/transactions/confirmation) describes the roughly 60–90 second recent-blockhash lifetime and use of `lastValidBlockHeight`. The [address-history RPC](https://solana.com/docs/rpc/http/getsignaturesforaddress) indexes accounts referenced by transactions; querying only a token owner's address is insufficient for a transfer to an associated token account.

## Separate lifetimes and authority

- **Payment evidence and order:** the original payment association and authorization proof persist. Execution still requires a complete fresh watch scan (at most 120 seconds old), ten confirmations, exact owned-note evidence and the original order's two-hour payment/execution deadline. Expiry does not discard the payment or enable a replacement payment; it requires recovery review. This change does not silently extend the original order deadline.
- **Economic review:** up to 30 minutes, bounded by that order deadline. Its digest binds the full immutable original intent, including recipient, relayer, network, pool, mint, exact input, minimum, slippage and fee ceiling. Reviewing these terms is explicitly **not authorization to sign or broadcast**.
- **DEX quote:** a fresh 90-second application deadline, with current pool/program/mint/token-account validation and liquidity sufficient for the original minimum. Current inventory, ATA rent and fee ceilings are checked. A refresh cannot reduce the minimum, switch token/recipient, or increase slippage/input. Different economic terms require new explicit authorization; this recovery does not edit them.
- **Recent blockhash:** chain-enforced `lastValidBlockHeight` plus fresh `isBlockhashValid` checks before preflight and immediately before signing. No fabricated extension, durable-nonce account creation or replacement of signed transactions is introduced.
- **Exact user approval:** a separate five-minute application deadline binding the exact serialized transaction digest. This is only one gate: approval cannot override an expired quote or blockhash. Neither economic review nor approval of a retired digest carries forward to refreshed bytes.

Long economic review happens **before** fetching a recent blockhash. After readiness, the tool obtains fresh bytes, validates/simulates them, shows the exact wire/digest, fee and lifetime, and requires a fresh exact approval. Local terminal approval avoids asynchronous chat delays. A practical long-lived exact-byte chat approval cannot be guaranteed with a recent blockhash; this implementation makes that limitation explicit rather than weakening the transaction-approval policy.

## Reproducible non-broadcast recovery rehearsal

From the repository root:

```powershell
node --import tsx scripts/phase7c-recovery-audit.ts
npm run phase7c -- recovery-rehearsal
```

The rehearsal refreshes the original receiving watch evidence, opens the economic review, archives only expired unsigned prepared bytes, validates the fixed route and funded inventory, and prepares/simulates a refreshed transaction for the **same** order. It never loads signing keys. Exact wire, payment association and full review live only in gitignored operator captures. Ordinary output omits raw wire and payment identifiers. The rehearsal digest can expire while other tests run and is not an approval.

## Explicit live approval gate

The following command is for the human operator in a local interactive PowerShell terminal; running it does not itself approve a transaction:

**Current order:** this command cannot pass the expired original order gate. The workflow is implemented and regression-tested, but live preparation/signing must stop until paid-order recovery is explicitly authorized. Do not run a new quote/profile/payment to bypass it.

```powershell
npm run phase7c -- review-swap --allow-devnet-broadcast --unlock-local-dpapi
```

Review the economic terms, then type `READY`. That word authorizes fresh **unsigned** preparation only. The tool rechecks the original payment, economic digest, pool, tokens, inventory, rent and fees; it refreshes expired unsigned bytes and simulates the exact transaction. It displays exact serialized base64 bytes, digest, network, recipient, mints, amount, minimum, fee/rent caps, quote/approval deadlines and blockhash lifetime. Type `APPROVE <displayed-digest>` only if approving those exact bytes. Piped input is rejected. No private seed or passphrase appears in either prompt. A new exact approval is necessary for every replacement.

If the prompt or blockhash expires, **no signing occurs**. Rerun the interactive command to review fresh bytes; no automatic loop rebuilds or broadcasts. Chain validity and both application deadlines are checked again after human review and immediately before the signing claim. If the original order deadline has elapsed, stop for explicit recovery policy rather than modifying its intent or creating another payment.

The existing `prepare-solana` / `broadcast-solana <exact-digest> --allow-devnet-broadcast --unlock-local-dpapi` commands remain supported for prompt operator handoffs. Chat approvals are never converted into permission to refresh blockhashes automatically.

## Durable exclusion and failure handling

An atomic SQLite `VALIDATING` claim and exact-approval row exclude concurrent execution before asynchronous preflight. A second attempt cannot revoke the winning attempt. Approval is consumed atomically with the irreversible signing claim. Signed bytes/signature are persisted before the sole submission attempt; lost responses remain original-signature reconciliation only. No re-signing or uncertain replacement occurs.

Known quote/approval/blockhash expiry before any signing claim releases only the unsigned validation claim, marks that approval expired, and keeps the payment attached. Manual retirement archives the prepared bytes and revokes the old review. Any signature, signed wire, signing claim, uncertainty, recovery veto or changed journal state prevents retirement. A restart during validation fails closed into recovery, without silently reopening execution. Finalized effects must match exact message, input/output vault movement, recipient ownership/token delta, rent and fee. Completion vetoes execution and refund recovery.

Browser APIs still cannot authorize, unlock, sign, broadcast or refund. Private approval/reconciliation records remain local; public evidence excludes the payment-to-recipient association. The trusted prefunded relayer, single RPC view, same-OS-account storage and reused development relayer's plaintext historical key remain limitations. New encrypted recipient credentials are unchanged. No production anonymity or custody isolation claim is made.

## Validation and completion boundary

Synthetic regressions cover late approval, quote expiry during preflight, invalid blockhash, fresh digest with old approval rejection, recipient/mint/slippage/minimum binding, repeated/concurrent attempts, lost broadcast response, restart recovery, finalized duplicate/refund veto, and original payment attribution. Real unsigned simulation is evidence of executability only. After separately approved submission, run `npm run phase7c -- reconcile`, then `node --import tsx scripts/phase7c-verify-completed.ts` for finalized effects, recipient ownership and restart/duplicate checks. Neither command fabricates completion.

Measured final suite results and current live state are recorded in `PHASE7C-TRANSACTION-EVIDENCE.md` and `PROGRESS.md`.
