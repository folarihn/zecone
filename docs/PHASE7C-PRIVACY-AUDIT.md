# Phase 7C privacy audit

16 October 2026. Scope: changes after `4ed111f`; development testnets only. This is an engineering assessment, not an independent cryptographic or penetration audit. The [threat model](PHASE7C-PRIVACY-THREAT-MODEL.md) defines the separate properties and adversaries.

| Privacy property | Before | After | Verified evidence |
|---|---|---|---|
| Shielded ZEC funding | Native shielded payment; receiver/operator learns receipt | Unchanged protocol privacy; fresh isolated Phase 7C identity | Existing Phase 7B real payment is historical evidence only; Phase 7C payment verification requires a new ten-confirmation payment |
| Solana recipient unlinkability | Reused public recipient possible | Partial: optional fresh encrypted recipient by default; registered prior recipient prompts reuse acknowledgment | Local account generation and binding tests; no anonymity, graph-hiding or external unlinkability proof |
| Amount confidentiality | Shielded Zcash contents; public SOL amount | Unchanged for Zcash; SPL swap input/output, pool and fees public | Real unsigned route simulation and canonical message inspection; no confidential SPL transfer |
| Relayer correlation | Operator joins payment/order/destination | Unchanged operator knowledge; reduced ordinary-history exposure | Session-scoped handles, positive history projection, cross-session denial; private join retained for audit/recovery |
| RPC metadata exposure | Provider sees IP/timing, selected address queries and transactions | Partial: one locally constructed fixed-pool route, selected accounts only, no DEX API/analytics or payment IDs transmitted | Measured RPC method counts in real-route rehearsal; provider still sees queried accounts and complete public unsigned message |
| Local key confidentiality | Existing plaintext test keys under one OS account | Improved for new Solana keys only: age-v1, scrypt, authenticated payload, DPAPI CurrentUser-protected random unlock secret | Wrong-passphrase/tamper rejection, standard encrypted backup/restore and DPAPI round-trip tests; same-user malware/hardware isolation unproven |

The user explicitly selected the previously funded payer/relayer for direct inventory use after the top-up attempts expired. The new encrypted recipient is used; the new encrypted relayer is retained but unused. The reused relayer's plaintext credential is unchanged, so live relayer key confidentiality remains a limitation. The Phase 7C server no longer enumerates that legacy key file; only explicit local CLI signing loads it. Its OS account still has filesystem access, so this is not a process-isolation guarantee.

## Measured RPC disclosure

The [real unsigned rehearsal](phase7c-evidence/real-route-rehearsal.json) captures method names/counts only, never full request bodies, source IPs, account histories or keys. Its calls include genesis checks, selected fixed-pool/mint/program account batches, two selected ATA lookups, one relayer balance, rent, blockhash, fee and simulation. The simulation sends the complete unsigned public swap message to Solana RPC, including the selected relayer and recipient ATA. Fixed pool discovery was a bounded one-time engineering investigation, not background enumeration of wallet accounts.

No DEX quote service, token metadata service or analytics service receives a request. No cross-chain order/payment ID, viewing key, spending key or note is included in DEX instructions or RPC query parameters. Public devnet RPC and zec.rocks still see client IP, timing and query patterns. Zcash compact-block scanning and transaction retrieval can leak synchronization/access patterns even while viewing authority stays local. Independent operators/nodes are not configured; TLS and genesis pinning do not prove anonymity or RPC honesty.

## Storage and logs

Checkout projections omit the private payment transaction, address until explicit reveal, watch identity, source payer and operator request/profile/order IDs. Scoped handles are session-specific and are not a privacy protocol. The operator still has a complete necessary settlement association in a private local journal. Ordinary browser history cannot enumerate another session's order. Restart/session loss requires explicit operator reattachment rather than automatic disclosure.

New operator captures live under `.state/phase7c*`, not public docs. Watch databases and viewing keys remain local and sensitive. Public route evidence contains only public pool/program/mints and aggregate RPC-method measurements. No IP access logs or wallet analytics were added. Diagnostics accept only finite safe codes; the helper retains at most 100 entries and removes entries older than 24 hours on the next diagnostic write. Necessary payment, signed transaction, audit, approval and recovery records are retained without automatic pruning. Existing evidence is not deleted to make apparent privacy stronger.

The previous demo's published cross-chain association remains historical disclosure. Separately sharing new public transaction references in a demo can still allow timing/amount correlation; omission of the internal join is not a proof of unlinkability. Do not publish private profile files, complete journals, raw shielded notes or watch snapshots.

## Key custody and recovery

`age-encryption` 0.3.1 implements the standard age-v1 format; its default passphrase scrypt work factor is logN=18. The payload is authenticated using the format's established encryption scheme. New Ed25519 seeds are generated from secure OS randomness and enter only local Kit signing primitives. Windows DPAPI CurrentUser seals a separate random 32-byte age passphrase secret. Files are created exclusively; interruptions are reviewed rather than silently replacing keys. Historical credentials are unchanged. No private key is stored in browser localStorage, transmitted to a service or exposed by the paired backend.

DPAPI permits processes running as the same Windows user to decrypt; this is not separate-user/device isolation or hardware custody. Losing the Windows user profile/master keys can make the DPAPI envelope unusable. Keep the encrypted age file, public account descriptor and DPAPI blob backed up with the Windows profile. For portable recovery, create a strong separate recovery passphrase in an external local UTF-8 file, then run:

`node --import tsx scripts/phase7c-recipient.ts backup <external-passphrase-file> <new-backup.age> --unlock-local-dpapi`

This decrypts only in local memory, verifies the public address and writes a new standard age-encrypted backup without changing the active key file. Store that backup and recovery passphrase separately, preferably off this computer. Do not paste the passphrase into chat or put it on the command line. No portable recovery backup has been created unless the operator supplies that separate passphrase file.

Restore into a NEW directory with `EncryptedAccounts.restore(label, backupPath, recoveryPassphrase, expectedPublicAddress)`, then explicitly `unlock(label, recoveryPassphrase, true)` for local signing. The expected public address must match the saved descriptor. Wrong passwords, tampered ciphertext, incorrect identity and overwrite attempts fail. The backend never loads this key tool. Tests use disposable encrypted fixtures and verify actual public-address recovery. Buffer clearing and dropping signer references cannot guarantee erasure of immutable JavaScript strings/CryptoKeys or protection from process inspection.

## What tests do and do not prove

Tests verify exact recipient/input/minimum binding, token program/decimals/authority restrictions, malicious-wire rejection, secret/correlation projection, unauthenticated/cross-origin/CSRF/cross-session denial, reuse detection, diagnostic retention, encrypted recovery, signing idempotency, uncertainty/restart and refund exclusion. Synthetic fixtures test failure behavior; they are not successful chain transactions. A real unsigned RPC simulation tests route executability at that moment only.

No test here proves anonymity, a useful anonymity set, unlinkability against an operator/provider, lack of network correlation, malicious-provider resistance, secure hardware isolation or safety against a compromised OS. Pricing and timing remain distinctive. Production readiness remains **NO**; live refunds remain disabled.
