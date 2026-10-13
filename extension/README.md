# ZecOne Testnet Connector — development source

This Manifest V3 package announces ZecOne through EIP-6963 on `https://opensea.io` and `https://www.opensea.io` only. It has no keys, background worker, remote code, generic host access or native signer privilege. The MAIN-world script opens the existing local approval popup; the authenticated local wallet independently verifies the browser's actual opener origin and requires visible approval.

**Not installed automatically. Real OpenSea connection has not been proven.** Unit tests and a local separate-origin browser harness pass. Chrome/Edge extension loading, real-site popup compatibility and OpenSea-specific RPC requests still require a manual isolated-profile test. Minimum manifest browser version: Chromium 111. No Web Store listing or distribution audit exists.

For a deliberate manual test:

1. Create a separate Chrome/Edge test profile. Start and pair ZecOne using its normal local launcher.
2. Open `chrome://extensions` or `edge://extensions`, enable development extension loading in that isolated profile, choose **Load unpacked**, and select this directory. Review the exact OpenSea host permissions. Do not change browser network/security protections.
3. Visit the real OpenSea wallet picker. If ZecOne appears, review OpenSea's terms and select it only when you intend to connect. Review the actual OpenSea origin and public user account in ZecOne's local approval popup.
4. Approve only the intended account access or understood testnet message. Reject production Seaport orders, mainnet switches and transactions. No mainnet purchase/listing/offer/approval is permitted in Phase 4D.
5. Revoke the exact origin in ZecOne's Apps panel or close the popup. Remove the development extension when finished.

The request allowlist is in `provider.js`. There is no Zcash RPC, account export, `eth_sign` or raw-transaction submission. Only configured testnet chain events are accepted. The provider neither overwrites another wallet nor claims to be MetaMask.

Installation does not make the untrusted website script a privileged signer. Browser popup/COOP restrictions may still block connection; record that result instead of disabling protections. See [compatibility matrix](../docs/PHASE4D-OPENSEA-COMPATIBILITY.md).
