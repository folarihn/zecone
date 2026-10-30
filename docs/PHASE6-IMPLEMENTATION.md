# Phase 6A + 6B implementation

15 October 2026. Based on `9af83ee`. **Wallet UI, shared checkout projection and generic HTTPS provider discovery implemented. Live cross-site connection validation remains incomplete; no new real-chain payment, mint, swap or refund was performed.** Mainnet readiness remains NO. Phase 7 has not begun.

## Product changes

The dark-first application uses shared surface, text, accent, border and focus tokens; responsive navigation; reduced-motion support; accessible native dialogs; and visible loading/error/unavailable states. The eight primary destinations are Overview, Wallet, Send / Receive, Swap, NFTs, Activity, Connected Apps and Settings. Existing mint, fixed-action, marketplace, Seaport and privacy screens remain available as checkout tools. URLs use `/?view=<section>` and survive refresh/back navigation. Existing `/connect` retains origin-bound approval.

Overview shows actual backend Zcash balance/available/unavailable-or-pending amounts, Base balance or an unavailable marker, known NFTs, activity and saved checkout progress. No aggregate fiat valuation or invented token holdings. Wallet provides existing read-only network portfolio queries. One configured EVM account is shown; additional account import is unavailable. The same address across networks is explicitly disclosed as linkable.

Send / Receive supports copying the configured EVM address with explicit network selection and a clipboard failure state. **General-purpose Zcash sends/receives are not enabled for the quarantined historical wallet.** Supported native payments still use their existing exact-review checkout flow. Locking revokes the local session; it is not a claim of hardware isolation or encrypted protection from the same OS user.

NFTs presents known collection ownership records, contract/token IDs and verification times, with links to existing marketplace purchase and Seaport discovery/preview controls. It does not pretend to index every collection or fetch unavailable metadata. The existing generated ZecOne collection art is product artwork, not retrieved external NFT metadata. Swaps show the existing allowlisted ZTEST route and actual service-provided token balances/quotes; unsupported networks/pools cannot produce a fake executable quote.

## Checkout architecture

`GET /api/checkouts` is an authenticated, account-verified, **read-only projection** of the existing mint/action, marketplace, swap and Seaport journals. It does not create another ledger or execute state transitions. Stable `kind:id` identifiers avoid cross-adapter collisions. The browser stores only a selected identifier; the backend remains authoritative after refresh/reconnection. Original review and recovery controls are reused per adapter.

Projected states cover user review, payment request, confirmation progress, destination execution, completion, expiry, execution failure and recovery. Adapter journals remain durable across worker restarts. The projection distinguishes an expired unpaid mint from an execution failure; a paid or uncertain transaction remains in reconciliation after quote expiry. It never infers REFUNDED from status text or an unsigned request. The independent refund harness is deliberately not imported into the product ledger. Refund construction/authorization status in that harness remains separate; live refund UI actions are unavailable.

Payment addresses remain absent from the general dashboard. The separate `POST /api/checkouts/payment-request` operation requires authenticated local origin, CSRF, verified account, explicit reveal and an exact adapter/id. Its native order must be awaiting payment, unexpired, unpaid and outside sending/sent/review stages. This reveals the **existing** unique request without allocating another one. Mainnet/non-shielded destinations are refused. Inspecting an address does not send funds; the UI tells users not to make an additional payment.

The shared tracker displays source/destination, recipient, quoted amount, fees where quoted, expiry, confirmations, output/slippage terms, transaction references, result verification and recovery. Detailed references are collapsible. Original review panels display exact provider/native fees and simulated pricing. Quote clocks disable expired approvals; in-flight refs prevent duplicate clicks. Backend CAS, immutable intents, native request markers, receipt validation and replay guards remain the final authority.

Mode A remains the ordinary user EVM wallet: explicit origin-scoped connection and per-request signing/transaction review, configured testnets, simulation and fee ceilings. Mode B remains restricted prefunded settlement adapters after confirmed shielded payment. A website connection or arbitrary calldata is never an entitlement to ZEC-funded execution.

## Provider changes and evidence

The installed MV3 extension is now 0.3.0 and discovers on top-level HTTPS sites, without account disclosure until consent. Exact origin/document authentication remains in the isolated worker and local popup. Added bounded public RPC methods improve interoperability while preventing custom RPC injection, state overrides and raw broadcasting. Existing signing, network approval, event notification, permission revocation and restart protections are retained.

The live site inspections and local fixtures are separated in [the compatibility report](PHASE6-DAPP-COMPATIBILITY.md). No new real-site ZecOne connection is claimed. OpenSea's actual 4E evidence is retained as historical. The available in-app browser cannot load the MV3 extension through the exposed interface. Zapper currently reports shutdown, so it is not a viable current compatibility target.

## Screenshots and routes

All wallet screenshots below use **intercepted synthetic API fixtures**, clearly identified in filenames and this caption. They demonstrate layout and state handling, not real funds or settlement. There are no mocked balances shipped as runtime application data.

