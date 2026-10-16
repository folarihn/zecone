# ZecOne Testnet Connector 0.4.0

Phase 7A adds a separate Solana Wallet Standard discovery/connection and rejection-only approval transport. No Solana broadcast feature is exposed. Use `npm run extension:build` and load `dist/extension`; see [the isolated Windows validation guide](../docs/PHASE7A-MANUAL-DAPP-TEST.md). Existing EVM transport remains unchanged.

Phase 6C corrects duplicate event-listener semantics. Third-party website connection validation for this version remains blocked; see `docs/PHASE6C-LIVE-DAPP-VALIDATION.md`. Local fixture tests are not live compatibility evidence.

Manifest V3 / EIP-1193 / EIP-6963 on top-level HTTPS origins, with separate origin-scoped account approval. `inpage.js` is the public facade, `content.js` the isolated popup transport, `background.js` the sender-validating request router and `popup.html` the status action. `policy.js` lists supported methods/testnets. No keys, direct HTTP signer access, native host, background host/API privileges or remote code. The authenticated local wallet verifies actual opener origin and requires approval.

**Historical extension 0.2.0 real OpenSea discovery, account approval, login signing and logout/revocation were demonstrated in dedicated Chromium 156.0.8078.4. These results are not current-build cross-site validation.** See [Phase 4E results](../docs/PHASE4E-RESULTS.md), [security](../docs/PHASE4E-SECURITY.md), [limitations](../docs/PHASE4E-LIMITATIONS.md), and [runbook](../docs/PHASE4E-RUNBOOK.md). Manual branded Chrome installation and store distribution remain separate from this automated Chromium proof.

For a deliberate manual test:

1. Create a separate Chrome/Edge test profile. Use a separately provisioned disposable wallet backend. The historical launcher opens old wallet databases and starts workers; do not use it for an isolated Phase 6 test.
2. Open `chrome://extensions` or `edge://extensions`, enable development extension loading in that isolated profile, choose **Load unpacked**, and select this directory. Review the top-level HTTPS content-script scope. This enables discovery, not account access. Do not change browser network/security protections.
3. Visit a compatible real HTTPS dApp wallet picker. If ZecOne appears, review OpenSea's terms and select it only when you intend to connect. Review the actual OpenSea origin and public user account in ZecOne's local approval popup.
4. Approve only intended account access or an understood testnet login message. Reject production orders, mainnet switches and transactions. No asset action is needed for Phase 4E.
5. Revoke the exact origin in ZecOne's Apps panel or close the popup. Remove the development extension when finished.

The request allowlist is in `policy.js`. There is no Zcash RPC, key export, `eth_sign` or raw-transaction submission. Only configured testnets are accepted. No wallet impersonation or replacement of another provider. `provider.js` remains solely for the earlier direct-popup regression tests and is not injected. Closing a transport differs from revoking saved permissions.

Run `npm.cmd run test:extension` after installing the matching Playwright Chromium as documented. Fixtures are synthetic and do not replace real-site evidence. Popup/COOP restrictions may block other environments; record failures rather than disabling browser protections.

See [Phase 6 compatibility evidence](../docs/PHASE6-DAPP-COMPATIBILITY.md) for live-site observations, limitations and the exact distinction between synthetic fixture tests and real connections. Mainnet switching/transactions, arbitrary chain URLs, unsupported signing and unrestricted relayer sponsorship remain blocked.
