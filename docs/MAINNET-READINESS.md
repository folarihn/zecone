# Mainnet readiness — spending disabled

20 October 2026. **NO-GO for mainnet payments or execution.** The new module is isolated from testnet execution registries and exposes network identity reads only. It has no keys, addresses, generic RPC method, calldata, transaction submission or refund interface. `config/mainnet-readonly.example.json` is a disabled planning template, not an activated deployment. New strict testnet EVM/SPL transfer adapters and the opt-in financial handoff do not change this: they reject mainnet chain IDs, use demo ZEC pricing and cannot execute without separately provisioned testnet relayer credentials and an explicit capped approval.

## Configuration and evidence

- Zcash: network mainnet reserved in the template, no provider or watch backend activated. Existing native testnet code must not be relabeled mainnet. Require verified network/upgrade identity, TLS lightwalletd and independently verified chain evidence before implementing owned-note mainnet payment verification. No viewing keys are sent to a service.
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
9. Monitoring for stuck/expired/uncertain orders, provider divergence, liquidity exhaustion and fee spikes; operator shutdown must stop new claims without erasing signed-attempt evidence. An emergency switch is not yet installed for a production runtime.
10. Separately authorized capped testnet end-to-end wallet runs and security review before any explicit mainnet activation decision.

No provider purchase, production credential provisioning, mainnet payment request, signing or broadcast occurred. Solana recipient activity remains public; the trusted settlement operator can correlate funding/execution. No anonymity or trustless-bridge claim is made.
