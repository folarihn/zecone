# Functional capability matrix

Checkpoint: `57e3b5d`, inspected 20 October 2026. This supersedes the NFT-first delivery priority; it does not erase historical results. Status describes the complete path, not just a decoder or balance screen.

- **Working end-to-end, historical bounded testnet demonstration:** shielded testnet ZEC → SOL delivery; shielded testnet ZEC → the pinned Raydium devnet WSOL/test-token swap. Both completed journals, finalized receipts, signed evidence and duplicate/refund vetoes were rechecked using read-only originals and disposable backups. These are operator-mediated profile workflows, not a general-purpose unified-wallet flow.
- **Working end-to-end historically, not revalidated as fresh deployments here:** Base Sepolia mint, marketplace purchase and controlled AMM swap; Ethereum Sepolia and Robinhood testnet marketplace purchases. See the existing Phase 0/3/4A/4B results. No new listing, inventory or live compatibility guarantee follows from these demonstrations.
- **Working only in isolated tests in this change:** wallet economic review → session/digest-bound explicit financial-creation authorization → original `SolanaSettlement.quote` for SOL delivery and the existing CPMM swap. The new local HTTP handler supplies review only. It rejects financial/signing paths. The library's financial creation gate defaults off and is exercised only against disposable databases.
- **Dry-run only:** imported EVM intent → explicit preview consent → Base Sepolia purchase quote → quote review → dry-run checkout. Its IDs and approval flags are not financial authorization. Two synthetic read clients are not independent live providers.
- **Dry-run/read-only:** restricted local Solana transaction inspection; public pool validation; Base and Solana mainnet identity reads. No new exact transaction simulation was performed by the public pool probe.
- **Missing:** ZEC-funded native EVM delivery adapter; ZEC-funded ERC20 delivery adapter; ZEC-funded generic SPL delivery adapter. Existing direct EVM/SPL transaction builders and portfolio reads do not provide payment authorization or destination settlement guarantees for these actions.
- **Missing integration:** normal wallet startup mounting the new Solana review handler with fresh isolated checkout profiles; payment-address allocation per new checkout; complete user-owned recipient verification for general imported actions; reviewed financial reservation across independently created Solana profiles; browser review-to-operator execution handoff. Existing dedicated Phase 7 profiles must not be recycled to bypass these requirements.
- **Blocked by configuration/authorization:** new testnet proof through that integrated path needs a fresh watch-only checkout profile, appropriate inventory, a selected locally controlled recipient, and separately approved payment/signing plan. Existing historical orders remain closed. No such new payment or transaction was authorized in this task.
- **Not implemented/disabled:** mainnet shielded payment verification and settlement; production signer isolation; general dApp arbitrary execution; live refunds without separate-device validation.

## Actual dApp compatibility

EVM discovery, origin/account permissions, revocation and transaction interception are fixture-tested. OpenSea/Uniswap discovery has real-site evidence, but authenticated current-build transaction execution is not verified. Historical OpenSea profile/login evidence does not certify current purchase compatibility. Solana Wallet Standard remains connection-only; it does not advertise generic signing. A distinct ZEC-funded checkout must report its own result rather than impersonate `eth_sendTransaction` or Solana wallet signing.

## Evidence

`functional-evidence/public-readiness.json` contains fresh public reads. `completed-order-audit.json` contains sanitized completed-order preservation and replay checks. No source payment identifiers or payment-to-recipient joins are included. Regression logs distinguish synthetic execution from real public-chain observations.
