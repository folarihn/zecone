# Phase 8B — development credential security and signer leases

Starts at `48485cb`. Testnets only. This phase adds opt-in encrypted credential persistence and revocable local Solana signers. It does not migrate historical wallets, fund accounts, activate new settlement paths, enable refunds or provide hardware custody. October 28 remains the demonstration deadline; production/mainnet readiness remains **NO**.

## New encrypted development vault

`services/signer/wallet-vault.ts` creates or imports explicitly supplied **32-byte development credentials** into fresh files under `.secrets/phase8b-wallets/<role>/<random-id>.json`. There is no source-file scanner, migration command, legacy credential fallback or automatic activation. Import accepts an in-memory Buffer deliberately supplied by trusted local operator code; it does not accept a historical wallet path. Creation/import require explicit consent, use exclusive file creation and never overwrite an existing record.

Encryption reuses the existing Node/OpenSSL keystore primitives: scrypt N=131072, r=8, p=1, a random 32-byte salt, AES-256-GCM, a fresh 12-byte nonce and 16-byte authentication tag. Passwords must contain 16–1024 bytes. Use a strong unique passphrase; length checks alone do not measure entropy. The authenticated purpose binds the record ID, role, network and public address, so moving a ciphertext between roles or editing those metadata fields does not create valid authority.

Supported storage identities:

- `user` or `relayer` with `solana-devnet`, `base-sepolia`, `ethereum-sepolia` or `robinhood-testnet`.
- `refund-approver` only with `approval-testnet`, stored separately as an Ed25519 development approval seed. This is **not** the PKCS#8 approval keystore consumed by existing refund workflows and is not automatically connected to them.

Only public metadata is returned from create/import/list: ID, role, network, address and format. Password verification returns public metadata and `signingActivated: false`, then immediately wipes its temporary secret buffer. The vault is a persistence/verification facility in this phase: **no EVM, native Zcash or refund signing adapter is activated by it**. Its labels are policy metadata, not a cryptographic restriction on where a stolen key might be used.

Zcash credential provisioning/import is deliberately not supported by this new vault interface. The existing native wallet APIs must be integrated explicitly before claiming a usable encrypted Zcash wallet. Legacy native signing remains available under its existing rules, with plaintext exposure documented below. No unsupported native wallet capability is invented here.

The public read/list entry points never decrypt credentials or construct an active signer. Constructor calls have no filesystem side effects. Verification is explicit and throttled; simultaneous operations on one vault instance are rejected. Seed/password copies and derived encryption key buffers are wiped where controlled. Caller-owned import/password buffers remain the caller's responsibility. Immutable JavaScript strings used by libraries, native key objects and garbage-collected copies cannot be guaranteed erased.

## Local opt-in commands

No server or browser route imports the provisioning CLI. Nothing is provisioned into a live profile during validation; all creation tests use disposable roots.

```powershell
# Public metadata only; creates nothing and unlocks nothing.
node --import tsx scripts/phase8-wallet.ts list user

# Optional future local use: explicitly create a new, unfunded development key.
# Use a pre-created external file with strong passphrase bytes and no newline.
node --import tsx scripts/phase8-wallet.ts create user base-sepolia --allow-new-testnet-credential --password-file C:\private\new-wallet-passphrase.bytes
```

The CLI accepts a passphrase **file path**, never a key or passphrase as a command argument or environment variable. The file must resolve outside the current project directory and be 16–1024 bytes. Keep it away from the encrypted vault and restrict its OS access. Do not use a seed file as a passphrase file, place it in Git, paste its contents into chat, or store it in browser storage. No CLI command here unlocks a signer, signs, broadcasts or imports a historical file. The library import API is for an explicit new credential supplied in memory; there is no plaintext import-file CLI in this phase.

New files use exclusive creation with restrictive mode intent and fsync through the existing writer. Windows effective ACLs still need separate verification; POSIX-style mode bits are not a Windows isolation guarantee. An interrupted/failed write is not silently repaired or overwritten.

## Encrypted Solana signer lifecycle

`services/solana/encrypted-accounts.ts` uses `SignerLease` from `services/signer/lease.ts`. Each account has a lease bound to its role: `relayer` for that label and `user` for recipient labels. A caller cannot request a recipient signer as the relayer or obtain refund authority from this manager. Different role/account leases are independent; locking one does not unlock or authorize another.

Defaults and configurable bounds:

- Inactivity timeout: 60 seconds by default, configurable from 1 ms to 5 minutes.
- Maximum lease lifetime: 5 minutes by default, configurable up to 15 minutes. Inactivity must not exceed this maximum.
- Failed unlocks: 3 per window by default; configurable maximum 1–10.
- Failure window: 60 seconds by default; configurable up to 5 minutes.
- Cooldown after the failure budget: 30 seconds by default; configurable up to 5 minutes.

Timing uses the process monotonic clock by default, so changing the wall clock does not extend a lease. Tests supply deterministic clocks. Status is explicitly `LOCKED`, `UNLOCKING` or `UNLOCKED`; expiration values use that lease clock and are not browser session deadlines. Viewing status/address/list does not count as activity or perform a KDF. Successful guarded signing activity refreshes inactivity only within the original maximum lease deadline.

