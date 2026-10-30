# Phase 8D.0 — verified dApp compatibility

Checkpoint `70b4cb3`; completed validation dated 20 October 2026. Testnet connection hardening, not a public-wallet launch or UI polish phase. The machine-readable [compatibility matrix](phase8d0-evidence/compatibility-matrix.json) uses PASS, PARTIAL, UNSUPPORTED, BLOCKED and NOT TESTED per operation. A pass in a fixture is not a real third-party pass.

## Actual external sites

The current probe uses the installed, unmodified-source extension in a fresh Chromium profile. It does not intercept website requests, replace providers, impersonate MetaMask/Phantom, read pairing credentials or approve accounts. The human explicitly permitted opening OpenSea/Uniswap wallet pickers and cancelling, without login, account creation or signatures. No CAPTCHA or browser-security barrier was bypassed.

Both real sites load and expose the extension's EIP-6963 announcement. Uniswap visibly lists **ZecOne Testnet** in its wallet picker. OpenSea's current picker sequence and completion of wallet selection/cancellation could not be reliably automated in this run. These steps are BLOCKED, not successful connections. Account approval, authenticated login, active account updates, network switches, message signatures and transactions are NOT TESTED on these external sites. The current sanitized facts are in `phase8d0-evidence/real-sites.json`; screenshots remain private. Earlier unversioned private files named “connected” are not accepted as fresh authenticated compatibility evidence.

Computer-use tooling could not initialize its kernel assets. The existing Playwright Chromium runtime was used instead. An earlier OpenSea Sign in click was blocked by automatic approval review until the human explicitly authorized picker/cancellation testing. That authorization did not authorize account access or signing. Timeout results are retained rather than replaced with synthetic successes.

## EVM implementation and tested boundary

The manifest injects `inpage.js` and an isolated `content.js` at top-level HTTPS document start. The public EIP-1193 facade announces through EIP-6963; it does not set `isMetaMask`, overwrite `window.ethereum` or claim legacy-provider compatibility. `provider.js` is an older direct-popup fixture source, **not** manifest-injected. Duplicate production injection now preserves one provider identity/listener set.

The isolated content script owns the actual local approval-window reference. The worker obtains origin/document identity from the browser sender, rejects subframes/forged authority, bounds pending requests, ignores unknown/replayed/expired responses, validates the one-account projection and enforces three configured testnets. Browser/session/popup loss disconnects transport; account exposure starts empty. Revoking transport differs from deleting saved backend origin permissions. Saved backend grants are separate from the browser's volatile connection; connection never supplies signer authority.

Implemented interfaces and restrictions:

- `eth_requestAccounts`: public-account review/permission path; approved/rejected handling verified with isolated synthetic popup/backend fixtures.
- `eth_accounts`: empty before connection; returns the permitted account only through the trusted approval transport. Lock/session loss, revocation, worker termination and browser restart are covered by existing/final regression fixtures.
- `eth_chainId`, `net_version`: configured testnet identity. Default disconnected facade chain is Base Sepolia. Backend-selected chain is propagated when the trusted popup is ready.
- `wallet_switchEthereumChain`: explicit supported-chain review and `chainChanged`; Base Sepolia, Ethereum Sepolia and Robinhood testnet only. Unsupported/mainnet requests fail 4901. No arbitrary chain/RPC registration.
- `wallet_addEthereumChain`: existing backend accepts only exact built-in chain metadata/URLs. It is not a generic add-network implementation.
- `personal_sign`, `eth_signTypedData_v4`: transport/review interfaces exist; backend account/domain/chain checks remain. The isolated validation backend disables signing. Fixture responses are synthetic; this phase establishes no real third-party signature or login capability.
- `eth_sendTransaction`: bounded request/review interface exists with backend sender/chain/value/calldata checks. It is not unrestricted signing or sponsorship. No live transaction was prepared, signed or broadcast here.
- `wallet_revokePermissions` and allowlisted read methods retain their existing scoped behavior. `wallet_getPermissions`, `wallet_requestPermissions`, `eth_sign`, `eth_signTransaction`, raw submission, key export and Zcash RPC are unsupported.

