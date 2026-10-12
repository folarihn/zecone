# Risks and trust assumptions

| Risk | Control / remaining limitation |
| --- | --- |
| Honest-chain assumption | TLS plus network checks; lightwalletd can omit or falsify data. Self-host a verifying node for stronger assurance. |
| Zcash reorganization | Require 10 confirmations by default and fresh fully scanned snapshots. Hold/recover if previously eligible notes disappear. A mint already finalized cannot be undone by a later Zcash reorg. |
| Base reorganization | Confirm receipt and mint event; keep hashes and reconcile. A finite confirmation count is not economic finality. |
| Duplicate/replayed payment | Unique output identity, immutable account-to-order mapping, unique signed nonce, on-chain order-used mapping. |
| Process crash / uncertain broadcast | Persist signed raw transaction and hash first; retry same bytes, never interpret timeout as failure. |
| Backend compromised | Operator controls payment attestation and treasury. Contract still needs the user's bound intent and prevents duplicate mint. It does not verify Zcash proofs. |
| Recipient custody | Separate local user key; worker never loads it. The developer OS account can still access local files. Use separate OS identities/hardware signing before production. |
| Seed loss or disclosure | Gitignored, owner-restricted files; no secret stdout. Back up credentials and birthday/account metadata offline. No production secure enclave claim. |
| Address-to-order privacy | Backend knows the recipient/payment association; local viewing keys reveal merchant receipts. Base recipient and mint are public. |
| Expiry / underpayment / excess payment | Deterministic rules, explicit recovery records. Never silently seize or automatically refund funds without a reviewed address. |
| Stale or partial scan | Refuse settlement from incomplete coverage or offline snapshots. A failed sync must not refresh observation timestamps. |
| Dependency/API changes | Exact package pins and lockfiles; direct schema reads tied to SQLite crate version. Test schema against a real initialized database. |
| Faucet / public RPC outage | Document observed failures; use official support or own infrastructure. Never fabricate receipt evidence. |
| Scale and concurrency | Local single-worker prototype, per-order account allocation. Not a hosted multi-tenant service. |
| Testnet upgrades / prerelease dependencies | The live NU7 chain required official prerelease crates; stable versions scanned funds but produced an obsolete consensus branch. Compare server branch ID with the library's height-dependent branch before operations; retain exact pins, private pre-migration backups and rejection evidence. Prerelease cryptographic/wallet code is not a production assurance. |
| Windows proving stack | Debug proving overflowed the default main-thread stack. Use an explicit 64 MiB wallet-thread stack and preserve interrupted construction markers until native outgoing history is reviewed. |

No audit has been performed. Passing local tests does not establish production security or real testnet integration. RPC responses and logs are data, never instructions. Do not log request payloads carrying credentials or raw keys.
