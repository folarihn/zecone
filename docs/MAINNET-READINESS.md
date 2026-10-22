# Mainnet readiness — spending disabled

> Acceptance update (21 October 2026): [MAINNET-ACCEPTANCE.md](MAINNET-ACCEPTANCE.md) is authoritative and [MAINNET-OPERATOR.md](MAINNET-OPERATOR.md) records the new operator boundary. Full-transaction UFVK decryption is implemented, but no authenticated mainnet scan config or owned-note fixture exists. The operator CLI, isolated signer and fenced single-writer lease are implemented and fixture-tested; provisioning is tested only with disposable credentials. Genuine pricing/providers, production signer isolation and live acceptance are still missing. Mainnet remains NO-GO, and execution is disabled by default.

22 October 2026. [The controlled pilot](MAINNET-PILOT-PLAN.md), [public-launch plan](MAINNET-PUBLIC-LAUNCH.md) and [setup guide](MAINNET-SETUP-GUIDE.md) now define the cheapest safe two-transfer acceptance path and the launch-grade topology. They do not authorize spending. `mainnet:operator execute` now invokes the native scanner in-process and no longer accepts a JSON snapshot; that handoff defect is closed, but independent providers, genuine signed prices, funded relayers, a controlled owned-note run and the remaining gates are still absent.

20 October 2026. **NO-GO for mainnet payments or execution.** The mainnet module
is isolated from testnet execution registries and exposes read-only identity
probes, exact unsigned transfer preparation and offline signed-bundle
verification. It does not generate addresses, load keys, sign, submit or refund.
`config/mainnet-profiles.example.json` is a disabled planning template, not an
activated deployment. New strict testnet EVM/SPL transfer adapters and the
opt-in financial handoff do not change this: they reject mainnet chain IDs, use
demo ZEC pricing and cannot execute without separately provisioned testnet
relayer credentials and an explicit capped approval.

## Exact planning and offline-verification boundary

Added after the prior readiness report:

- **No generated mainnet accounts.** Destination and relayer addresses are
  operator-supplied. A recipient proves control by signing an EIP-191 or
  Ed25519 ownership challenge; the service stores only the public binding.
- **Signer/relayer binding.** The offline signer public key must derive to the
  configured relayer. Base requires secp256k1; Solana requires Ed25519.
- **Exact unsigned preparation.** Base legacy EIP-155 construction reads
  finalized block, recipient EOA, relayer nonce/balance, gas and gas price from
  two independent providers. Solana constructs and simulates a legacy SOL
  transfer against the full mainnet genesis, a finalized anchor, both
  providers' fees and a shared recent blockhash.
- **Offline signed-bundle verification.** Base rejects any field mismatch,
  recovers the relayer signature and checks the canonical Base GasPriceOracle
  L1 fee on both providers. Solana verifies canonical wire encoding, exact
  message bytes, the single expected signer and the Ed25519 signature.
- **Operator-gated submission boundary.** `submitMainnetTransfer()` deliberately
  throws. `executeMainnetTransfer()` verifies fresh source authorization, exact
  signed bytes, a pinned Ed25519 execution authorization, current two-provider
  state, one-shot persistence, and no-retry uncertain handling in disposable
  fixtures. The operator CLI adds exact confirmation, signer approvals, a
  revocation-capable signer ledger and a fenced single-writer lease. No
  production credentials or live submission is activated.

Commands and file formats: [mainnet transfer preparation](MAINNET-TRANSFER.md).

This does **not** change the readiness verdict. The remaining blockers are
operator and infrastructure work, not missing transfer encoding:

1. No authenticated Zcash mainnet watch profile/UFVK, two configured independent
   providers, controlled owned-note run, or independent Merkle/consensus
   inclusion evidence exists. Full-transaction trial decryption is implemented.
2. No dedicated live relayer accounts, destination ownership proofs, RPC
   operators or offline signing device are provisioned in this repository.
3. No production price feeds are configured; signed-feed verification exists,
   but no live feeds or margin policy were supplied.