Malformed connection/network/transaction parameter shapes now fail -32602 before popup forwarding instead of throwing type errors or opening unusable reviews. Worker limits and backend checks remain distinct. A timeout revokes the transport resolver; it does not claim to erase durable backend reviews, revoke previously released signatures, lock legacy keys or cancel an already authorized financial operation. Financial authorization policy was not changed.

## Solana implementation and changes

Wallet Standard uses **`standard:connect`, `standard:disconnect`, `standard:events`**, not `solana:connect` or `solana:disconnect` aliases. The only advertised chain is `solana:devnet`. The old extension advertised `solana:signMessage` and `solana:signTransaction` while only rejecting their requests. Those features, and account signing-feature declarations, have been removed. `solana:signAndSendTransaction` remains absent. Clients requiring signing will correctly treat this as a connection-only wallet; discovery is not Phantom parity.

New connection controls include duplicate-registration protection, explicit popup consent, bounded request timeout, generation-based cancellation of late approval results, public-key byte/address binding, synchronous account clearing on expired/closed connections, page-unload cleanup, and five-minute maximum public-account exposure. Public connection data contains no signer or private key. Silent connect is noninteractive: it shares no account when disconnected and may return an already approved active connection.

Closing the popup or a trusted disconnect event clears account exposure. The popup checks local session/origin permission every five seconds with a four-second request deadline; failure clears exposure rather than extending it. Browser throttling can delay these checks; this is not instantaneous key locking. The new CSRF-protected connection-status endpoint reads public permission metadata **before any credential-loading path**. It does not list wallets or initialize signing. Disconnect clears local state immediately and attempts backend permission revocation through the local popup; if that popup is blocked/unavailable, revocation may fail, but local accounts stay cleared and fresh connection approval is still required. Live credentials were not unlocked for these tests.

Solana account changes currently mean clearing the account and explicitly reconnecting/selecting again. No seamless active-account switching or persistent background signer session is claimed. Legacy backend signing-review methods still reject signing and are not advertised by the extension.

Solana's injected page code is a direct-popup connection, not the EVM worker transport. Disabling/reloading an extension cannot remove JavaScript already injected into an open page; refresh that page to replace it. Its existing public-account exposure is bounded by popup/session loss and the connection lease, not a claim of instantaneous extension-disable revocation. Browser-session verification also does not unlock or lock the separate encrypted signer vault.

## Navigation security

Real external pages open local connection documents cross-site. The isolated server now permits only explicit `/connect` and `/solana-connect` document navigation through a scoped `requireLocal` option. API handlers retain the default cross-site deny rule. POSTs still require local Origin, JSON, session and CSRF. This does not permit cross-site API navigation, arbitrary pages, CORS, foreign hosts or mainnet. Tests check the default denial and the narrow document-navigation opt-in.

## Direct dApp versus ZEC-funded execution

Direct mode supplies the supported public account/provider interfaces and separately reviewed operations. Connection is not spending approval. ZEC-funded mode is the existing trusted prefunded relayer's explicitly supported action after verified shielded payment. The extension does not expose arbitrary `zecone_payWithZec`, reroute rejected direct transactions into a paid order, or advertise universal ZEC-funded execution. Original payment/recipient binding, claims, signed evidence, exactly-once settlement and refund gates are untouched.

## Remaining blockers and next phase

Full MetaMask/Phantom-like functionality needs an independently scoped secure user-signing architecture, capability-complete wallet permissions, real login/message compatibility, carefully validated transaction policies and more third-party/browser lifecycle testing. Broad legacy provider injection is not implemented; mainnet, arbitrary signing, production custody and automatic sponsorship remain disabled. Legacy plaintext credentials and single-provider limitations from Phase 8B/C remain. Public destination ownership, origin discovery and RPC metadata are not anonymous.

Recommended next work is a separately authorized read-only/demo usability phase with this capability boundary visible, followed by a security design review before any direct signing expansion. Do not treat compatibility testing as authorization to enable those features. Stop after Phase 8D.0.
