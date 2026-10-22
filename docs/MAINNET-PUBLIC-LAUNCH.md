# Mainnet public-launch plan

**Status: NOT READY. This plan does not authorize a public launch.** The
controlled pilot in [MAINNET-PILOT-PLAN.md](MAINNET-PILOT-PLAN.md) must complete
first, and Zcash must have an independently verified chain-data boundary.
Public traffic, refunds and higher limits remain disabled.

## Difference from the pilot

The pilot proves two exact transfers with free, best-effort infrastructure and
one operator. A public launch must survive provider failure, traffic, restarts,
key rotation, incidents and scrutiny. It needs:

- Two independently operated, monitored Zcash nodes or contracted providers
  with an SLA and authenticated chain data.
- Two paid independent RPC providers per destination network.
- A dedicated single-writer host with encrypted storage, backups and monitoring.
- Two operators and two devices, not one person declaring independence.
- A tested incident, pause, reconciliation and key-rotation runbook.
- Public evidence and privacy review before accepting user funds.

Do not expose the current local CLI, SQLite files or software keystore directly
to the internet.

## Target architecture

```text
                    +-----------------------------+
shielded ZEC ------>|  watch-only Zcash scanner   |
                    |  two independent nodes      |
                    +--------------+--------------+
                                   |
                    +--------------v--------------+
                    |  single-writer control host |
                    |  durable lease + journals   |
                    |  no public inbound ports    |
                    +----+-------------------+----+
                         |                   |
              +----------v----+       +------v-----------+
              | Base RPC pair |       | Solana RPC pair  |
              | paid, separate|       | paid, separate   |
              +----------+----+       +------+-----------+
                         |                   |
                    Base mainnet        Solana mainnet

offline signer A: relayer keys, execution authority
offline signer B: second price authority
monitoring: uptime, lag, disagreement, journal state, balance alarms
```

The control host may be a dedicated physical machine or an isolated VPS. It
must have outbound HTTPS only, full-disk encryption, a private state volume and
no interactive browser or production keys. The signer devices remain offline
except when deliberately connected to hand off an exact signed artifact.

## Infrastructure budget

Approximate steady-state monthly cost, excluding audits, legal work, support
staff and one-time hardware:

| Item | Specification | Monthly estimate |
| --- | --- | ---: |
| Zcash node 1 | 4 vCPU, 16 GB RAM, 300+ GB NVMe, static IPv4, 100 Mbps | EUR 30-70 |
| Zcash node 2 | Same, separate provider/region | EUR 30-70 |
| Base RPC | Paid tier from Alchemy, Infura or Chainstack | $49-100 |
| Solana RPC | Paid tier from Helius, Alchemy or Chainstack | $49-100 |
| Control host | 2-4 vCPU, 8 GB RAM, encrypted volume, snapshots | $20-60 |
| Monitoring/backups | Uptime, logs, off-site backup, alerts | $0-30 |
| DNS/TLS | Domain and certificates | $0-20 |
| **Total** | | **about $150-300/month** |

The Zcash nodes dominate because Zcash state grows and a full node needs
headroom. A single 2 vCPU/4 GB/300 GB node is the documented minimum, not a
comfortable production configuration. Do not run both "independent" nodes on
one provider, one account or one failure domain.

One-time costs:

- Two signer devices if suitable hardware is not already owned.
- Encrypted backup media and a tested restore procedure.
- Optional independent security review. This is not included above.

Costs are planning estimates, not quotes. Recheck provider pricing, Hetzner
price adjustments, exchange rates and disk growth before launch. A low-usage
launch may fit at the bottom of the range; a monitored service with on-call
support will exceed it.

## Provider selection

### Base

Use two separate companies:

- Alchemy Pay-As-You-Go, or
- Infura Developer, or
- Chainstack Growth.

Do not pair two products from the same parent company. Do not count a public
endpoint as production redundancy. Configure per-key rate limits and alert on
`429`, latency, stale finalized heads and provider disagreement.

### Solana

Use two separate companies:

- Helius Developer, or
- Alchemy Pay-As-You-Go, or
- Chainstack Growth.

Helius Developer is about `$49/month` for 10 million credits, 50 RPS and higher
send limits. Chainstack Developer is suitable for development but its Solana
mainnet limit of 5 RPS is too low for a public launch.

### Zcash

For a public launch, use one of:

1. Two self-hosted Zebra + lightwalletd (or Zaino) deployments on separate
   providers, with monitoring and a tested failover; or
2. Two contracted operators with a written SLA, authenticated endpoints and
   independent infrastructure.

Recommended self-hosted baseline per node:

- 4 vCPU, 16 GB RAM, 300-500 GB NVMe.
- 100 Mbps symmetric network, static IPv4.
- Ubuntu LTS or equivalent, automatic security updates, host firewall.
- Zebra full node and a TLS lightwalletd/Zaino front end.
- No spending key or UFVK on the public node. The watch scanner connects to it
  over TLS.
- Metrics for sync height, peer count, RPC latency, disk usage and certificate
  expiry.
