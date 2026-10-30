# ZecOne — Architecture

## Components

```
┌─────────────┐      ┌──────────────────────┐      ┌───────────────────┐      ┌────────────┐
│  Customer    │      │   ZecOne (operator)  │      │  Prefunded relayer │      │  Merchant   │
│  (Zcash)     │─────▶│  verification +      │─────▶│  (Base, ETH)       │─────▶│  (Base)     │
│              │ ZEC  │  settlement journal  │ ETH  │                    │      │             │
└─────────────┘      └──────────────────────┘      └───────────────────┘      └────────────┘
```

| Component | Implementation | Responsibility |
|---|---|---|
| Shielded spending wallet | `services/zcash-mainnet-spend` (Rust) | Unlock, sync, prove, sign, broadcast ZEC |
| Watch-only scanner | `services/zcash-watch` (Rust) | Attribute incoming shielded notes |
| Settlement / relayer | `services/settlement` (TypeScript) | Base payout, journal, quote, approval gates |
| Merchant API | `services/payments` (TypeScript, `node:http` + `node:sqlite`) | Merchant onboarding (EIP-4361), payment lifecycle, attribution, webhooks; modes demo / monitor (live refused) |
| Watcher bridge | `services/payments/watch-bridge.ts` | Monitor mode: consumes the authenticated `MainnetWatchScanner` snapshots read-only and advances payments to `ZEC_CONFIRMED`; no payout path |
| SDK & checkout | `sdk/` (`@zecone/sdk`, `/webhooks`, `/checkout`, `/react`) | Server client, webhook verification, browser-safe hosted/embedded checkout (SSE + polling) |
| SDK | `sdk/` (`@zecone/sdk`) | Typed, decimal-safe merchant client |
| Website / DApp | `app/`, `examples/access-pass` | Checkout, docs, explorer, dashboard |

## Data flow (a live payment)

1. **Create** — merchant POSTs `{ amountUsd, payoutChain, recipient }`. ZecOne
   returns a shielded destination + an exact, expiry-bound quote.
2. **Attribute** — the scanner detects an incoming note and binds it to the
   payment by **exact source txid** (never amount/timestamp guessing).
3. **Verify** — Zcash confirmations (≥20) are checked against two independent
   lightwalletd providers that must agree on height and block hash.
4. **Approve** — the operator reviews the exact intent and issues a **SIGN**
   approval, then (after proving/signing) a separate **BROADCAST** approval.
5. **Payout** — the relayer sends ETH to the merchant's Base address.
6. **Reconcile** — the Base receipt is verified, the journal advances to
   `FINALIZED`, and a signed webhook notifies the merchant.

## Trust assumptions

- **Relayer is trusted.** It is prefunded and executes the payout; the operator
  can correlate the incoming ZEC and outgoing ETH.
- **Two lightwalletd providers** are trusted to agree; their agreement is a
  consensus-proxy, not a local full-node proof.
- **The wallet viewing keys** are held by the operator (required to attribute
  shielded payments).
- **Not trustless.** There is no cross-chain message-passing bridge; the two
  legs are coupled only by the operator's ledger.

## Security boundaries

- **Public API** can only create/read payment intents. It can never touch
  spending keys or the relayer signing interface.
- **Signed approvals** are single-use and bound to an exact session + digest.
- **Real payout is disabled by default**; live mode needs a control file +
  `--enable-live-broadcast` + exact BROADCAST approval, and emergency pause
  overrides all.
- **Signed webhooks** (HMAC-SHA256) with timestamp/replay rejection and
  retries with backoff.

## Relayer liquidity model

- The relayer holds a prefunded ETH balance. Payouts are gated on available
  liquidity; there is **no automated ZEC→ETH conversion**.
- Liquidity is replenished manually via the operator (`services/settlement/mainnet-liquidity`).
- Each payout debits the relayer's recorded balance; the journal enforces
  double-spend prevention and reconciliation.
