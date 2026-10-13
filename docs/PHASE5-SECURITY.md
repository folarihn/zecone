# Phase 5 security boundary

2026-10-13. Engineering implementation review, not an independent audit. Phase 5 is **partial; live refund transport is disabled**.

Native continuation: [isolated Ironwood verification/signing](PHASE5-NATIVE-REFUNDS.md) now verifies actual PCZT effects and ciphertexts, signs through a separate local binary, and journals exact output plus per-note claims. The backend has no import or route to that signer. Separate-device and actual-chain evidence gates remain closed.

## Authorities and trust

The legacy local wallet server still runs as the Windows user who can read the existing plaintext Zcash seeds and EVM keys. New approval modules do not change that fact. No existing credentials were migrated, deleted or activated in the new keystore. The user selected a separate computer for live refund signing; a second process under the same OS identity does not satisfy that boundary.

The new `Refunds` component accepts only public operator and signer keys, which must differ. It does not accept a seed path, spending key, executable signing command, or enabled broadcast adapter. The independently operated signer must hold its own chain/order evidence and keys. `WatchRefundReader` now obtains real-chain evidence from a separate seed-free UFVK scanner and signer-owned recovery registry; its live source is explicitly blocked from native signing. Both development scanners use the same public provider and Windows user, so they do not prove independent consensus or OS isolation. No native signer is wired into the backend. See [watch-only trust boundaries](PHASE5-WATCH-ONLY.md).

User authorization is an EIP-191 signature by the intent recipient over the exact, domain-separated refund request. Operator and independent signer authorization use separate Ed25519 keys and role-separated messages. These signatures are approval certificates, **not Zcash spend signatures**. The request binds the test network, immutable intent/payment digests, order/request IDs, recipient, destination, amount, fee ceiling and expiry. Refund requests last at most one hour.

The backend and signer must independently validate the destination using native Zcash decoding. The native validation command requires no seed or wallet database. It accepts testnet Sapling or Unified Addresses with a supported shielded receiver and no transparent receiver; prefix matching alone is insufficient.

## Payment, concurrency and uncertainty

Refund eligibility requires a fresh scan, positive fully confirmed receipts, unchanged attribution and an eligible recovery state. The Phase 5 service requires a Store configured for at least ten confirmations. It refuses any saved EVM bytes/hash and any durable execution-construction claim, including an incomplete claim left by a crash. A failed receipt does not automatically make an old signed transaction safe to refund.

Before calling an asynchronous EVM constructor/signer, the worker obtains an atomic, durable construction claim. Only one worker can claim an attempt. This closes the window where signing was underway but no hash had yet been saved. A missing hash never proves that signing did not happen. The existing explicit confirmed-revert retry path can authorize another attempt, but retains the construction record; the first refund version continues to exclude that order.

Refund approval and execution preparation share the order SQLite transaction boundary. Approval writes an irreversible execution veto and audit transition. The worker and legacy retry path check the veto. A reorg, stale evidence or expired authorization puts the refund into recovery while retaining the veto and signer journal. No timeout clears an authorization or permits a replacement transaction.

The independent authorization reviewer writes a unique order/request claim before producing its certificate. A crash with a claim but no saved certificate requires reconciliation. Replaying the same completed request returns the original certificate; a different request for the same order cannot obtain a second certificate. The new native signing journal also persists a pre-sign claim and input-nullifier claims; a tested failure after signing but before persistence remains uncertain and never re-signs. Broadcast crash handling is now tested in an explicitly simulated journal; production transport integration remains unimplemented.

## Native signing gate

