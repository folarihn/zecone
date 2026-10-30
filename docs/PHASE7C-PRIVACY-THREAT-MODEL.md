# Phase 7C privacy threat model

16 October 2026. First deliverable, written before implementation at clean checkpoint `4ed111f`. Testnets only; live refunds disabled. Scope: one explicitly approved shielded payment and one bounded, public devnet SPL swap using trusted prefunded inventory. This is not a trustless bridge. No anonymity guarantee is offered.

## Actors and observations

1. **Public Zcash observers** see transaction IDs, inclusion heights, pool usage and public transaction structure. Fully shielded payment contents hide addresses and amounts from ledger observers, subject to protocol guarantees and wallet behavior. Transparent components, entry/exit patterns and timing can weaken inference resistance. Recipient viewing authority recognizes its own incoming notes. Shielding does not conceal our operator's order records.
2. **Public Solana observers** see the relayer, pool, program, mints, token accounts, recipient owner, exact quantities, fees, execution time and graph. A fresh recipient reduces obvious address reuse but is pseudonymous. Its later consolidation, spending or connection to a known website can link it to an identity. SPL transfers/swaps are not confidential.
3. **RPC providers** observe source IP, connection timing, queried addresses/accounts/signatures, submitted transactions and query patterns. Zcash compact-block/transaction fetches reveal synchronization metadata; the full viewing key must stay local. Solana selected-address queries expose that address; broadcast exposes its complete public instruction graph. TLS hides content from passive intermediaries, not the RPC operator. Pinning genesis is network protection, not privacy or consensus corroboration.
4. **DEX/liquidity providers** see public swaps, input/output, pool and recipient accounts. Offchain routing APIs additionally see client IP and quote parameters. A locally constructed single-pool route avoids a quote API but does not hide its onchain execution. No Zcash payment/order identifier should enter a DEX request, instruction, memo or explorer URL.
5. **ZecOne's operator** sees the incoming shielded payment, requested destination, parameters and timing. It can correlate both chains; random internal IDs do not change that. Necessary durable payment/authorization/recovery records retain this association privately. Restrict user-facing projections and diagnostics; do not claim cryptographic unlinkability from the operator.
6. **Malicious websites/extensions** can correlate connected addresses, cookies and timing, request arbitrary instructions, scrape URLs, or attempt local-API/CSRF abuse. Only paired authorized origins may query the selected account. No browser relayer signer, recipient secret, viewing key, operator correlation map or arbitrary execution endpoint is allowed. A fully compromised browser/OS remains outside the protection of ordinary local web authentication.
7. **Local-file attacker** can steal existing plaintext test credentials and private history. Historical files must not be migrated or deleted. New encrypted Solana credentials improve locked-at-rest confidentiality only if the unlock secret is separately controlled; they do not protect an unlocked process or compromised OS. Explicit unlock, standard authenticated file encryption and recovery checks are required. No hardware/separate-device isolation is claimed.
8. **Timing/amount correlator** can compare Zcash inclusion/broadcast patterns with distinctive public Solana outputs and operator/network metadata. Fixed demo pricing, low activity and immediate execution give a small anonymity set. A fresh address does not defeat timing analysis. No mixing, cover traffic, delays or formal unlinkability protocol is implemented or implied.

## Separate privacy properties

- Shielded source payment privacy: protects applicable Zcash ledger contents; verification still reveals receipt to the receiver/operator.
- Recipient address privacy: recipient is public on Solana; selecting a fresh independently generated account only avoids direct reuse.
- Transaction graph privacy: Solana graph remains public, including relayer/pool relationships.
- Amount confidentiality: shielded Zcash contents remain hidden publicly; Solana quantities and fees remain public.
- Wallet identity unlinkability: unproven; no funding transfer from a known user account will be automatically added to a fresh recipient.
- Relayer knowledge: correlation remains available to the trusted operator.
- Network metadata: endpoint operators still see IP/timing/queries. Neither TLS nor selected-account scoping establishes anonymity.

## Data boundaries and retention policy

Keep spend/view keys, raw shielded notes, full watch snapshots and internal correlation records out of public/tracked evidence, logs, URLs, diagnostics and explorer links. Private execution state is necessary for durable settlement and stays in gitignored local storage. User history receives a scoped public projection, not the complete journal. Selected-account-only RPC queries and no analytics are defaults. Nonessential diagnostics should be bounded and expire; required signed-transaction, audit, approval, payment and recovery records must not be pruned automatically. Preserve all historical evidence even where prior demonstrations intentionally disclosed correlation.

Public evidence should report transaction references and independent verification outcomes without publishing the private join key/order mapping. Separately listing two references in a demo report still permits timing/candidate correlation; that disclosure must be acknowledged and cannot be described as unlinkable. Existing Phase 7B published evidence is immutable historical evidence, not a template for new correlation logging.

## Verification plan and stop gates

Tests can establish projection/redaction, no raw secret persistence, account authorization, recipient binding, reuse warnings, encrypted-file recovery/tamper rejection, instruction restrictions and replay/recovery behavior. Tests cannot establish anonymity, a useful anonymity set, absence of external traffic correlation, RPC honesty or secure physical custody. Measure actual RPC method/parameter classes without recording wallet history or keys. Document each unchanged/partial/unverified property in the final privacy audit.

Before live settlement: verify a real executable devnet pool/program/mints, exact input/minimum output/slippage/fees, complete transaction inspection, successful real simulation and independent human approval for each concrete broadcast. Use fresh isolated Zcash payment identity and credentials; never reuse Phase 7B authorization or recovery inputs. If usable liquidity/tooling/signing is unavailable, report the blocker and continue non-broadcasting implementation. No mainnet fallback, automatic transaction replacement or live refund.

## Sources

Baseline: Phase 7A/7B security reports and existing EVM privacy research. Official protocol references: [Zcash protocol specification](https://zips.z.cash/protocol/protocol.pdf), [Solana token accounts](https://solana.com/docs/tokens/basics/create-token-account), [Solana transaction structure](https://solana.com/docs/core/transactions). Implementation and measured disclosures will be recorded separately; this document states the threat model, not achieved privacy.
