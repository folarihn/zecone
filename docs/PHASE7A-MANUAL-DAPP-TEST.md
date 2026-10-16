# Phase 7A Windows manual dApp validation

16 October 2026. These instructions are a reproducible test workflow, **not evidence that any real website passed**. Uniswap, PancakeSwap, Sushi, OpenSea, Jupiter and Raydium compatibility with this build remains unverified. Prior OpenSea evidence is historical.

## Build and start the isolated wallet

In PowerShell, from `C:\Users\Folarihn Top-Boi\Documents\ChatGPT\zecone`:

```powershell
npm ci
npm run extension:build
npm run wallet:build
npm run phase7a:check
npm run phase7a:wallet
```

`phase7a:check` creates missing disposable Solana accounts exclusively, queries devnet, and simulates without signing. Existing account files are never overwritten. It may report RPC failure; do not substitute a successful fixture result. The wallet server creates a separate disposable EVM account and state. **Do not use `wallet:start`, `wallet:dev`, the old launcher, or the old browser profile for this exercise.** Stop another local viewer before starting this server on port 3210.

The unpacked extension directory is:

`C:\Users\Folarihn Top-Boi\Documents\ChatGPT\zecone\dist\extension`

The source is `extension/`; build copies only extension assets, never credentials. After source changes rebuild and click Reload in Chrome's extension manager. EVM provider behavior is retained; Solana is a separate Wallet Standard provider. Version is 0.4.0.

## Separate Chrome profile and pairing

1. In Chrome's profile menu choose **Add → Continue without an account** and name the profile `ZecOne disposable devnet`. Do not enable sync or import other wallets. This is separate from the historical Phase 4E profile.
2. Open `chrome://extensions`, enable Developer mode, choose Load unpacked, and select the exact `dist\extension` directory above. Pin ZecOne Testnet Connector.
3. Open `http://127.0.0.1:3210`. Copy the token from the local file `.state\phase7a\pairing.json` into the existing unlock form. Open that file privately in your editor; do not post it, photograph it, export browser storage, or include it in logs. Pairing expires after ten minutes and is one-use. Restart this isolated server to issue another token.
4. Choose the wallet's account connection/verification control. Review the local **disposable account ownership** challenge and approve it. This signs only that locally generated challenge with the new `.secrets\phase7a-evm\user.json` key. It never invokes the historical EVM signer or opens Zcash keys. Record only the displayed public address. No ETH funding is required for connection/rejection tests.
5. In the Solana tool view select payer or recipient, copy the public receiving address, refresh balances, or prepare the fixed 0.001 SOL simulation. These actions never sign or submit. Solana signing remains locked in this browser backend.

## Repeat separately on each official website

- [Uniswap](https://app.uniswap.org/)
- [PancakeSwap](https://pancakeswap.finance/)
- [Sushi](https://www.sushi.com/) (currently redirects to its Ethereum swap page)
- [OpenSea](https://opensea.io/)

These URLs were checked read-only on 16 October; website menus and testnet availability may change. A website opening is not a wallet connection test.

1. Open one official URL in the disposable profile. Choose Connect wallet, then browser/installed wallets or more wallets. Choose **ZecOne Testnet**, not Phantom or MetaMask. If absent, record “not discovered”; do not inject a provider or install impersonation code.
2. Allow the local approval popup if Chrome blocks it. Check its address is `http://127.0.0.1:3210/connect` and the displayed requesting origin exactly matches the website. Approve **connection only**. Reject unknown origins or unexpected requests.
3. Compare the website's address with the full disposable EVM address in the wallet. Record detection, popup routing and approved address separately; a picker logo alone does not prove connection.
4. If the site offers a supported testnet, request Base Sepolia (84532 / `0x14a34`) or Ethereum Sepolia (11155111 / `0xaa36a7`), inspect the switch request and approve it. Robinhood Testnet is 46630 / `0xb626`, only if the site supports it. If the site requires mainnet or WalletConnect exclusively, record that limitation and stop that step. Never change the allowlist to accommodate mainnet.
5. If the site requests login/message or transaction signing, inspect its origin and warning, then click **Reject**. The rejection-only backend blocks even an accidental signing approval; it cannot mint, trade, send ETH or use the relayer. Some sites cannot proceed without a signature—record “connection observed, login blocked by rejection policy”, not a successful login. Do not create new public profiles just for this workflow.
6. Reload the website and observe whether it requests reconnection. In the wallet's Apps view revoke the origin. Check that subsequent account/signature access requires a new explicit connection. The extension popup's **Disconnect transport** alone is not saved-permission revocation.
7. Lock the wallet and close it; pending requests must fail. Restart the isolated backend and explicitly pair again. Do not expect a pending approval to resume automatically.

## Diagnostics and evidence

Click the extension's toolbar icon: its connections view displays browser-derived origin, account permission, selected chain and pending count. Expand **Recent request metadata** to inspect method/outcome/error code, including the most recent connection request and rejection. It deliberately omits parameters, signatures, messages and cookies. This metadata is volatile and does not prove a transaction occurred.

To check actual EIP-6963 announcement in a site's DevTools console, this read-only snippet prints only wallet names and identifiers; it does not request accounts or signatures:

```javascript
addEventListener('eip6963:announceProvider', e =>
  console.log('Provider announcement', e.detail.info.name, e.detail.info.rdns),
  { once: true });
dispatchEvent(new Event('eip6963:requestProvider'));
```

Other installed providers may announce first. Use the disposable profile with only ZecOne installed. A missing announcement, missing picker entry and backend unavailability are different results. Keep the browser version, extension version, official origin, timestamp, observed address/chain, connection outcome, rejection code and revocation result in your report. Screenshot only those public details. Do not export HAR, cookies/localStorage, private files, raw signing payloads or full console dumps. Inspect and redact screenshots before sharing.

Solana uses `wallet-standard:app-ready`/`wallet-standard:register-wallet`; it does not announce through EIP-6963. Browser Solana connection and request rejection are implemented; signing/submit features are deliberately unavailable in this validation backend. Do not describe discovery on a local fixture as a Jupiter/Raydium website pass.

Stop the isolated server with Ctrl+C when finished. The disposable credentials and journals remain gitignored for recovery. Do not delete or alter any historical wallet or refund evidence.
