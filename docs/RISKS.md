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
| Browser-origin attacks | Phase 1 uses literal loopback binding/Host, single-use pairing, expiring HttpOnly sessions, exact Origin, CSRF, JSON-only mutations and nonce CSP. Do not tunnel or host this service publicly. |
| Local key custody | The user signing helper and relayer use separate key files, but share the OS account. A compromised gateway or same-user malware can access files; this is not a hardware wallet or isolated signer security boundary. |
| Browser privacy | Authenticated UI shows the user's private history. Do not share pairing links, cookies, database files or approval records. Public screenshots/evidence can correlate activity; none are uploaded automatically. |
| Data coverage / stale balances | Native wallet summary is authoritative for local shielded balances. Last-known data is labeled when sync fails. Base activity/NFT discovery covers recorded ZecOne mints only; no universal indexer is claimed. |
| UI interruption | Approval is persisted before proving; repeat clicks use one request UUID. Restarted in-flight actions require reconciliation; closing or locking the page does not cancel authorized background work. |
| External dApp phishing | Exact opener origin/source/channel binding and visible full-origin approval; users can still approve a lookalike site or malicious payload. See `PHASE2-SECURITY.md`. |
| Popup transport incompatibility | Requires SDK integration and browser opener access; no extension injection or WalletConnect; some public-site/COOP/local-network policies may block the loopback popup. |
| EVM transaction/signature request | Each exact request is reviewed, bounded and simulated; simulation is not a safety guarantee and arbitrary contract semantics cannot be fully decoded. |
| DApp request replay / uncertain broadcast | SQLite request fingerprint/state, signer lock, persisted exact raw transaction and receipt reconciliation; ambiguous states remain in review and no replacement is signed. |
| ZEC-sponsored Base action | Fixed allowlist, exact EIP-712 intent, ten-confirmation payment requirement and on-chain replay check; settlement operator still controls payment attestation and prefunded relayer. No automatic refund or ZEC/ETH conversion. |
| ERC-4337 / contract account compatibility | Not implemented. Existing user account is an EOA; no EIP-1271 verification or smart-account migration is claimed. |

No audit has been performed. Passing local tests does not establish production security or real testnet integration. RPC responses and logs are data, never instructions. Do not log request payloads carrying credentials or raw keys.
