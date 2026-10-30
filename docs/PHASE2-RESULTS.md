# Phase 2 delivery report

**Phase 2 passed on 2026-10-12 on testnets.** The local ZecOne wallet connected a separate-origin dApp through its EIP-1193 popup, obtained visible approvals for account access, signatures and a Base Sepolia self-transfer, and honored revocation. A second visible approval paid 0.01 TAZ from the shielded Zcash wallet. After ten required Zcash confirmations, the prefunded Base Sepolia relayer executed the single fixed action for the user's locally controlled EOA. No mainnet transaction or fabricated payment was used.

## Live evidence

The test dApp at `http://127.0.0.1:4321` connected to the local wallet at `http://127.0.0.1:3210`. The supported methods exercised were `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `personal_sign`, `eth_signTypedData_v4`, and `eth_sendTransaction`. The real EVM transaction was a zero-value self-transfer from and to the user's EOA on Base Sepolia. The wallet later revoked the origin; subsequent account access returned no accounts and a transaction request returned provider error 4100.

| Proof                     | Result                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| dApp transaction          | [`0x241546b7d18764c0cde3ab767600dc2ae1e09c2b5eeed511f0ba9c99419b3df2`](https://sepolia.basescan.org/tx/0x241546b7d18764c0cde3ab767600dc2ae1e09c2b5eeed511f0ba9c99419b3df2), success, Base Sepolia block 48,013,543 |
| Zcash payment             | `eea00e872a3b1be22a449c5af8c1c6c82385cdb64e06a5a8993290f0304f66ca`, shielded output of 1,000,000 zatoshis (0.01 TAZ), block 4,491,670, 12 confirmations against a 10-confirmation threshold                        |
| Sponsored Base action     | [`0x74180b014e5422ab97928a1e8aff0afbe7511072fcfe6c0b14552202f686e730`](https://sepolia.basescan.org/tx/0x74180b014e5422ab97928a1e8aff0afbe7511072fcfe6c0b14552202f686e730), success, Base Sepolia block 48,014,070 |
| Fixed action contract     | `0xe1ae787f137c1280ab9bbcdc7be65490d5543707`                                                                                                                                                                       |
| User-controlled recipient | `0x1865Dd77Bfcb632571d3c93144D5634F0D93c714`                                                                                                                                                                       |
| Reconciliation            | Exactly one `ActionExecuted` event, consumed order true, recipient record count 1, one settlement broadcast attempt, canonical receipt and 135 Base confirmations at final verification                              |

The sponsored action records the fixed ZecOne note for the user's EOA; it does not mint an NFT, swap ZEC, or bridge assets. The separate Phase 1 proof remains the actual NFT mint result. Zcash shielded output amount and attribution are verified by the local merchant wallet scanner; public Zcash explorers cannot independently reveal this shielded output.

Detailed sanitized evidence is in [the live dApp record](phase2-evidence/live-dapp.json), [the independent payment and action reconciliation](phase2-evidence/sponsor-final.json), [the reviewed transaction](phase2-evidence/transaction-review.txt), and the two approval screenshots. The reproducible read-only verifier is `npm.cmd run phase2:verify-live`.

## Implementation and boundaries

The deliverable includes an opt-in EIP-1193/EIP-6963-compatible popup SDK, origin-scoped permissions and revocation, transaction review/simulation, local EOA signing, durable broadcast reconciliation, a separate-origin test dApp, an immutable fixed-action Solidity contract, a shielded payment checkout, and integration with the existing confirmed-payment verifier. It reuses existing credentials; it adds no secrets or external wallet service.

It remains a local single-user testnet prototype. It does not inject into arbitrary websites, support WalletConnect, arbitrary chains, ERC-4337, paymasters, contract wallets or EIP-1271 signatures. The ZEC-to-action correlation is visible to the settlement operator. Automatic refunds are not implemented: uncertain or failed settlement stays in the auditable recovery state for manual review. See [limitations](PHASE2-LIMITATIONS.md) and [security assumptions](PHASE2-SECURITY.md).

## Automated validation

The final source passed the production wallet build, both TypeScript checks, 40 Node tests, 15 Foundry contract tests, 4 offline Rust tests, 5 browser UI tests, `git diff --check`, and a fresh read-only live reconciliation. The automated cases include duplicate and underpaid payments, confirmation thresholds, expiry, retries after confirmed reverts, crash/restart recovery, replay, unauthorized dApp requests, signature and transaction approval gates, and origin revocation. No test used a synthetic payment as live evidence.

Historical Phase 0/1 evidence remains preserved. Phase 2 is complete; stop here. Do not begin Phase 3 or production deployment without a separate user request.
