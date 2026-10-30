# Stage 4B validation — 22 October 2026

> Superseded by Stage 4C for raw-block providers and the ten-block export.
> See [STAGE4C-VALIDATION.md](STAGE4C-VALIDATION.md).

## Decision

ZecOne has a verified, practical read-only infrastructure path, but production
mainnet payment acceptance remains **BLOCKED**. One real mainnet block was
corroborated byte-for-byte by two raw-block services and passed local header,
proof-of-work, target and transaction-Merkle verification. Two published
lightwalletd operators agreed at ten confirmations. A representative ten-block
export did not complete because anonymous Tatum access returned HTTP 429.

- **Two lightwalletd operators — PASS with qualification.** zec.rocks and
  Stardust agreed live; administrative/backend independence lacks an
  attestation or SLA.
- **Complete raw block — PASS for one-block rehearsal.** Tatum and Blockchair
  returned exact bytes; anonymous Tatum is rate-limited.
- **Local cryptographic checks — PASS within scope.** Header hash, Equihash,
  target and txid Merkle root passed. ZIP-244 auth-data/chain-history commitment
  is not locally recomputed.
- **Confirmation/reorg controls — PASS in code and fixtures.** Dual hashes,
  bounded continuity, accumulated work, tip recheck and fail-closed behavior.
- **Authenticated production export — BLOCKED.** An operator Tatum key or
  approved full-node exporter is required, and a representative segment must
  pass.
- **Watch-only backup mechanics — PASS with disposable data.** age encryption,
  digests, SQLite integrity and restore pass.
- **Production off-host backup — BLOCKED.** Public age recipient, destination,
  retention and alert route are absent.
- **Shared VPS for bounded verifier — PASS from same-day evidence.** Its 2 CPU /
  2 GiB container limit and 49 GiB filesystem are adequate.
- **Shared VPS for Zebra — FAIL.** Disk is far below 300 GB and RAM below the
  16 GB recommendation.
- **Owned-note mainnet scan — NOT RUN.** No production UFVK, wallet or payment
  was created.

## Live evidence

At `2026-10-22T12:17:17Z`, zec.rocks and Stardust reported mainnet tip
3,526,658 and agreed on height 3,526,648 with ten confirmations. Tatum and
Blockchair supplied identical raw bytes. The block contained ten transactions;
its transaction Merkle root matched the locally verified header and proof of
work passed. The sanitized record is in
`docs/stage4b-evidence/mainnet-connectivity-2026-10-22T12-17-28-936Z.json`.

This proves public-chain retrieval and the implemented checks. It does not
prove ownership of a shielded note, a production backup, provider SLA, full
consensus validation, or production wallet readiness.

## Implementation review

The exporter now requires ten confirmations for every block, rejects provider
redirects, bounds JSON response bodies, constrains the exported height range and
removes a partial directory only when this process created it. Raw-block
provider URLs with query credentials are rejected.

Validation after review: **529 Node tests**, including **8 focused Stage 4B
tests**, and **16 Rust watch tests** pass. Both TypeScript checks, lint, Rust
formatting/Clippy, wallet production build and extension build pass.

## Safety result

No mainnet seed, UFVK, receiver, wallet, payment, order, signer or refund was
created or accessed. No transaction was signed or broadcast. The VPS was not
changed or restarted. ZecOne and Hermes deployment state was not modified.

## Operator gate

Before provisioning a mainnet wallet, the operator must:

1. create an operator-owned Tatum credential with automatic paid upgrades
   disabled, inject it as `ZECONE_TATUM_API_KEY`, and pass a representative
   confirmation-segment export against the approved second source;
2. decide whether the capped pilot accepts the documented ZIP-244/full-node
   trust boundary, or provision a separate Zebra/full-consensus verifier;
3. provide a pinned public age recipient, real off-host destination and
   failure-alert route, then complete an off-host backup/restore drill; and
4. restore authorized SSH access if a fresh VPS resource/health recheck is
   required.

Only after those checks should the separately controlled mainnet wallet
provisioning and authenticated owned-note scan be proposed for approval.
