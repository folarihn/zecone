# Phase 1 local wallet runbook

The existing wallets, deployed contract and Phase 0 evidence are reused. **Do not regenerate keys, replace databases, redeploy the contract, or remove uncertain transaction markers.** This is a single-user testnet application for this Windows computer.

## Open the wallet without terminal commands

Double-click **`Launch-ZecOne.cmd`** in the project folder. It starts the production application in a hidden process if needed, creates a short-lived local pairing link, and opens your default browser. The only application address is **http://127.0.0.1:3210**. `localhost`, LAN addresses and public hosting are deliberately unsupported.

The launcher opens an authenticated session using a single-use fragment capability. The fragment is removed immediately, is not sent in an HTTP URL, and is exchanged for an HttpOnly, SameSite=Strict cookie. The link expires in ten minutes; the browser session expires in one hour. Reopen the launcher after expiry. Never share the pairing link or `.secrets/browser-pairing.json`.

1. Check the real Zcash and Base balances and network sync time.
2. Select **Verify ownership**. Review the origin, account, network, nonce and expiry, then **Approve connection signature**. This signs locally without spending funds.
3. Open **Checkout**. Review the existing ZecOne Phase 0 collection and the user recipient.
4. Select **Review & create order**, then **Approve & sign order**. The signature authorizes one fixed mint to your account, valid for 24 hours. It does not send Zcash.
5. Select **Review payment & fee**. The Rust wallet builds an unsigned proposal to determine the fee. Review amount, maximum fee, source/destination, recipient, contract, expected NFT and privacy limitations.
6. Select **Approve & send test ZEC**. The native wallet enforces the approved fee ceiling and constructs/proves the shielded transaction locally. A debug build can take several minutes. Do not pay again while proving.
7. Keep the application process running. The page can close: approved work remains durable. The worker requires ten confirmed Zcash blocks, then the prefunded relayer mints. Base success requires three confirmations, a canonical receipt, the exact mint event, consumed order and matching `ownerOf`.
8. The checkout shows **Completed** and a public Base explorer link. Return to Wallet to see the verified collectible.

The product uses **TAZ** for Zcash Testnet units. No mainnet funds or asset exchange are involved. The user Base account's ETH is not spent by this mint; the separate relayer pays Base gas.

## Build from the preserved checkout

Tested environment: Windows, Node 24.12.0, Rust 1.97.1, MSVC build tools, Foundry/Anvil 1.7.1. Use exact lockfiles. The native wallet's official NU7 prerelease pins are unchanged from the verified Phase 0 checkpoint.

```powershell
npm.cmd ci --ignore-scripts
cargo build --locked
npm.cmd run wallet:build
npm.cmd run wallet:open
```

Next.js 16.4.0, React/React DOM 19.3.0, Tailwind/@tailwindcss/postcss 4.3.3, PostCSS 8.5.29 and lucide-react 1.55.0 are pinned. The build uses Next's supported webpack mode: Turbopack's CSS subprocess failed in this Windows environment both inside and outside the sandbox. Next telemetry is disabled. No remote font, image or analytics service is used.

The custom server is required. `npm run wallet:start` is the production gateway; `npm run wallet:dev` is the same authenticated gateway in development mode. **Do not substitute a publicly bound `next start`, add a tunnel, or forward port 3210.** The isolated UI tests use a separate loopback-only Next process on 3211 with all API calls replaced by test fixtures; it is not the real wallet service.

If recreating this project on a different machine, provision credentials using the original Phase 0 runbook. This application does not create or import arbitrary third-party wallets. The current deployment and public wallet manifest are local configuration, not browser-supplied inputs.

## Files and service boundaries

