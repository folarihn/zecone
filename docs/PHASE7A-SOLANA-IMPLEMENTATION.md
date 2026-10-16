# Phase 7A Solana devnet implementation

16 October 2026. Starting checkpoint `cf2a0ff`, clean working tree. Reviewed PROGRESS, Solana integration plan, EVM privacy research and both Phase 6C QA reports. Baseline Node suite: 230 passing; baseline browser UI: 20 passing. Existing EVM adapters, origin-scoped Dapps, local Sessions/CSRF and wallet views are reused. Existing settlement workers and historical databases are not instantiated by the new validation server.

## Delivered scope

`services/solana/network.ts` uses official Kit RPC with full devnet genesis verification on every operation, confirmed slot/height/blockhash reads, balances, parsed token accounts, simulation, fees and signature status. Transport deadlines, bounded retries, pacing and busy rejection prevent unbounded calls. No fallback endpoint, airdrop request or transaction submission method exists.

`accounts.ts` creates independent disposable payer/recipient accounts using secure randomness and Kit's Ed25519 signer. Exclusive local files, public-address projections, explicit unlock and lock are separate from EVM/Zcash key handling. The browser server keeps Solana signing locked. `tokens.ts` displays exact integer balances, decimals, mint/account/program addresses, ATA identity and account status for legacy SPL and Token-2022. No symbols, prices or metadata are invented. Unsupported extensions are read-only; confidential balances are unavailable rather than reported as zero.

`transactions.ts` builds one canonical legacy SOL transfer or SPL TransferChecked, verifies account roles/program/fee payer by exact SDK-decoded message comparison, validates mint decimals/owners/ATAs and rejects unsupported authority or extension configurations. Preparation checks fee cap/blockhash and simulates the exact unsigned wire transaction. `signing.ts` is an independent local-only explicitly approved signing boundary, exercised with ephemeral test accounts; it is not exposed to websites. `journal.ts` persists immutable action IDs, exact review digests, states and signed bytes, enforces duplicate-signature protection and recovery exclusion, and moves interrupted claims to manual review. Broadcast is always disabled.

`confirmation.ts` distinguishes RPC agreement, disagreement and outage. RPC status distinguishes unknown, processed, confirmed, finalized and failed. A finalized status is not itself proof of correct token delivery; no live settlement accepts it here. An independent live endpoint and effect verifier remain future requirements.

`services/execution/solana-destination.ts` adds a separate `family: solana` quote/status policy without changing historical EVM signed intents. A synthetic-only integration harness binds payment/order IDs and confirmation threshold, prepares and simulates, and ends awaiting explicit approval. Historical payments are rejected as new authorization. Recovery vetoes block further execution. No ZEC payment was made and no ZEC-funded Solana purchase occurred.

The wallet adds a Solana tool view with account selection, receive/copy, SOL and token account balances, real simulation preview/fees/expiry and origin revocation. Empty wallets and unavailable RPCs are distinguished. Swaps and NFT purchases are explicitly unsupported. Existing wallet tabs and adapters remain intact.

## Provider and manual EVM validation

Extension **0.4.0** adds separate Wallet Standard discovery, devnet accounts, explicit origin-bound connection/account selection, disconnect, change events and signing-request rejection hooks. The local popup binds the real browser origin and random channel. There is no Phantom impersonation and no `solana:signAndSendTransaction` feature. Signing hooks are **rejection-only in the browser backend**, not working arbitrary dApp signing. Local-only approved transaction signing is separately tested; no funded live account was signed.

The new `phase7a:wallet` server reuses the existing paired wallet UI and EVM connector with a fresh disposable EVM key, new databases, local ownership proof and `signingDisabled:true`. It starts no settlement workers. The existing snapshot viewer cannot approve connections, so it is not presented as the manual testing backend. [Windows instructions](PHASE7A-MANUAL-DAPP-TEST.md) cover unpacked extension build, separate Chrome profile, public address comparison, supported-testnet switching, signature rejection, revocation and safe evidence collection. Existing extension diagnostics show origin/account/chain/pending/request metadata; the guide includes a read-only EIP-6963 announcement check.

**Actual Uniswap, PancakeSwap, Sushi, OpenSea, Jupiter and Raydium website connections were not verified in Phase 7A.** Browser tests use explicitly synthetic fixture sites. Official pages were fetched read-only to verify entry URLs; that is not a compatibility result. No new public site profile or login signature was created.

## Actual devnet evidence

[Machine-readable RPC/simulation capture](phase7a-evidence/devnet.json), captured 16 October 2026 at 09:48:33 UTC:

- Endpoint: `https://api.devnet.solana.com`, no credentials or paid services.
- Full genesis: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
- Confirmed slot `511670769`, block height `498888762`.
- Payer: `dFmJUGpAqERawUkauLZMQdRmXVBffPqTCgX6XrM4u8k`, **100,000,000 lamports / 0.1 devnet SOL** following user funding.
- Recipient: `HiGp8uCTupsv795g3iqK4Tex1K3hLdNryrZ6sukquRS3`, zero SOL at capture.
- Both token account lists were empty. These are real empty results, not mocked holdings.
- Exact unsigned SOL preview: 1,000,000 lamports to the recipient, estimated fee 5,000 lamports, simulation error `null`, 150 compute units, state `AWAITING_EXPLICIT_APPROVAL`.
- Preview ID `eae17489-eada-4711-bddc-a300e8383478`; message/wire digest `b7e2026fc8f386eae61ace7b62b11cd761faa44efd83fb0ebfd3e435a15e6470`; last-valid block height `498888923`.

