# Phase 1 browser boundary review

Written before application implementation, 2026-10-12. Phase 0 checkpoint: `482fc573fd1b268a7aaadbbaed66e435817172ab`, branch `codex/phase1-wallet`. Private runtime backups are under `.secrets/phase1-checkpoint`; existing keys, deployment, order database and Phase 0 evidence are retained. No remote upload or new contract deployment is needed.

## Reuse

Keep the deployed ZecOneNFT, pinned NU7 Rust libraries, native wallet DBs and seeds, local proving, Store confirmation/idempotency rules, Base executor and receipt reconciliation. Add narrow native balance/fee-quote commands instead of deriving a balance from historical incoming payments. Keep ten Zcash confirmations and three Base confirmations. Preserve Phase 0 tests and evidence.

## Unsafe browser exposure in the CLI prototype

- CLI flags are not authentication or user approval. Directly wrapping `send`, `tick`, arbitrary paths or CLI argument strings in HTTP would expose signing authority.
- `Store.report()` includes account UUIDs, receiving-address associations, intent signatures and raw audit detail. It must never be returned as a browser API payload or served as public files.
- Native observations are receipts, not spendable balances; spent receipts remain in history. A dashboard must use native balance APIs and report freshness/availability.
- Fees were calculated only during send, so an authenticated browser still needs an actual fee quote and an enforced approved fee ceiling before signing.
- A local port alone does not prevent DNS rebinding, CSRF, cross-origin fetches or another local user connecting. Validate literal loopback Host, Origin, fetch metadata, session and CSRF tokens. Never bind to all interfaces.
- Proving is slow. An HTTP timeout or process restart cannot mean payment failure or permission to create a replacement. Persist approvals and request IDs before side effects; reconcile saved transactions and never clear uncertain markers automatically.
- The local user key and relayer key share an OS user. Process separation prevents accidental key loading by the relayer but does not resist malicious software running as that user.

## Planned controls

One local Node gateway serves Next.js and narrowly allowlisted JSON operations on `127.0.0.1:3210`. No public deployment, remote wallet RPC, generic shell command route, seed export, arbitrary destination or arbitrary calldata. Pair through a short-lived single-use local capability, exchange it for an HttpOnly SameSite=Strict session, and require a separate session-bound CSRF header on mutations. Sessions expire and can be revoked; pairing/login attempts are rate limited. Responses are private/no-store; no analytics, remote fonts or third-party image fetching.

After pairing, the user explicitly approves a domain/origin/nonce/expiry-bound Base ownership challenge, signed by a separate local user-signing helper. The application verifies the recovered address. It supports this existing local wallet only, not arbitrary third-party Zcash wallets. Order creation has a separate visible intent-signing approval. Spending requires a separate reviewed fee quote and one-time approval bound to the immutable order, amount, destination and fee ceiling. The Rust signer enforces the fee ceiling. A durable approval record and stable send UUID precede the child process.

The worker may scan and settle only an already user-approved fixed checkout. It uses the existing relayer; user key material never reaches React, HTTP responses, static assets or relayer code. A sanitized projection exposes needed wallet data only to the paired session, not account UUIDs, viewing keys, raw signatures or internal cross-chain mapping tables. The authenticated UI necessarily knows its own checkout association; the operator also knows it. Zcash shielding does not hide public Base ownership, amount chosen in this demonstration, timing correlation or RPC metadata.

## Validation gates

Test unauthorized and expired sessions; hostile Host/Origin and missing CSRF; ownership signature tampering/replay; unapproved signing; idempotent order/approval submission; stale quotes and fee bounds; incomplete confirmation progress; failures/restart recovery; response data minimization; responsive layout, keyboard access and automated accessibility. Use real local wallet data in the application. Synthetic fixtures belong only in tests. Live spending is exercised only through the visible approval flow, within the user's authorized testnet demonstration.
