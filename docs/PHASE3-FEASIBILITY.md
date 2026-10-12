# Phase 3 feasibility — 2026-10-12

## Pre-implementation audit and baseline

Read the Phase 0–2 results, runbooks, architecture and security/limitations documents. Phase 1 checkpoint is `3dfae1d`; Phase 2 is present as uncommitted source and sanitized evidence on `codex/phase2-connectivity`. Preserve that complete state as the Phase 3 starting checkpoint, then work on `codex/phase3-marketplace`. Private runtime backups stay gitignored. No existing key, historical evidence or Rust dependency is replaced.

Baseline: service and web typechecks pass; 40 Node tests, 15 Foundry tests, 4 offline locked Rust tests, and 5 browser UI tests pass. The existing production build serves those UI tests. Node SQLite remains experimental; Foundry's user-cache permission warning and Rust hard-link fallback do not invalidate passing checks.

Read-only live inspection found Base chain ID 84532, user balance 9,999,873,999,999,741 wei and provider balance 99,983,502,399,989,497 wei. Zcash payer has 9,460,000 spendable zatoshis; merchant has 3,000,000. Both scanned through tip 4,492,678. The existing native server/library consensus guard passed during actual synchronization. These are observations, not fixed future balances. No transfers were initiated by this audit.

The existing user signer, exact-origin popup permissions, native payment signer, ten-confirmation note verifier, durable raw-transaction persistence and replay maps can be extended within their documented trusted-local boundary. The backend must never load the user's EVM key. Same-OS-user compromise remains outside the isolation guarantee. The existing zero-value mint/action executor must not become an arbitrary payable-call executor.

## Selected execution model

Use model A: an ordinary fixed-price ERC-721 marketplace has `buy(listingId, recipient)` payable by any standard wallet. It verifies current listing, owner, approval, expiry and exact ETH value, consumes the listing before external calls, safely transfers the NFT directly to the selected recipient, and pays the seller atomically with reentrancy protection. Price changes require cancellation and a new listing ID. Listings are immutable. No ZecOne privilege is needed for ordinary purchases.

A separate immutable bounded executor accepts only that marketplace and a fully signed purchase quote. It rechecks listing/NFT/token/seller/price, exact calldata hash, recipient, Base Sepolia, expiry, simulated rate, gas budget, quote/order nonce and user signature; it forwards exactly the approved price. The provider funds this call and gas. It has no authority over the user's wallet. A separate local test seller will supply demo NFTs; its credentials remain gitignored. Setup and purchases use only existing testnet funds after tests pass.

## Quote, interpretation and private payment

The independent marketplace runs on a different loopback origin and uses the public Phase 2 provider. A documented custom RPC extension explicitly requests shielded-ZEC funding; ordinary `eth_sendTransaction` retains the user-funded path. Only the configured marketplace's exact purchase method is eligible. Authoritative listing/ownership/approval reads, calldata decode and simulation precede review; frontend metadata never supplies trusted price or recipient.

Demo policy: simulated rate **1 TAZ = 0.02 test ETH**, no real-market claim; zero slippage; maximum purchase value 0.001 test ETH; 0.0001 test ETH gas/liquidity reserve per quote including an explicit allowance for Base L1 fees. Integer ceiling arithmetic computes ZEC from price plus that reserve. A 0.0001 test ETH NFT therefore quotes 0.01 TAZ, plus the separately approved native Zcash network fee. The user approves an immutable quote and then independently approves a native shielded send. Quote expiry must allow ten Zcash confirmations and precede listing expiry. Unused gas reserve is a disclosed fixed demo charge, not an actual-fee conversion.

Persist the locally configured payer shielded refund destination before payment and bind its hash in the signed quote. Display it only inside the authenticated wallet. Failed settlements retain this destination, reason, payment and transaction audit for manual review. No automatic refund or refund-success state is implemented.

## Durability and liquidity

Reuse the existing Rust allocator/scanner and confirmed-note Store in a separate Phase 3 order database. Never inject payment observations through a web API. Keep stable native send UUIDs and persist signatures, order IDs and raw Base transactions before broadcast. Serialize relayer nonce use under the existing service lock; an unresolved older transaction blocks later execution. Reserve price plus gas allowance atomically per accepted quote; concurrent requests must not reserve more than observed provider balance. Recheck liquidity immediately before signing. External use of the provider key invalidates the operational reservation assumption and can force recovery.

Revalidate listing state before payment and before execution. Confirmed payments whose listing is sold/cancelled/expired/changed, liquidity is insufficient, estimation fails, execution reverts, or ownership mismatches enter explicit manual recovery. Unknown broadcasts retain the exact hash/raw bytes and cannot be replaced. Canonical Base receipt, exact purchase/executor events, replay consumption and `ownerOf` require three confirmations. Reorgs remove pending authorization or open recovery after execution; restart must never produce a second purchase. Post-payment browser disconnect does not cancel an already approved durable order.

## Dependencies and official sources

Keep Solidity 0.8.28, viem 2.57.4 and OpenZeppelin 5.6.1 from the existing lockfile. Upstream OpenZeppelin lists newer releases; this prototype reuses the already pinned implementation and tests its ERC-721, EIP-712/ECDSA and ReentrancyGuard APIs rather than silently upgrading. No marketplace SDK, external exchange API, WalletConnect credential, bundler or paymaster is required.

The NU7 family remains pinned: zcash_client_backend 0.25.0-pre.1, zcash_client_sqlite 0.23.0-pre.1, zcash_keys 0.17.0-pre.1, zcash_protocol 0.11.0-pre.0, zcash_primitives/zcash_proofs 0.31.0-pre.1; Cargo.lock unchanged. TLS lightwalletd is `https://testnet.zec.rocks:443`; public Base Sepolia RPC is `https://sepolia.base.org`. Keys stay local, services bind loopback, and lightwalletd/RPC honesty remain trust assumptions.

- [ERC-721 ownership, approvals and safe transfer](https://eips.ethereum.org/EIPS/eip-721)
- [OpenZeppelin ERC-721 implementation](https://docs.openzeppelin.com/contracts/5.x/api/token/erc721)
- [OpenZeppelin ReentrancyGuard](https://docs.openzeppelin.com/contracts/5.x/api/utils)
- [OpenZeppelin EIP-712 and ECDSA](https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography)
- [OpenZeppelin maintained releases](https://github.com/OpenZeppelin/openzeppelin-contracts/releases)
- [Base Sepolia chain identity](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_chainId)
- [Pinned Zcash protocol history](https://github.com/zcash/librustzcash/blob/main/components/zcash_protocol/CHANGELOG.md)
- [Existing exact Zcash APIs and prerelease risks](FEASIBILITY.md)

The outcome is a trusted local testnet payment processor with prefunded Base liquidity. Base does not accept native ZEC; no asset bridge, anonymity guarantee, production exchange, or ERC-4337 claim is made. Stop after Phase 3.