- Alert when the node is more than two blocks behind its peer or disk exceeds
  80%.

Do not use free public endpoints for launch. Do not represent regional
`zec.rocks` endpoints as independent operators. Do not use the decommissioned
`mainnet.lightwalletd.com:9067` or the beta/unaudited
`mainnet.lightwalletd-rs-beta.zecdev.org:443`.

## Zcash chain-data gate

The current scanner verifies that two lightwalletd providers agree on the full
transaction bytes, mined height, block hash and UFVK trial decryption. It does
not independently verify a Merkle inclusion path or the proof-of-work chain.
That is not sufficient for a public service holding user funds.

Before launch, choose one:

1. Implement and review independent Merkle inclusion and proof-of-work
   verification in the scanner, with adversarial tests; or
2. Contract an authenticated verified-chain-data service and review its trust
   boundary, availability and failure behavior.

Until then, the Zcash side remains **NO-GO**. A public launch cannot silently
accept the current trust assumption.

## Pricing service

Run two independent price authorities:

- Authority A: reads Chainlink Base feeds (ZEC/USD and ETH/USD or SOL/USD) and
  signs an Ed25519 statement.
- Authority B: reads an independent exchange API (Kraken or Coinbase) and signs
  the same statement shape.

Both statements must include the exact `network` and `quoteContext`. They must
be fresh (`at` within 60 seconds), short-lived (no more than 120 seconds total)
and agree within 100 bps. The operator must not reuse a statement across
networks, amounts or fee contexts.

The code's pair label is `ETH/ZEC` or `SOL/ZEC`, but the rational
`numerator/denominator` is **ZEC per one whole destination unit**. For example,
if 1 ETH is worth 100 ZEC, use `numerator: "100", denominator: "1"`. Encode the
values as positive integers, not decimal strings or floating point.

Production pricing needs monitoring for stale feeds, divergence, exchange
outages and clock drift. A stale or divergent feed must stop new quotes, not
fall back to a cached value.

## Deployment gates

Launch only after all gates pass and are recorded:

1. **Pilot complete.** Both controlled transfers finalized and reconciled with
   no retry or replacement.
2. **Zcash gate closed.** Independent inclusion/PoW verification or a reviewed
   verified-chain-data contract is in place.
3. **Two operators.** Separate people control the execution authority and the
   second price authority; devices and recovery are tested.
4. **Provider soak.** Both RPC pairs and both Zcash nodes run for at least 14
   days with monitored uptime, no unexplained disagreement and a tested failover.
5. **Single-writer deployment.** The control host has an encrypted volume,
   durable lease, backup/restore test, and a documented process for stopping the
   old writer before recovery.
6. **Incident drill.** Pause, reconcile-uncertain, revoke-signer and key-rotation
   procedures are exercised outside production.
7. **Security review.** Secrets handling, logs, endpoint exposure, dependency
   pins and the signer boundary are reviewed.
8. **Privacy review.** Public evidence, timing correlation, destination
   visibility and source-payment identifiers are reviewed.
9. **Financial controls.** Caps, reservations, daily limits and a stop-work
   authority are documented and independently checked.
10. **Legal/operational review.** Jurisdiction, sanctions, tax, terms and
    support obligations are addressed before accepting public funds.

## Service objectives

Suggested initial targets, subject to measurement:

- RPC read success: at least 99.9% over 30 days per provider pair.
- Finalized-head agreement: at least 99.99% of checks; any disagreement stops
  new work.
- Zcash node sync lag: no more than 2 blocks behind the healthier peer for more
  than 10 minutes.
- Quote latency: under 2 seconds at p95, excluding provider retries.
- Signing: only after exact approval; zero automatic retries of uncertain
  broadcasts.
- Recovery: reconcile an uncertain attempt before any new transfer; no
  replacement transaction.
- Backup restore: tested at least quarterly.

## Rollout

1. Private canary with operator funds and the pilot caps.
2. Ten canary transfers over at least seven days, one at a time, with full
   reconciliation.
3. Raise limits only after a written review of fees, failures, provider
   disagreement and support load.
4. Keep refunds disabled until a separate refund design and approval exist.
5. Publish only the evidence that has been privacy-reviewed. Never publish
   source-payment identifiers, UFVKs, keystores, passphrases or private
   endpoints.

## Stop conditions

Stop new work immediately on:

- Any Zcash chain-data verification failure or unresolved reorg.
- Provider disagreement on identity, finalized state, balance or fees.
- Stale, divergent or unbound price statements.
- A cap breach, ledger mismatch or reservation anomaly.
- An uncertain broadcast that cannot be reconciled.
- Suspected key, device or host compromise.
- A missing backup, expired certificate or failed restore.
- Any request to bypass the exact approval, arm or resume gates.

## Not included

This plan does not provide custody, fiat on/off-ramp, refunds, a bridge,
hardware-wallet integration, HSM attestation, a public API, a web front end or
regulatory compliance. Those require separate designs and approvals.
