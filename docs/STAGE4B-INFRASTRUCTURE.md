# Stage 4B production infrastructure

Date: 22 October 2026. Mode: read-only. Mainnet execution remains disabled.

> Stage 4C superseded the raw-block pair below with Tatum and GetBlock.
> Blockchair is development-use only and is no longer in the probe
> configuration. See [STAGE4C-VALIDATION.md](STAGE4C-VALIDATION.md).

## Provider result

Two separately operated public lightwalletd services were exercised with the
native Rust `probe-mainnet` command:

- `https://zec.rocks:443`, operated by zec.rocks.
- `https://us.zec.stardust.rest:443`, operated by Stardust Staking.

Both completed TLS handshakes and the required lightwalletd calls. At the live
checkpoint they reported tip 3,526,658 and agreed on height 3,526,648, block
hash `000000000025c7875e209deea9fb41dcd3c6d77bd8b945d1ea1f327a9892e1e3`
and Orchard tree root. The observed block had ten confirmations. These are
different published operators. Backend, hosting and administrative
independence remain **UNVERIFIED** because ZecOne has no operator attestation or
service agreement. The services are free, public and have no ZecOne SLA.

The full raw block was retrieved independently from Tatum's Zebra JSON-RPC and
Blockchair's raw-block REST endpoint. The two responses were byte-identical.
The final live probe recorded SHA-256
`3cc836b3908f6e1a3ff12a9b11e3ca33267669bca01c42879671fbf7efbe5111`.
Local Rust verification passed header hashing, Equihash `(200,9)`, target and
the full transaction Merkle root. A separate one-block export rehearsal for
height 3,526,643 also passed exact dual-source agreement and local checks.

The durable exporter writes only to a new directory outside the repository,
requires exactly two HTTPS hosts and operator labels, requires ten confirmations
per block, verifies every block, checks adjacent previous-hash continuity,
accumulates work and removes only its own partial export on failure. Provider
requests reject redirects and bound response bodies. An optional Tatum key is
read from `ZECONE_TATUM_API_KEY`; it is never put in evidence or errors.

## Reliability and authentication decision

The anonymous Tatum endpoint returned HTTP 429 during a ten-block rehearsal,
even with bounded backoff and pacing. Blockchair describes its raw endpoint as
development-use infrastructure. Therefore the public pair is suitable for
non-sensitive validation and a controlled one-block rehearsal, but is not an
approved production exporter.

The lowest-cost next step is an operator-owned Tatum API key with automatic
upgrades disabled, combined with Blockchair for exact-byte corroboration. The
key must be injected only through the operator secret environment. This still
has no ZecOne SLA and keeps payment acceptance blocked until a representative
confirmation segment exports reliably. Tatum documents a free tier; its paid
10 requests/second plan was listed at USD 99/month when checked. No account was
created and no purchase was made.

The stronger option is an independently administered Zebra node. Official
Zebra requirements call for 300 GB storage, at least 2 CPU/4 GB RAM, and
recommend 4 CPU/16 GB RAM; snapshot setup can temporarily require about twice
the chain storage. A production host should therefore provide at least 16 GB
RAM and 500-600 GB fast SSD with headroom, separately from the shared Hermes
host. Price that host with the chosen operator before approval. No node was
installed or synchronized.

## Verification boundary

The verifier authenticates the block header, proof of work, target,
transaction-ID Merkle root, bounded chain continuity and accumulated work. It
does not validate consensus from genesis or a trusted checkpoint.

For NU5 blocks, ZIP-244 separates authorizing data from transaction IDs and
commits it through the block commitment together with chain history. The local
verifier does **not** recompute that authorizing-data root or the chain-history
root. Exact agreement between two raw-block exporters reduces single-provider
tampering risk, and owned output evidence is trial-decrypted from the exact
transaction bytes, but this is not equivalent to full consensus validation.
Payment acceptance remains blocked until either:

1. an operator explicitly accepts the dual-exporter trust boundary for the
   capped pilot, with stable authenticated export and reorg monitoring; or
2. raw blocks are sourced from an approved full node/full-consensus verifier
   that validates the complete block commitment.

The watch stack pins pre-release Zcash crates:
`zcash_client_backend 0.25.0-pre.1`, `zcash_client_sqlite 0.23.0-pre.1`,
`zcash_keys 0.17.0-pre.1`, `zcash_protocol 0.11.0-pre.0` and
`zcash_primitives 0.31.0-pre.1`. They are maintained upstream and locked in
Cargo, but the pre-release line and the absence of a ZecOne external audit keep
the production security review open.

## Privacy and failure behavior

Raw-block requests contain only public block hashes. No UFVK, receiver,
transaction ID, order ID or cross-chain destination is sent to the raw-block
providers. Lightwalletd scanning still exposes requested height ranges and the
watch host's network address to each provider. Provider collusion, logging and
traffic correlation remain possible. A disagreement, timeout, malformed block,
chain discontinuity, insufficient confirmations or in-flight reorg fails
closed. The exporter never signs, broadcasts or changes settlement state.

Evidence: [final live connectivity](stage4b-evidence/mainnet-connectivity-2026-10-22T12-17-28-936Z.json).

## VPS assessment

The last authorized same-day VPS evidence shows 6 CPUs, 11 GiB RAM, about
80 GiB free on root and a dedicated 49 GiB ZecOne filesystem. This is adequate
for bounded full-block retrieval and verification under the existing 2 CPU /
2 GiB container limits. It is not adequate for Zebra's 300 GB chain storage
and is below the recommended 16 GB RAM. Full-node deployment on this shared
host would also risk Hermes through disk and memory pressure.

No authorized SSH configuration was available in this workstation session, so
Stage 4B did not independently re-query the VPS. The assessment uses the
sanitized same-day evidence in `VPS-INSPECTION-2026-10-22.md`. No host service,
firewall, container or file was changed.
