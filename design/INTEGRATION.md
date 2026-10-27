# Integrating the ZecOne unified design

Branch: `design/zecone-unified-ui`, based on `5a15dee` (the last committed state of `codex/phase5-secure-settlement`). Not pushed, not merged.

## What changed

- **Design system**: tokens in `app/globals.css` (`@theme`), bundled fonts in `app/fonts`, components in `app/ui.tsx` and `app/components/ui-client.tsx`. Documented in `design/zecone-design-system.md`.
- **Navigation**: Wallet | Payments | Developers | Explore with menus, active states, mobile drawer, breadcrumbs (`app/nav.tsx`, `app/site-chrome.tsx`).
- **New pages** (no existing route changed): `/payments` (ZecOne Pay overview, the Payments hub) and `/wallet-app` (ZecOne Wallet product page). `/wallet` still renders the local wallet exactly as before.
- **Redesigned**: home, demo checkout, hosted checkout `/pay/[id]`, embed background, merchant dashboard, docs (sidebar, filter, scroll spy, highlighted copyable code, security callouts), explorer (lookup + mainnet evidence timeline), security (trust-model diagram).
- **Checkout component** `sdk/src/react.tsx`: presentation only. Brand themes, a mode strip (Simulated demo / Mainnet monitoring / Live checkout), larger type. Props, callbacks, data attributes and test ids are unchanged. Demo mode still never renders an address, QR code or `zcash:` link.
- **Copy**: em dashes removed from all public-site, SDK, example DApp and site BFF strings. The integration test string was updated to match ("Example payment interface, simulated").
- **Wallet design**: `design/zecone-wallet/` (spec + static prototype). Not served, not wired to anything.

## Not changed (by design)

Payment API (`services/payments/*`), settlement, watcher, Rust services, signing, launcher, wallet gateway, wallet runtime UI (`app/wallet.tsx`, `app/connect/*`, `app/solana-connect/*`, wallet panels), network config, keys, database schemas, recorded evidence, `package.json` and the lockfile (fonts are files, no new dependency). API routes and request bodies used by the dashboard are identical. The `.wallet-scope` CSS block is byte-for-byte unchanged.

Wallet runtime files still contain em dashes in their copy. They belong to Codex's area and are left for the wallet integration phase.

## Verification run (isolated cloud copy, not your machine)

- `tsc -p tsconfig.web.json`, root `tsc --noEmit`, `sdk` build: pass.
- `next build`: pass (20 routes).
- `npm run lint`: pass.
- Integration suite (`playwright.integration.config.ts`, ports 4391/3091/4393): 9/9 pass.
- Wallet UI suite (`playwright test`, port 3211, `ZECONE_SURFACE=wallet`): 35/35 pass, so no style leakage into the wallet.
- Node tests: 552 pass, 15 fail, 1 skipped. The 15 need Anvil, Foundry or the native Rust signer and fail the same way without these changes.
- Browser QA at 1440, 820 and 390 px on every public page: no horizontal overflow, no console errors other than the expected 401 from the signed-out dashboard session check. Screenshots: `design/screenshots/`.

## Merge steps after Codex finishes

1. Let Codex commit its work on `codex/phase5-secure-settlement`.
2. From the main checkout: `git merge design/zecone-unified-ui` (or rebase the design branch onto Codex's tip first).
3. Expected overlaps: none of the files changed here were modified in Codex's working tree when this branch was created. If Codex later edits `app/globals.css`, keep both: its changes will be inside `.wallet-scope`; this branch changes only the `@theme` block and the public-site section at the end. If Codex edits `app/site-chrome.tsx` or `app/layout.tsx`, keep the `walletSurface` and `/connect`, `/solana-connect` bare-route behaviour.
4. After merging run: `npm run sdk:build`, `npm run typecheck:web`, `npm run build:web`, `npm run test:integration`, `npm run test:ui`. Restart `payments:start`, `dev` and `dapp:start` (the SDK component changed).
5. Wallet visual integration is a separate step: follow `design/zecone-wallet/README.md`.

## Worktree

The branch is checked out in a git worktree at `.worktrees/zecone-unified-ui` inside the project folder. The folder is excluded through `.git/info/exclude`, so it never shows in Codex's `git status`. The worktree is locked so `git worktree prune` cannot remove it. Remove it when done with `git worktree unlock .worktrees/zecone-unified-ui` then `git worktree remove .worktrees/zecone-unified-ui` (the branch stays).
