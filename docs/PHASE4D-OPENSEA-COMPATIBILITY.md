# OpenSea compatibility matrix

Observed 2026-10-13. Documentation support is not equivalent to website execution.

| Capability | Actual OpenSea / infrastructure | ZecOne result |
| --- | --- | --- |
| EIP-6963 | Official help documents support | Extension source + local discovery tests; actual website discovery untested |
| Wallet picker | Real site showed MetaMask, WalletConnect, Phantom, Robinhood and more options | Screenshots saved; ZecOne absent in extension-free in-app browser |
| Select / connect ZecOne | No installed provider available | Blocked pending deliberate user installation and accessible test browser |
| Account access / verified origin | Actual site flow not reached | Local provider/popup/session permission tests pass |
| `personal_sign` | OpenSea-specific request not observed | Existing local explicit approval supported; no external signature claimed |
| `eth_signTypedData_v4` | OpenSea-specific request not observed | Configured testnet domain/contract only; production orders rejected |
| `eth_accounts`, `eth_chainId` | No actual ZecOne request transcript | Implemented; disconnected extension returns no account |
| Network switch/add | Site-specific behavior not reached | Base Sepolia, Ethereum Sepolia, Robinhood Testnet only; mainnet rejected |
| Revocation / expiry | Site-specific behavior not reached | Backend/session tests and local separate-origin browser harness pass |
| WalletConnect | Button observed on real site | Not implemented; no project ID/session transport |
| Development API key | Official instant issuance succeeded | Server-only ignored file; expiry/limits recorded |
| Collections, NFT metadata, image | Genuine collection/NFT/CDN responses | Exact NFT binding; bounded raster proxy |
| Listings and individual order | Official authenticated calls succeeded | Actual Pudgy Penguin #3357 listing validated |
| Collection fee policy | Required 1%, optional 5% returned | Required fee checked; optional fee excluded |
| Fulfillment preparation | Official API returned Seaport 1.6 advanced call and signature | Independently reconstructed; exact recipient/value/order/conduit/tag checked |
| Mainnet execution simulation | Ethereum public RPC accepted exact `eth_call` | Hypothetical ETH balance override; no signer/broadcast |
| Shielded ZEC preview | No OpenSea Zcash API assumed | Local illustrative TAZ amount; no payment request |
| Testnet API discovery | No current Base Sepolia advertisement established | Controlled Seaport workflow remains separate |
| Controlled live settlement | Existing Phase 4C public proof preserved | Ten-confirmation/replay/restart regression passes; no redundant live payment |
| Production purchase support | Not attempted | Not implemented or claimed |

The provider additionally supports `eth_requestAccounts`, `eth_sendTransaction` and `wallet_revokePermissions` through the existing reviewed testnet backend. It does not impersonate MetaMask, replace another injected `window.ethereum`, advertise arbitrary RPCs, or expose Zcash data. EIP-2255 get/request-permissions convenience methods are not advertised. A future real-site test must record the exact requested methods and honest failures, rather than infer them from the wallet's allowlist.

Transport decisions and official-source findings are in [feasibility](PHASE4D-FEASIBILITY.md); trust boundaries in [security](PHASE4D-SECURITY.md); manual installation/reproduction in [runbook](PHASE4D-RUNBOOK.md).
