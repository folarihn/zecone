# ZecOne — Limitations

An honest account of what is not yet implemented or is intentionally limited.

## Payment / payout

- **No automated ZEC→ETH conversion.** The relayer is manually prefunded with
  ETH; there is no on-chain or off-chain exchange. Payouts are bounded by the
  relayer's available liquidity.
- **Manual relayer liquidity replenishment.** The operator tops up the relayer
  out of band (`services/settlement/mainnet-liquidity`).
- **Live payout is disabled by default.** Real relayer signing and broadcasting
  require operator-armed controls plus exact SIGN/BROADCAST approvals.

## Privacy

- **Trusted relayer.** The operator verifies the shielded payment with the
  wallet's viewing keys and can correlate the incoming ZEC with the outgoing
  Base payout. ZecOne does **not** guarantee anonymity against the operator.
- **Public Base leg.** The Base payout transaction is public and permanent.
  Merchant metadata may reveal relationships between the two legs.
- **Not a trustless bridge.** No cross-chain message passing; the two legs are
  coupled only by the operator's ledger.

## Attribution

- **Single active checkout per receiving address.** Unique per-order
  shielded-address derivation (diversified addresses + a scanner that reports
  each note's diversifier) is not yet wired end-to-end; see
  `docs/INTEGRATION-GAP-REPORT.md`. The API enforces exclusive allocation: a
  second concurrent checkout receives `409 checkout_busy`. Attribution itself is
  always by exact source transaction id.
- **Monitor mode not yet run against live mainnet.** The watcher → payment
  API bridge reuses the authenticated scanner and is tested end to end with a
  synthetic chain through the real scanner code, but it has not been run on the
  operator machine with the real watch wallet, provider keys and block corpus.
  Monitor mode never pays out.

## Availability

- **Public beta not enabled.** Live payment processing is not activated; the
  Base submitter is paused.
- **Consensus proxy, not a local full node.** Confirmation uses two independent
  lightwalletd providers that must agree; it does not implement a full-node
  Zcash consensus check.

## Demo-only features

- Demo checkouts are simulated: they show no payable address or payment URI
  (a labelled "Example payment interface" instead).
- Payments complete only through a server-side demo observer that replays the
  recorded mainnet evidence step by step. There is no browser completion
  button; replays are labelled `recorded-mainnet-replay` in events, webhooks and
  receipts, and create no financial obligation.
- Quotes use a fixed demo rate (1 ZEC = $50.00).
- The merchant dashboard shows demo payments; no live volume or live merchants
  are claimed.

## Not in scope for this sprint

- Automated treasury transfers or unattended exchange conversion.
- A second independent verifier for the Base payout leg.
- Smart-contract-wallet merchant signatures (ERC-1271/6492) are implemented
  but only active and untested when a Base RPC is configured.
- `@zecone/sdk` is used as a local package; it is not published to npm.
