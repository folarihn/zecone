# Phase 1 implementation report

**The real browser checkout passed on 2026-10-12.** ZecOne displayed actual local balances, verified user ownership through an explicitly approved signature, created a signed order, displayed the native fee quote, accepted a separate shielded-spend approval, waited for ten Zcash confirmations, and minted one NFT on Base Sepolia to the user-controlled wallet. No frontend success state was fabricated. Phase 2 has not begun.

## Live transaction evidence

| Item | Verified value |
| --- | --- |
| Browser checkout | `0a84e2d9-200a-4ec8-8d30-0f57ce7603b9` |
| Signed order / on-chain replay key | `0x662f67628709fea2efc103921b0da0b93b2938a878fcc68b0c3d58a9d4d0da4a` |
| Shielded payment | `c56581846c507113c62f0ede6e742261852f5c65ddb7b590c3a4cc08ec782b57` |
| Amount / approved network fee | 0.01 TAZ / 0.0001 TAZ; total 0.0101 TAZ |
| Zcash receipt | Ironwood pool 4, output 1, block 4,491,496 |
| Authorization | Fully scanned tip 4,491,505: **exactly ten confirmations**; 1,000,000 confirmed zatoshis |
| Base mint | [`0x37a41954026391efb578df5b51926a1552a6335d1e193442e2eb4adda948bf42`](https://sepolia.basescan.org/tx/0x37a41954026391efb578df5b51926a1552a6335d1e193442e2eb4adda948bf42) |
| Base network / block | Sepolia, chain 84532 / block 48,012,067 |
| Existing contract | `0x3a3f3b03349b5a9060d35c8252678f59dabf2a52` |
| Verified NFT owner | `0x1865Dd77bFcb632571d3c93144D5634F0D93c714` |
| Token ID | `46219665903707519431943950824841149295460147199022809301565336118776875244106` |
| Independent verification | Successful canonical receipt, exact mint event, matching `ownerOf`, consumed order; 42 Base confirmations at 08:08:24 UTC |
| Duplicate check | One order, one attributed shielded output, one mint event, one broadcast attempt |
| Resulting user balances | 0.1047 TAZ spendable; user Base balance remains 0.01 test ETH; two verified ZecOne NFTs |

The app required three Base confirmations before declaring completion. The later independent read-only verification found 42. The native wallet proves/scans locally; shielded recipient/amount verification comes from the local merchant wallet, not from a public explorer's visibility into shielded data.

The live run was driven through the actual browser controls with the user's authorization. It approved all three visible dialogs; it did not call a hidden mint shortcut or inject payment observations. The test harness is separate from default tests and protected by an opt-in flag and a durable one-run marker. Closing its browser did not cancel already authorized background work.

Evidence:

- [Exact reviewed payment terms](phase1-evidence/approved-payment-review.json)
- [Independent receipts, payment block, authorization snapshot and counts](phase1-evidence/live-verification.json)
- [Real browser checkout status, balances, owned NFTs and JavaScript errors](phase1-evidence/live-ui.json)
- [Private-key preservation, live HTTP boundary checks and restart idempotency](phase1-evidence/preservation-and-boundary.json)
- [Ownership approval](phase1-evidence/ownership-approval.png), [order approval](phase1-evidence/order-approval.png), [payment approval](phase1-evidence/payment-approval.png)
- [Completed checkout](phase1-evidence/checkout-completed.png), [desktop wallet](phase1-evidence/wallet-desktop.png), [mobile wallet](phase1-evidence/wallet-mobile.png)

These artifacts are local repository evidence. No public deployment or automatic upload was performed. Sharing the report/screenshots would disclose selected testnet activity and correlation; private keys, seeds, viewing keys, raw signatures, cookies and internal Zcash account UUIDs are excluded.

## Delivered application

- Next.js 16.4.0 / React 19.3.0 / Tailwind 4.3.3 local wallet with responsive desktop/sidebar and mobile navigation, real balances, sync state, recorded cross-network activity and live ownership checks for known ZecOne collectibles.
- Loopback-only gateway with single-use local pairing, hashed session-cookie storage, one-hour session expiry, HttpOnly/SameSite cookies, origin/Host/fetch checks, CSRF protection, rate limiting, private/no-store responses and nonce-based production CSP.
- Separate local user-signing helper for nonce/expiry-bound ownership proof and fixed EIP-712 mint authorization. The relayer continues to use its separate key and never owns the destination NFT.
- Actual native shielded wallet summary and unsigned fee proposal. Payment approvals bind the order, current session, quote expiry and fee ceiling; Rust checks the ceiling before signing/proving.
- Durable checkout IDs and stable native send request IDs, atomic duplicate protection, existing ten-confirmation verifier, existing Base receipt reconciliation and existing contract replay protection.
- Visible awaiting/detected/confirming/settled/executing/completed/failed/review states, retained saved checkouts, safe status reconciliation and explicit manual recovery guidance. Automatic refunds are not claimed.
- Double-click launcher, build instructions, threat review, test scripts and documented boundaries. Normal use requires no terminal commands after setup.

## Validation

| Check | Result / evidence |
| --- | --- |
| Rust tests | 4 passing: original schema/network/key tests plus fee-ceiling enforcement; [log](phase1-evidence/rust-tests.txt) |
| Solidity tests | 8 passing, including 128 fuzz runs for user ownership/replay; [log](phase1-evidence/contract-tests.txt) |
| TypeScript tests | 32 passing, preserving all 20 Phase 0 tests and adding 12 browser-boundary/approval tests; [log](phase1-evidence/typescript-tests.txt) |
| TypeScript checks | Service/tests and frontend type checks; [service log](phase1-evidence/typescript.txt), [frontend log](phase1-evidence/typescript-web.txt) |
| Production build | Next webpack build; [log](phase1-evidence/build.txt) |
| Responsive/accessibility | 3 Playwright tests: desktop/mobile overflow, WCAG A/AA axe checks, focus-contained dialog, keyboard escape, navigation and no signing from merely viewing/canceling; [log](phase1-evidence/ui-tests.txt) |
| Real browser runtime | No uncaught JavaScript page errors in the recorded live run; separate real on-chain verification above |

The 12 new service tests cover one-use pairing, hashed cookies, expiry/revocation, CSRF/Host/Origin, unauthorized signing, valid/tampered/replayed ownership proofs, duplicate/concurrent order creation, stale/cross-session/duplicate fee approvals, exact signer arguments, interrupted-send review, confirmation progress and API data minimization. Original tests retain underpayment, overpayment, expired orders, failed transactions, retries, reorgs and replay coverage.

Synthetic fixtures are confined to test files. The real app uses the actual native wallet and RPC data. Automated accessibility checks are not a complete human accessibility audit. Initial contrast failures were corrected; the tests do not disable contrast rules. The local Anvil test remains an integration test, not real-chain evidence.

## Preservation and operational limits

Phase 0 source was checkpointed at `482fc573fd1b268a7aaadbbaed66e435817172ab` before edits. Private runtime backups remain under `.secrets/phase1-checkpoint`. Existing seeds, keys, wallet DBs, deployment and `docs/evidence/` were preserved; the normal authorized transactions advanced the existing wallet state. No new contract was deployed. The initial tested Phase 1 checkpoint is `ee64350` on `codex/phase1-wallet`.

Final read-only checks compared the four user/merchant/relayer key and seed files against their private backups without disclosing their contents or fingerprints: all matched. Git comparison confirmed that the original Phase 0 evidence, results, Cargo lockfile and native dependency manifest were unchanged. After restarting the final application build, the checkout remained completed with exactly one recorded Base broadcast attempt. Actual HTTP checks rejected unauthenticated dashboard reads, foreign origins and missing CSRF, returned 404 for private/configuration paths, and confirmed response redaction and no-store headers.

The pinned official NU7 prerelease Rust dependency set and Cargo lockfile remain unchanged. A Next Turbopack CSS subprocess failed on this Windows setup; supported webpack mode builds successfully and is the default here. Next telemetry is disabled. Windows hard-link cache warnings affect build speed, not the passing Rust checks.

This is a single-user local prototype with plaintext, OS-protected testnet keys. The signer and relayer are separate code/key paths under one OS user; a malicious same-user process or compromised gateway can access them. The gateway must not be exposed through a tunnel or public server. The local operator knows the checkout linkage. The lightwallet server/RPC and trusted relayer assumptions from Phase 0 remain. A finalized mint cannot be undone if Zcash later reorganizes.

NFT discovery and Base history cover recorded ZecOne mints, verified against `ownerOf`; arbitrary collections and complete Base transfer indexing are not implemented. Collection art is a local illustration; the contract metadata has no image. No Solana, arbitrary dApp connectivity, external Zcash wallet connector, production bridge, price oracle, ERC-4337 paymaster or automatic refund was added.

Use [PHASE1-RUNBOOK.md](PHASE1-RUNBOOK.md) to open, reproduce, test and recover the app. The original [Phase 0 results](RESULTS.md) remain the historical record. **Work stops after Phase 1.**

## Official implementation references

- [Next.js installation / requirements](https://nextjs.org/docs/app/getting-started/installation)
- [Next.js custom server](https://nextjs.org/docs/app/guides/custom-server)
- [Next.js CSP and nonces](https://nextjs.org/docs/app/guides/content-security-policy)
- [Tailwind's Next.js integration](https://tailwindcss.com/docs/installation/framework-guides/nextjs)
- Zcash/Base primary references and exact NU7 libraries remain in [FEASIBILITY.md](FEASIBILITY.md).