```typescript
const accounts = new EncryptedAccounts(newIsolatedRoot, {
  inactivityMs: 60_000,
  maxLeaseMs: 300_000,
  maxFailures: 3,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
});
// Unlock requires explicit local consent and the role implied by the label.
// This is a library example, not authorization to unlock a live wallet.
```

Lock increments a generation, drops the active signer and cancels its timer before memory cleanup. If a cleanup callback fails, authority remains revoked, status reports the failure and further unlock is refused on that lease instance. An asynchronous unlock may install its result only if its starting generation still matches. A cancelled KDF remains counted as pending until completion; lock/retry cannot start overlapping decryptions of the same lease. Failed/cancelled attempts consume the bounded failure budget; locking does not reset cooldown. A successful unlock resets failure counters. Restart begins locked with no cached signer.

Signing is allowed through a frozen facade containing public address and guarded SDK methods, **not `CryptoKeyPair`**. Retaining a facade cannot bypass a later lock or become valid after another unlock. Every operation checks role, generation and deadline before crypto and before returning its result. Concurrent operations on the same lease, or unlock during a signing operation, are rejected. New leased facades accept one message/transaction per call, not empty calls or unbounded batches. This fits the existing one-transaction settlement path.

Timers proactively clear idle signers; synchronous checks also reject expired leases even if the event loop delayed a timer. Old timer callbacks check their generation and deadline, so they cannot revoke a newer lease. In-flight platform crypto cannot be forcibly interrupted, but a lock/expiry suppresses its result before release. Lock cannot undo a signature already released, erase arbitrary caller copies or cancel a transaction already submitted. These are local lifecycle controls, not protection against malicious code with equivalent process/OS privileges.

Throttling is process-local and account-specific. Restart, another process or an offline ciphertext attack can bypass the in-memory attempt counter. It limits accidental/interactive attempts and concurrent work; password strength and the KDF protect against offline guessing. Password-based backup/restore remains an explicit local age-file operation, not a network authentication endpoint or a global password-attempt limiter.

## New and legacy age file compatibility

New Solana credentials still use the standard age file format and its existing scrypt work factor (logN=18) and authenticated encryption. Their encrypted payload additionally binds the role and account label (`age-role-v2` public metadata). Relabeling a new recipient ciphertext as a relayer fails even if the public JSON is edited. New encrypted backups preserve this binding.

Existing 32-byte `age-v1` credentials remain readable through the revocable lease interface. **Unlock does not rewrite ciphertext or public metadata.** Old backups remain compatible. The old payload did not authenticate role/label; accepting it for compatibility does not retrofit that protection. Its role is constrained by the existing namespace/API checks, and same-user file substitution remains a legacy limitation. No historical credential was unlocked, copied, migrated or rewritten by this phase.

## Settlement compatibility boundary

The existing settlement code formerly accessed `signer.keyPair` directly. That would defeat revocation for new encrypted accounts. The only change in `services/solana/settlement.ts` is its signer type and a call to `signWithLocalSigner`.

The adapter keeps the legacy KeyPairSigner branch using the same SDK `signTransaction` call. Managed facades use the installed SDK `signTransactionWithSigners`, with additional lease checks before/after SDK completion. Disposable parity tests verify identical final wire bytes for the same canonical transaction/key. Existing SDK message/account policy, payment eligibility, digest/economic approval, execution claims, durable signed evidence, single broadcast, uncertain-outcome reconciliation and completed-order vetoes are unchanged. There is no new HTTP signing route.

If an explicitly unlocked new lease expires before/during an authorized future operation, it fails closed. If an execution claim has already been taken, the existing recovery/reconciliation safeguards apply; do not reset it or retry signing to bypass the failure. This phase performs no live execution and grants no authority for a later swap.

## Legacy exposure retained deliberately

- Historical EVM user/relayer JSON credentials remain plaintext. `Base` still eagerly loads its relayer in the legacy signing-capable server; that server is not a new read-only entry point and was not launched for this work. New vault read/list commands do not instantiate `Base`, `Engine` or a native signer.
- Historical Zcash `seed.bin` files and isolated development seed material remain plaintext locally. Rust minimizes selected buffers with `SecretVec`, but that does not encrypt disk credentials. Watch-only scanning remains separate from spending keys. The quarantined original transfer is untouched.
- Historical Solana `Accounts` still reads plaintext seed JSON and can expose a raw SDK keypair to its existing authorized operator path. Even `Accounts.list()` reads that JSON for its public address. This phase does not silently migrate it, disable the funded legacy relayer or claim it gained the new revocation guarantee. Use the new encrypted metadata/list methods for new read-only entry points.
- Phase 7C DPAPI CurrentUser protection remains distinct from a user password: equivalent local-user code may unseal its stored unlock material. It is not hardware backing, separate-device validation or protection against same-user malware. New vault password storage has no automatic DPAPI fallback.
- Native/independent refund signing remains disabled for live use. The existing `ApprovalVault` and its purpose binding remain compatible; new approval-seed storage does not activate it.

The remaining legacy migration/device-isolation work needs its own explicit scope. These limitations do not erase or alter the completed Phase 7B/7C proofs. See [validation and preservation](PHASE8B-VALIDATION.md). Stop after Phase 8B; provider independence is Phase 8C work and was not started.
