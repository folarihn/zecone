# Mainnet relayer replenishment — design and options

**Scope:** convert received shielded ZEC into Base ETH to replenish the relayer.
**Status:** research/documentation only. No exchange integration or automatic
swaps are implemented or initiated in this phase.

## Current custody reality

- Received ZEC is held in our mainnet shielded account (`u184y9zeq…`, account
  `c89c7cda…`). We control it: the 32-byte seed is sealed in
  `zcash-receiver.keystore.json` (scrypt + AES-256-GCM) and recovered only with
  the operator passphrase.
- The watch wallet imports only the UFVK (viewing authority). It cannot spend.
- The dedicated `services/zcash-mainnet-spend` wallet now unlocks the existing
  seed, synchronizes with independent mainnet providers, proposes ZIP-317
  spends, and proves/signs on a disposable snapshot after exact approval. It
  deliberately contains no real broadcast path.

Therefore, before any replenishment, a mainnet spend-authority wallet must be
built that: unlocks the seed, opens the mainnet wallet, selects the owned note,
constructs a shielded spend, and submits it to two lightwalletd peers.

## Options

### A. Manual exchange conversion (recommended for this pilot)

Operator sends ZEC from a spending wallet to an exchange deposit address, sells
ZEC for ETH, withdraws ETH to the Base relayer.

- **Fees:** exchange trading + withdrawal fees; Zcash transparent/shielded
  network fee.
- **Liquidity:** depends on the exchange's ETH/ZEC market depth (ZEC pairs are
  thinner than BTC/ETH pairs).
- **Privacy:** sending shielded ZEC to a KYC exchange links the shielded note to
  the operator identity (shielding is lost at the deposit/withdrawal boundary).
- **Custody:** exchange holds funds transiently; withdraw promptly.
- **Operational risk:** manual errors, withdrawal-address mistakes. Mitigate with
  a small first amount and address verification.
- **Complexity:** lowest — a spending wallet + manual transfers.

### B. Exchange / liquidity-provider integration

Use an exchange or on/off-ramp API to automate the ZEC→ETH conversion.

- **Fees:** similar to A, plus API/aggregator spreads.
- **Liquidity:** better via aggregated routes, but ZEC routing is limited.
- **Privacy:** same KYC exposure; also leaks through API activity.
- **Custody:** exchange custody plus API-key custody (an API key becomes a
  high-value secret requiring its own storage and rotation).
- **Operational risk:** API keys, rate limits, order-status reconciliation,
  partial-fill handling, withdrawal reconciliation.
- **Complexity:** high; introduces new failure modes and secrets.

### C. Automated inventory replenishment

Continuously watch the relayer balance and trigger B (or a DEX swap) when below
a threshold.

- **Fees:** as B, plus more frequent trading.
- **Liquidity:** requires an always-on hot path.
- **Privacy:** continuous on-chain/off-chain linkage of ZEC inflows to ETH
  outflows.
- **Custody:** a hot spending key and hot API key on the operator machine — the
  highest-risk posture for a single-device pilot.
- **Operational risk:** automated spending/broadcast; a compromise drains both
  ZEC and ETH. Requires its own emergency pause, nonce/sequence management, and
  fail-closed guards.
- **Complexity:** highest.

## Recommendation

**Option A (manual exchange conversion)** for this single-operator personal
pilot. It keeps the operator in the loop for every spend, avoids new hot secrets
and automated broadcast, and is the only option that does not materially expand
the attack surface. It still requires building the missing **mainnet
spend-authority wallet**, which is a prerequisite for every option.

## Remaining prerequisites for replenishment

1. A separately reviewed mainnet broadcast/reconciliation implementation. The
   current spending crate has no network submission function.
2. A real exchange deposit destination approved for one exact transaction.
3. A separate live-spend authorization; dry-run approvals never authorize a
   real broadcast.

Replenishment remains a documented plan. The completed non-broadcast wallet is
necessary but not sufficient to move ZEC.
