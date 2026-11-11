# Public mainnet beta gates — 2026-11-11

This is the operator checklist for moving ZecOne from the public simulated demo
to a deliberately limited mainnet beta. It records only public or aggregate
operational facts. It contains no provider credentials, wallet material,
payment-to-recipient joins, or approval values.

## Current verified state

- `zecone.xyz` and all public wallet, payment, dashboard, documentation,
  explorer and security routes return HTTP 200.
- A new hosted demo checkout completes the public creation boundary and is
  clearly labelled `SIMULATED DEMO`; it exposes no payment address and moves no
  funds.
- The public payments health endpoint is current and reports `monitor` mode,
  `operator-approved` settlement, `restricted-pilot` real payments, and no
  watcher error. Live payout and Zcash broadcast remain disabled.
- The VPS payments, access-pass, read-only and watch-supervisor containers are
  running. The supervisor has zero restarts and zero cycle failures after the
  `9999f8a` hotfix. A rollback image exists.
- The authenticated historical Zcash corpus is still catching up. This does not
  authorize execution even though the live public watcher heartbeat is current.
- Read-only destination probes corroborate Base chain ID/finality and Solana
  genesis/finality across two providers. They do not make either destination
  executable.

## Gate A — one bounded Base canary

Do not begin the five-minute quote window until every preflight item is green.

1. Historical Zcash worker is current within its configured finalized lag,
   provider agreement passes, scan age is fresh and no lock or reservation is
   active.
2. The spending wallet is synchronized, its expected account/address identity
   matches, and the canary amount plus fee is spendable.
3. Exactly one real checkout is created for the approved shielded-only receiver;
   no other real order is open.
4. Base providers agree on chain ID 8453, finalized state, relayer balance and
   pending nonce. No prior settlement exists for the source payment or order.
5. A fresh two-provider signed price and exact 300-second pilot quote bind the
   ZEC amount, destination recipient, payout, maximum debit and expiry.
6. Prepare and unsigned simulation match the same quote, recipient, nonce,
   amount, gas/fee limits and settlement commitment.
7. The operator reviews and approves the exact SIGN digest locally. Signing is
   refused if any bound value or expiry changes.
8. The signed transaction is locally decoded and checked before a separate
   exact BROADCAST approval. Immediately before broadcast, recheck expiry,
   market tolerance, nonce, balance, settlement state and signed bytes.
9. Submit once. Record the transaction hash, finalized receipt, recipient
   effect, exact fees and completed settlement journal state. An uncertain
   submission is reconciliation-only and is never replaced automatically.

Passing this gate proves one controlled Base payout. It does not authorize an
unrestricted public launch or prove Solana.

## Gate B — Base limited-beta activation

Current production configuration remains blocked until all of these are true:

- replace the expired single-device pilot with an approved, time-bounded beta
  policy and explicit per-payment and daily limits;
- configure independent execution authority and two authorized production
  pricing authorities;
- validate separate-device or equivalent independently controlled signing;
- fund the dedicated relayer to the configured public-beta liquidity floor and
  prove that the full maximum debit, not only the expected payout, fits;
- retain two-provider agreement, pending-nonce checks, replay protection,
  duplicate-settlement rejection, emergency pause and fail-closed behavior;
- complete an encrypted off-host backup and independent restore drill;
- publish customer handling for late, underpaid, excess and manual-review
  payments before opening real checkout creation beyond the allowlist.

Activation sequence: capped allowlist → one merchant → several low-value
settlements → review incidents and reconciliation → raise limits only through a
new reviewed configuration change.

## Gate C — Solana is a separate release

Solana is not covered by a successful Base canary. Its profile is currently
disabled and still requires an exact authorized recipient, dedicated funded
relayer, independent execution authority, production pricing authorities,
signer isolation and an exact unsigned simulation. Run a separate low-value
canary and receipt/effect reconciliation before advertising Solana payouts.

## Public claims until the gates pass

- Public website and simulated checkout: available.
- Verified local Zcash mainnet receiving, balance, history and operator-gated
  spending: available only through the trusted local wallet workflow.
- Historical real Zcash and Base evidence: available and clearly labelled.
- Automatic public ZEC-to-Base or ZEC-to-Solana settlement: unavailable.
- Mainnet signing/broadcast from `zecone.xyz`: unavailable.
