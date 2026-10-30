# Phase 6C real dApp validation

15 October 2026. Starting checkpoint `19b5778`. **PARTIAL — no new real website wallet connection is verified.** No transaction was broadcast, no message approved on a third-party website, and no existing wallet backend was started.

## Concrete browser blockers

The browser connector initially exposed only Codex's in-app browser and MCP Apps. Requesting Chrome returned `Browser is not available: chrome`. That surface cannot load the installed MV3 extension or reuse `.state/phase4e-chromium-profile` through its documented API.

A further attempt using the supported Computer Use skill failed to initialize `@oai/sky` through `node_repl`: `failed to write kernel assets: The system cannot find the path specified. (os error 3)`. Restoring CUA documentation then returned the same runtime initialization error. These are tool failures, not observations about the websites. [Recorded attempts](phase6c-evidence/browser-blockers.json).

We did not inject a provider into official websites, use intercepted fixture pages as live evidence, or invoke the old browser launcher and its historical backend. The dedicated profile remains untouched. The available fallback was local automated UI/extension testing and read-only RPC verification.

## Compatibility matrix

For **each** row below: browser version is **unavailable for the requested dedicated profile**; candidate extension source is **0.3.1**, not loaded in that profile during this run. Wallet detection, approved connection, displayed account, testnet switching, signature routing/rejection, persistence, revocation/reconnect, and transaction inspection are **NOT TESTED on the real website in Phase 6C**. The common blocker applies to every operation; no cell implies a successful live connection.

| dApp | Official URL | Phase 6C status | Actual evidence | Remaining requirement |
| --- | --- | --- | --- | --- |
| Uniswap | https://app.uniswap.org | BLOCKED | Browser connector / native initialization failures | Extension-enabled controlled browser and disposable account |
| PancakeSwap | https://pancakeswap.finance | BLOCKED | Same tool failures | Same, including supported-testnet switch/rejection |
| Sushi | https://www.sushi.com | BLOCKED | Same tool failures | Same; EVM connection only |
| OpenSea | https://opensea.io | BLOCKED | Same tool failures; Phase 4E evidence is historical only | Repeat connection/rejection for 0.3.1 |
| Rarible | https://rarible.com | BLOCKED | Same tool failures; additional marketplace candidate only | Observe real picker and connection; no settlement adapter implied |
| Aave | https://app.aave.com | BLOCKED | Same tool failures | Safe connection/rejection if supported testnet unavailable |

The old [Phase 6 website observations](PHASE6-DAPP-COMPATIBILITY.md) and [Phase 4E OpenSea result](PHASE4E-RESULTS.md) remain dated evidence of their respective versions. They do not verify this version.

## VERIFIED LOCAL provider and safety checks

The full installed-extension fixture suite passed 14 tests, including isolation of browser-derived origins, foreign response rejection, chain changes, rejection/revocation and worker/browser restarts. The legacy popup harness remains a separate local test. [Installed extension log](phase6c-evidence/extension-final.txt), [wallet/browser log](phase6c-evidence/ui-final.txt).

Source audit found and fixed duplicate-listener semantics: both facades now preserve repeated registrations, remove the last matching registration, and emit over a stable listener list. This follows the event requirement in [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193). Frozen [EIP-6963 discovery](https://eips.ethereum.org/EIPS/eip-6963) remains separate from `window.ethereum`; coexistence is covered locally. No MetaMask impersonation was added.

`personal_sign` keeps standard `[data, account]` ordering and accepts legacy `[account, data]` only when unambiguous. Different-account and ambiguous requests fail closed. Known `approve` max-uint requests warn **UNLIMITED TOKEN ALLOWANCE**; `setApprovalForAll(true)` warns **ALL NFTs**. Selector decoding does not establish contract behavior.

An optional rejection-only connector policy blocks signature/transaction/relayer approvals before signing state or helpers. Controlled dry-run tests inspect sender, recipient, chain, simulation and gas, reject the request, and verify idempotency/replay handling. **The production connector's default behavior is unchanged.** The Phase 6C snapshot viewer has no connector approval endpoint and rejects all spending routes independently of that option. These are local tests, not a real site's transaction request. [Focused tests](phase6c-evidence/phase6c-tests.txt).

## Reproducible later live validation

Restore the supported computer-use/browser runtime first. Use the existing dedicated Chromium profile and explicitly reload extension 0.3.1; record its actual browser version. Use an isolated, disposable account and a dedicated rejection-only connector backend, not `wallet:start` against historical databases. The current snapshot viewer intentionally cannot approve connections or signatures.

For each official URL above, capture picker discovery, origin-bound connection approval, displayed public account and chain, supported testnet switching, reload persistence, signature routing followed by rejection, revoke/disconnect and fresh reconnect authorization. Inspect transactions only through simulation and rejection. Do not accept arbitrary signatures, mainnet actions, new Zcash payments or refund signing. Keep site evidence separate from fixtures. The browser blocker must be removed before these steps can be reported as VERIFIED LIVE.

WalletConnect transport was not added or verified. Sites requiring only that transport or unsupported/mainnet networks remain unsupported until separately implemented and tested. Phase 6C remains PARTIAL; Phase 7 has not begun.