Pinned installed source exposes `WalletWrite::import_account_ufvk`, `create_pczt_from_proposal`, PCZT signer roles and `extract_and_store_transaction_from_pczt`. The backend APIs are in `zcash_client_backend-0.25.0-pre.1/src/data_api/wallet.rs`; the PCZT crate is `0.10.0-pre.1`. The signing method documents that semantic verification, including correct change, is the caller's responsibility. Merely calling `Signer::new` or adding a signature would not enforce ZecOne's refund policy. [Maintained PCZT source](https://github.com/zcash/librustzcash/tree/main/pczt).

A separate seed-free receiving/scanning wallet and independently fetched evidence reader are implemented, but have not been validated with funded notes or deployed on a separate device. The isolated package implements owned-input, exact-output, internal-change, fee, NU7 format/expiry, witness, commitment and ciphertext checks for Ironwood. It rejects missing fields. Proving/extraction and exact-byte transaction storage passed with synthetic notes; actual-note construction, chain broadcast/reorg reconciliation and separate-device validation remain gated. PCZT features are enabled only in the separate native package; the existing wallet manifests and lockfile are unchanged.

## Local keystore

The new isolated-development envelope uses Node/OpenSSL scrypt (N=131072, r=8, p=1, bounded 256 MiB KDF allocation) and AES-256-GCM with a random 32-byte salt and 12-byte nonce. Version and purpose are authenticated. It is a versioned application envelope using standard cryptographic primitives, not Ethereum Web3 Secret Storage or a newly invented cipher. [Node crypto documentation](https://nodejs.org/api/crypto.html).

An approval vault requires explicit local consent, verifies the key type, expires within five minutes, and clears mutable buffers on lock. Locking during KDF work cancels the pending unlock. There is no browser plaintext-key or unlock endpoint for this vault. JavaScript garbage collection and KeyObject copies prevent a promise of perfect memory erasure.

Encrypted-copy staging writes exclusively to a new destination, verifies by decrypting and comparing, and never activates or deletes the original. Only generated isolated credentials were used in tests. Losing the password loses access to the encrypted copy; no password recovery is provided. Encryption round trips do not establish seed-only Zcash wallet restoration.

## Privacy and network restrictions

Existing local-origin, session, CSRF and approval checks remain in force. Market references require an authenticated connected session. New audit reasons contain IDs/statuses rather than complete payment requests; public refund projections omit destination, amounts, approvals and attribution. Private databases and request exports still correlate Zcash payments with public EVM recipients. The trusted provider can see these links.

Reference-price requests use fixed HTTPS hosts, bounded bodies/timeouts and no redirects. They send product identifiers, not wallet addresses. They still expose the service's IP address. OpenSea import is explicit, resolves authoritative metadata/orders, and returns a non-executable mainnet preview. It does not alter the website's Buy button or inject scripts. Existing OpenSea preview requests disclose the configured public recipient/provider to OpenSea.

No analytics were added. Existing historical records and evidence were deliberately retained; this phase does not claim comprehensive retention minimization or anonymization. Known local credentials are scanned in memory against changed/nonignored files, with counts only in the report.

## Portable finalization and simulated isolation

The portable request is bounded and accepts only the authorization bundle and unsigned PCZT. Signer evidence is supplied by its own reader, not an additional backend field. Review displays order/request IDs, destination, amount, actual fee/cap and expiry. The approval digest binds both the package and native review. Signing repeats review before key use; real-chain readers are rejected. Native finalization checks the original transaction again and applies only validated signatures from the returned PCZT before proof/extraction.

A durable finalization claim precedes randomized proof generation. Completed replay returns stored transaction bytes and verifies their hash; an incomplete claim requires reconciliation. The exported envelope contains no key, viewing data, witness or PCZT. The CLI uses new synthetic fixtures and separate processes on one Windows account. Its development password is stored beside the encrypted test keys. This is functional testing, not protection from a backend running as the same user. No existing credentials are migrated and no live-enable flag is provided.

The separate simulated delivery journal claims an attempt before invoking its fake transport, preserves uncertain outcomes and checks fresh exact receipt details and ten confirmations. It refuses databases containing production order/refund tables and always reports liveRefundConfirmed=false. It cannot establish production broadcaster or consensus security.

The interrupted original-wallet funding construction marker is a recovery barrier, not disposable test debris. No saved hash or receiver receipt is not proof that restarting under another request ID is safe. See [current blockers and evidence](PHASE5-SUBMISSION-READINESS.md).