| Location | Purpose |
| --- | --- |
| `.secrets/user/zcash/` | User seed, native wallet, stable outgoing request markers; never expose |
| `.secrets/merchant/zcash/` | Merchant receiving/scanning wallet; never expose |
| `.secrets/user/base-sepolia.json` | User signing key, read only by the separate local signing helper |
| `.secrets/relayer/base-sepolia.json` | Prefunded execution key; never the NFT recipient |
| `.state/orders.sqlite` | Original Phase 0 verifier, payments, settlement journal and recoveries |
| `.state/wallet-app.sqlite` | Browser sessions/challenges, checkout IDs, fee approvals and payment request UUIDs |
| `.state/browser-approvals/` | Private, fixed approval records and signed intents; never publish |
| `.state/wallet-server*.log` | Generic server diagnostics; no request bodies or raw signer errors |
| `.secrets/phase1-checkpoint/` | Private pre-Phase-1 runtime backup |
| `docs/evidence/` | Preserved Phase 0 transaction and test evidence |
| `docs/phase1-evidence/` | Explicitly selected Phase 1 test logs, UI screenshots and public transaction references |

Back up `.state` and `.secrets` together while the service and native child processes are stopped. Keys are plaintext development files restricted by OS permissions; they are not encrypted or hardware protected. Do not upload private backups, database files, approval files, session cookies or pairing capabilities.

## Failure and recovery

| Display | Meaning / action |
| --- | --- |
| Awaiting payment / building proof | No confirmed merchant receipt yet. Proving is local and can be slow. Never infer failure from a delayed HTTP response. |
| Payment detected / Confirming | A mined shielded receipt is visible. Fewer than ten confirmations cannot authorize settlement. |
| Settled | The verifier has ten confirmed blocks and enough value; the Base mint is next. This transient state is called `verified` in the original Store. |
| Executing | A fixed Base transaction is prepared/submitted. The worker checks the same hash and may rebroadcast identical saved bytes. |
| Completed | Canonical successful Base receipt, exact event, consumed order and recipient ownership verified. |
| Failed | Expired order or confirmed reverted mint. Do not pay the same order again. |
| Manual review required | Interrupted construction, unknown broadcast, reorg or other uncertain outcome. Preserve the checkout and references. |

**Recheck status** never signs a replacement payment. It reconciles the stable native request and may resume observation of a transaction already known to the server. If construction never started and no native process lock exists, it permits a fresh reviewed fee quote for the same request. A saved signed order can be attached idempotently without signing a new intent. Unknown markers or stale locks are not cleared automatically.

If a restart leaves a lock, first determine whether its PID/native wallet process still exists. A stopped server may leave a child process finishing its proof. Do not delete a lock or marker merely because the browser disconnected. Use the original `docs/RUNBOOK.md` procedure to inspect the saved transaction and chain status.

There is no automatic refund. Operator recovery must check the existing Base hash, canonical Zcash funds and the intended refund recipient before any new transaction. A confirmed Base revert may use the original verifier's explicit retry procedure after a fresh scan. Keep the same order and record its recovery; do not create a new payment to resolve it.

## Tests and live evidence

```powershell
npm.cmd run typecheck
npm.cmd run typecheck:web
npm.cmd test
cargo test --locked --offline
forge test
npm.cmd run wallet:build
npm.cmd run test:ui
```

UI tests require installed Microsoft Edge and use Playwright 1.64.0 plus axe-core/playwright 4.13.0. They intercept all application API calls and are clearly labeled synthetic. They never sign or send real transactions. The Node integration suite uses disposable Anvil accounts; it does not claim a real chain payment.

`scripts/live-wallet-ui.ts start --allow-testnet-spend` is a separate, opt-in real browser exercise used for this delivery. It clicks all three approval screens, records the exact reviewed terms and saves a one-run marker before starting. It refuses a second start; do not delete that marker to repeat a purchase. `node --import tsx scripts/live-wallet-ui.ts status` uses the saved private browser session for read-only progress and screenshots. The normal user flow is the launcher and browser, with no terminal commands.

See [Phase 1 results](PHASE1-RESULTS.md), [browser threat review](PHASE1-SECURITY.md), and the preserved [Phase 0 results](RESULTS.md).