That blockhash is short-lived and the saved preview expires; it is **not an approval, signature, broadcast, transaction reference or settlement**. A future transaction requires fresh preparation and separate explicit approval. No approval for broadcasting was requested or received in this phase. The first unfunded read returned zero balances and `AccountNotFound` in simulation; after the user funded the account, the real simulation succeeded. No success was simulated and passed off as a payment.

The real isolated backend was also exercised through Playwright without API mocks: public devnet balance and simulation rendering, mobile accessibility and denied mutation routes. [Browser metadata](phase7a-evidence/isolated-browser.json), [real-backend tests](phase7a-evidence/real-api.txt), [desktop screenshot](phase7a-evidence/real-solana-desktop.png), [mobile screenshot](phase7a-evidence/real-solana-mobile.png). These are local product checks, not external dApp tests. The EVM ownership signature in this check uses only the newly generated disposable account and a local challenge.

## Dependencies and source verification

Pinned additions: `@solana/kit` **8.5.0**, `@solana-program/system` **0.15.0**, `@solana-program/token` **0.17.0**, `@wallet-standard/wallet` **1.1.1**. Registry versions were queried and installed with `--save-exact`; transitive resolution is in package-lock. Install audit reported zero vulnerabilities at that time; this is not a security audit. Existing application versions were not upgraded. Node remains >=24.12 <25. No legacy web3.js object/Kit conversion was introduced.

SDK functions and instruction parameter types were checked against installed declarations before implementation. The Wallet Standard package is a pinned specification/reference dependency; the extension implements its small registration event protocol directly in plain JavaScript without bundling a signing SDK into websites.

- [Official Kit primitives and signing/RPC examples](https://www.solanakit.com/docs/advanced-guides/kit-without-a-client) and [maintained Kit repository](https://github.com/anza-xyz/kit).
- [Official cluster configuration](https://solana.com/docs/references/clusters) and [validator devnet genesis configuration](https://beta.docs.solanalabs.com/clusters/available). The full genesis differs from a shortened CAIP chain identifier; the implementation pins the full value verified by live RPC.
- [Wallet Standard Solana extensions](https://github.com/wallet-standard/wallet-standard/blob/master/extensions/solana.md), plus installed `@wallet-standard/wallet` registration implementation.
- [Token account/ATA model](https://solana.com/docs/tokens/basics/create-token-account), [simulation RPC](https://solana.com/docs/rpc/http/simulatetransaction), [confirmation/expiry](https://solana.com/developers/cookbook/transactions/confirmation).
- [Solana Foundation faucet instructions](https://solana.com/developers/cookbook/development/airdrops-and-faucets). User funding was observed; no airdrop transaction was requested by ZecOne.

## Validation and preservation

Final: **366 passing tests** — [248 Node](phase7a-evidence/node.txt), including [18 focused Solana/backend tests](phase7a-evidence/solana-tests.txt); [23 UI](phase7a-evidence/ui.txt); [17 installed-extension](phase7a-evidence/extension.txt); [6 historical read-only UI](phase7a-evidence/historical-ui.txt); [3 real isolated-backend UI](phase7a-evidence/real-api.txt); [52 Solidity](phase7a-evidence/contracts.txt); [8 Rust wallet](phase7a-evidence/rust-wallet.txt); [5 watch](phase7a-evidence/rust-watch.txt); [4 signer](phase7a-evidence/rust-signer.txt). One pre-existing expensive standalone Rust proof test remains ignored; the Node integration suite exercises isolated native proof/signing. [Node typecheck](phase7a-evidence/types.txt), [web typecheck](phase7a-evidence/types-web.txt), [lint](phase7a-evidence/lint.txt), [extension packaging](phase7a-evidence/extension-build.txt) and [production build](phase7a-evidence/build.txt) passed. The original mobile selector overflow was caught and fixed before the final passing UI run. Test screenshot output can now be redirected to Phase 7A without replacing historical screenshots.

[Preservation report](phase7a-evidence/preservation.json) checks the original inventory: 537 files, zero changes. No original seed, wallet, quarantine record, archived payment or unsigned refund evidence was modified. No Solana/EVM transaction, shielded payment or refund was broadcast. Live refunds remain disabled.

## Reproduce and limitations

Use [the Windows guide](PHASE7A-MANUAL-DAPP-TEST.md) to build, pair and inspect the isolated wallet. `npm run phase7a:check` performs real devnet reads and unsigned simulation, and saves a new capture; it never submits. `npm test`, `npm run test:ui`, `npm run test:extension`, `npm run test:phase7a`, both typechecks, `npm run lint` and `npm run wallet:build` exercise the JavaScript/product layers. Set `$env:ZECONE_QA_EVIDENCE_DIR='docs/phase7a-evidence'` before UI/historical QA. `npm run test:phase6c` requires the existing private historical snapshot; a fresh clone cannot reproduce that user's data. Native and Solidity commands match Phase 6C; run native signer compilation separately from Node proof integration on Windows. `npm run phase7a:preserve` requires the existing private preservation inventory.

Live SPL simulation is not verified: these disposable accounts have no configured mint/token balances. Its canonical construction/decimal/account policy is covered by synthetic tests; live token setup would require separately approved devnet transactions. Browser signing is deliberately rejection-only; generic dApp transaction import, cross-tab proactive revocation events, automatic confirmation polling, independent RPC effect consensus, swaps/NFTs and a live ZEC-funded relayer remain unimplemented. Plaintext development credentials and RPC trust are detailed in [security boundaries](PHASE7A-SECURITY.md). No production or universal dApp compatibility claim is made.

Recommended Phase 7B remains a separately authorized testnet fresh-recipient EVM privacy design/recovery review, as documented in the existing privacy research. Do not treat Solana connectivity as evidence of unlinkability or private destination execution. Phase 7B was not started.