| Screen                  | URL                            | Screenshot                                                                                                         |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Overview                | `/?view=Overview`              | [Viewport](phase6-evidence/ui-overview-viewport-fixture.png), [full page](phase6-evidence/ui-overview-fixture.png) |
| Saved recovery checkout | `/?view=Overview`              | [Recovery state](phase6-evidence/ui-checkout-fixture.png)                                                          |
| Mobile overview         | `/?view=Overview` at 390 × 844 | [Mobile](phase6-evidence/ui-mobile-fixture.png)                                                                    |
| Unsupported swap pool   | `/?view=Tokens`                | [Swap unavailable](phase6-evidence/ui-swap-fixture.png)                                                            |

Other navigation URLs: `/?view=Wallet`, `/?view=Send%20%2F%20Receive`, `/?view=NFTs`, `/?view=Activity`, `/?view=Apps`, `/?view=Settings`. Existing checkout tools use `Checkout`, `Sponsor`, `Purchases`, `Seaport`, `Privacy`. Approval route: `/connect`.

## Validation and reproducibility

Runtime dependencies remain the installed/pinned Next 16.4.0, React 19.3.0, viem 2.57.4 and existing Rust NU7 locks. No dependency or contract upgrades, new paid service, key migration or wallet credential generation. `package.json` adds a `lint` command only; package lock and Cargo locks are unchanged.

Run from repository root, using Node 24 and the existing toolchains:

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location).Path 'target'
$env:CARGO_INCREMENTAL = '0'
cargo test --locked --offline
cargo test --locked --offline --manifest-path services/zcash-watch/Cargo.toml
cargo test --locked --offline --manifest-path services/refund-signer-native/Cargo.toml
forge test
npm test
npm run typecheck
npm run typecheck:web
npm run lint
npm run wallet:build
npm run test:ui
npm run test:extension
node scripts/phase6-preserve.mjs verify
```

Run native build/tests before the Node proof tests to avoid a Windows executable lock. Browser UI tests start Next on loopback with intercepted fixtures, **not** `services/wallet/server.ts` or historical settlement workers. The extension test needs the existing matching Chromium binary under `.state/playwright-browsers`; it creates disposable profiles. `npm run lint` checks formatting of Phase 6 source and extension JS syntax; TypeScript checks run separately. This is not a claim that a new whole-repository ESLint configuration was introduced.

**325 tests pass:** Node 223, wallet Rust 8, watch Rust 4, native signer Rust 4, Foundry 52, browser UI 20 and installed extension 14. Both TypeScript checks, scoped lint and the production build pass. One expensive native signer proof test stays ignored by default; Node tests run the existing synthetic proof/extraction exercise. No synthetic proof is reported as a live refund.

Evidence: [Node](phase6-evidence/node-tests-final.txt), [wallet Rust](phase6-evidence/baseline-rust-wallet.txt), [watch Rust](phase6-evidence/baseline-rust-watch-retry.txt), [native signer](phase6-evidence/baseline-rust-signer-retry.txt), [contracts](phase6-evidence/contracts.txt), [UI](phase6-evidence/ui-verified.txt), [extension](phase6-evidence/extension-final.txt), [service typecheck](phase6-evidence/typecheck.txt), [web typecheck](phase6-evidence/typecheck-web.txt), [lint](phase6-evidence/lint.txt), [build](phase6-evidence/build-final.txt). The preservation inventory verified **537 files with zero changes**, including existing credentials, historical wallet databases/transaction artifacts and Phase 5.2 state/evidence. [Preservation report](phase6-evidence/preservation.json). Native manifests, dependency locks and contracts are unchanged.

Development failures retained in evidence: watch rebuild disk exhaustion; Node subprocess EPERM before approved rerun; signer executable lock during overlapping baseline processes, followed by serial passing retry; early UI contrast failures corrected and rerun; old OpenSea-only fixture assumptions updated for generic HTTPS discovery; an address-projection regression fixed by preserving the old dashboard privacy boundary. A Foundry signature-cache warning affected cache writing, not its passing test outcomes.

## Remaining gates and Phase 7 recommendation

Actual extension-enabled cross-site connection/sign/reject/disconnect testing with a separately provisioned disposable backend is still required. No old wallet server was started just to get screenshots. The present server's legacy default storage paths and startup workers mean that launching it against historical credentials is not an isolated validation environment. General token/NFT indexing, extra account import, WalletConnect and broad mainnet chain support remain unavailable.

The confirmed Phase 5.2 payment, unsigned PCZT and quarantined transfer stay intact. Live refunds remain disabled until separate-device validation and exact signing/broadcast authorization. There is no new confirmed refund or destination transaction to list for Phase 6.

Recommended next scope: finish the isolated live-site acceptance environment and per-site evidence; review fresh-recipient authorization for a limited privacy prototype; then the separate Phase 7 Solana read-only/one-token devnet plan. [Privacy research](EVM-PRIVACY-RESEARCH.md), [DEX evaluation](PHASE6-DEX-RESEARCH.md), [Solana plan](SOLANA-INTEGRATION-PLAN.md). None of these future transaction infrastructures is deployed here.
