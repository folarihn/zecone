# ZecOne — final submission checklist (28 October 2026)

## What each claim rests on

| Category | What it covers | Evidence |
|---|---|---|
| **Verified real mainnet transactions** | Historical pilot: shielded ZEC deposit, Base ETH payout and shielded ZEC wallet-control spend. Separate execution test: operator-approved ZEC transfer `0f0e9442…1def47`, finalized at the required 10 confirmations. | `EVIDENCE.md`, explorer links on `/explorer` |
| **Read-only mainnet monitoring (built, tested with a synthetic chain)** | Watcher → payment API bridge: attribution, 20 confirmations, reorg/provider-failure handling, chain evidence, SSE + signed webhooks. Never pays out. **Not yet run against live mainnet.** | `services/payments/watch-bridge.ts`, `tests/watch-bridge.test.ts` |
| **Demonstrated merchant checkout integration** | Wallet-signature onboarding, scoped keys, SDK, hosted + embedded + iframe checkout, payment links, signed webhooks, Access Pass example unlocking only after server-side verification | `tests/payments-integration.test.ts`, `tests/sdk.test.ts`, `tests/integration/zecone-e2e.spec.ts` |
| **Simulated demo replay** | Demo checkouts show no payable address and complete by replaying the recorded pilot transactions, labelled `simulated` / `recorded-mainnet-replay` everywhere | same tests; `/checkout`, `/pay/:id` |
| **Live hosted settlement (disabled)** | The public merchant API refuses `live` mode and imports no signer/submitter/broadcast module. The separate local Zcash execution test does not enable public checkout settlement. | health endpoint, `tests/watch-bridge.test.ts`, `EVIDENCE.md` |

No live merchant usage, transaction volume or third-party integrations are claimed.

## Before submitting

- [x] `scripts/verify-windows.ps1` passed on Windows/Node 24 with 0 FAIL; local logs remain gitignored.
- [x] Production builds and `npm run test:integration` passed locally in Edge (9/9).
- [ ] Record the 3-minute demo following `DEMO-SCRIPT.md` (demo mode only).
- [ ] Attach screenshots from `screenshots/` (taken in demo mode; they contain no keys or secrets).
- [ ] Description and pitch from `SUBMISSION.md`; limitations from `LIMITATIONS.md`.
- [x] Public demo deployment approved and verified at `https://zecone.xyz`; live settlement remains disabled.
- [ ] Optional, operator only: start monitor mode on the operator machine (see `INTEGRATION.md`) and confirm `/api/v1/health` shows `watcher.ready: true`. Do not send funds for the submission.

## Screenshots

| File | Shows |
|---|---|
| `home-desktop.png`, `home-mobile.png` | Homepage with live quote preview widget |
| `checkout-desktop.png` | Demo store with embedded checkout |
| `pay-desktop.png` | Hosted checkout, simulated: example payment interface, no address |
| `embed-mobile.png` | Iframe embed progressing through the replay |
| `dashboard-desktop.png` | Merchant sign-in with a Base wallet |
| `docs-desktop.png`, `explorer-desktop.png`, `security-desktop.png` | Docs, mainnet evidence, trust model |
| `wallet-desktop.png` | Local wallet (dark theme, scoped) |
| `dapp-mobile.png` | Access Pass example DApp |
