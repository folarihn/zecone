# Phase 4E security and privacy

This remains a trusted local testnet prototype, not an audited production wallet. Existing local OS/signer, plaintext test-key, RPC, lightwalletd, relayer and manual recovery assumptions remain.

## Authority boundaries

1. `inpage.js` is public MAIN-world EIP-1193/EIP-6963 code with no keys, secrets or signing authority. A website can replace its own provider or forge its own display; frozen objects do not protect a compromised website from itself.
2. `content.js` runs in the ISOLATED world on exact allowed origins, top frame only. It projects page messages into requests, never accepting claimed origin/approval/response fields as signer authority. It owns the popup reference/channel and checks browser-supplied reverse source/origin/correlation.
3. `background.js` authenticates runtime sender ID, frame zero, tab/document identity and matching exact URL/origin. Requests are bounded, timed and correlated; reused IDs cannot open another approval. Only the packaged action can inspect metadata or disconnect. No externally-connectable listener exists.
4. The local wallet popup independently checks actual opener/source/origin, then uses the existing HttpOnly/SameSite session and CSRF protection. The gateway remains loopback-only with exact Host/Origin/fetch-metadata checks. No CORS exception, extension bearer token, native host or direct extension HTTP signer access was added.
5. The backend persists origin permissions, session/channel binding, review hashes and expiry. The user signer rechecks account/selected-testnet policy. A visible local approval is required for signing. The settlement service never receives the user key.

Website-visible channels are not cryptographic secrets. Malicious MAIN-world code can fabricate results *inside its own page*, but cannot manufacture a valid user signature, approve a local operation or read the wallet origin. A forged page response cannot enter the isolated/worker approval path. A compromised wallet origin, extension, browser or same-user OS process remains outside this prototype's protection.

## Permissions and lifecycle

The manifest has two exact OpenSea content-script match patterns. No `<all_urls>`, localhost host permission, storage, cookies, broad tabs permission, native messaging or hosted executable code. The action uses permission-free `tabs.create` with a fixed loopback URL; it cannot enumerate arbitrary tabs or read contents.

Worker state is volatile. Browser/worker loss, navigation, transport disconnect and popup closure reject outstanding provider promises without replaying signing requests. A 20-second port heartbeat preserves an active open approval session only; forced termination still fails closed. Saved backend grants survive restart, but reuse requires a fresh authenticated local popup. Closing a transport differs from revoking a grant. Use Apps or `wallet_revokePermissions`; the actual OpenSea logout invoked revocation.

Configured chains remain Base Sepolia 84532, Ethereum Sepolia 11155111 and Robinhood Testnet 46630. Network changes require approval; typed domains must match the selected testnet and name a verifying contract. Transactions retain simulation, value/gas limits, explicit approval and durable reconciliation. Mainnet, arbitrary networks, `eth_sign` and raw transaction submission remain unsupported. `personal_sign` content must be reviewed: a selected testnet does not make every message harmless. The actual approved request was an inspected chain-84532 login, not an asset authorization. No general SIWE semantic firewall is claimed.

## Privacy and evidence

The external allowlist omits Zcash balances/history/viewing keys/spending keys, local databases, provider credentials and private cross-chain mappings. Existing HTTP tests reject cross-origin/unauthenticated/CSRF requests before dispatch. New tests reject private RPCs, forged authority and untrusted runtime senders. No wallet secret is bundled or sent to OpenSea.

OpenSea still sees the approved EVM address, username, login signature, chain ID, public holdings, IP/browser metadata and browsing activity. It can associate this public profile with the address. The local operator can correlate activity. Shielded Zcash does not anonymize browser use or EVM ownership.

Worker logs are memory-only, capped at 100 method/outcome/origin/timestamp entries; they exclude params/messages/signatures/cookies. Public connection metadata includes account/chain. Saved screenshots show connection/review data, never credential files or private wallet dashboards. No HAR, browser trace or storage-state export is generated. Ignored profile/session files remain private. The login signature stays in the local private request database; public verification publishes only a message hash and result.