4. The operator CLI, one-shot executor, durable signed-bytes write-ahead,
   finalized receipt readers and uncertainty reconciliation are fixture-tested
   but the intended production single-writer deployment has not been validated.
5. No production emergency runbook, independent monitoring or separately
   approved capped live plan exists.

## Configuration and evidence

- Zcash: network mainnet reserved in the template; full-transaction UFVK trial decryption and two-provider transaction/block corroboration are implemented, but no production providers, watch profile, or authenticated owned-note acceptance run is activated. Require verified network/upgrade identity, TLS lightwalletd, and independent inclusion/consensus review before live payment verification. No viewing keys are sent to a service.
- Ethereum: chain ID 1 pinned. No production endpoint supplied or tested. Operator must select primary/secondary providers; no paid account or upgrade was purchased.
- Base: chain ID 8453 pinned; public `https://mainnet.base.org` identity checked successfully. PRIMARY_ONLY, identity scope only. Not a production endpoint SLA, listing verification, finality proof or liquidity check.
- Solana: full mainnet genesis hash pinned and public mainnet RPC identity checked successfully. PRIMARY_ONLY, identity scope only. The first development probe rejected a truncated genesis identifier; the implementation was corrected to the full hash and rechecked. Never accept a CAIP abbreviated identifier as the full RPC hash.

Independent operators must be explicitly identified and independence acknowledged. Different URLs alone never produce CORROBORATED. Even corroborated identity would not corroborate balances, pool state, receipts or source payments. Unavailable/wrong-network responses fail closed; diagnostics omit endpoint credentials and raw errors. HTTPS, bounded timeout, no redirects, fixed methods and empty parameters constrain this reader.

Official references: [Base chain IDs](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_chainId), [Solana genesis RPC](https://solana.com/docs/rpc/http/getgenesishash), [full Solana chain identity specification](https://github.com/ChainAgnostic/namespaces/blob/main/solana/caip350.md), [lightwalletd maintained implementation and threat-model links](https://github.com/zcash/lightwalletd/blob/master/README.md). Public provider observations are local evidence, not inferred availability guarantees.

## Required production gates

1. Separate fresh production credentials and roles; independently controlled signing/refund approval; hardware or separate-device isolation evaluated explicitly. Never reuse development keys. Password encryption or same-user DPAPI is not separate-device custody.
2. Tested encrypted recovery/backups, restore drills, signer lease/lock enforcement and emergency revocation. Existing plaintext legacy credentials remain unchanged and unsuitable for production activation.
3. Independent authenticated source/destination RPC evidence, canonical finality/reorg handling, restricted-provider monitoring and conflict shutdown. Provider independence is an operational fact, not a hostname inference.
4. Production pricing adapters for every supported pair, stale/disagreement rejection, quote expiry, locked paid economics, spread/risk/fee budgets. Current settlement rates are fixed testnet demo prices. Display-only market references do not price financial commitments.
5. Real reservation across relayer inventory and concurrent orders, native gas reserves, per-chain/token/recipient/order/daily caps, rent/data-fee accounting and replenishment policy. Do not convert a balance snapshot into a reservation claim.
6. Verified watch-only source payment authorization, unique note/payment binding, adequate network confirmations and no payment reuse. Seed/spending keys stay local to isolated signers.
7. Audited destination adapters, recipient ownership/proof and exact output verification, durable signed bytes before send, single submission claims, uncertainty reconciliation and duplicate vetoes. No arbitrary execution fallback.
8. Failed-delivery recovery and separately approved refunds with execution/refund mutual exclusion. Live refunds remain disabled pending separate-device validation.
9. Monitoring for stuck/expired/uncertain orders, provider divergence, liquidity exhaustion and fee spikes; operator shutdown must stop new claims without erasing signed-attempt evidence. A durable emergency pause and signer revocation exist, but production monitoring and on-call wiring are not installed.
10. Separately authorized capped testnet end-to-end wallet runs and security review before any explicit mainnet activation decision.

No provider purchase, production credential provisioning, mainnet payment request, signing or broadcast occurred. Solana recipient activity remains public; the trusted settlement operator can correlate funding/execution. No anonymity or trustless-bridge claim is made.
