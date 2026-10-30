# Phase 7B transaction evidence — completed testnet demonstration

16 October 2026. Real shielded Zcash testnet payment → verified authorization → one approved prefunded Solana devnet delivery → finalized exact effects → durable COMPLETED/settled order. These are actual chain observations, distinct from synthetic regression tests. Refunds remain disabled.

## Fresh identity and funding

- Profile: `3e89c1b8-74ef-4802-af61-5789460b2d42`.
- Payment request: `e35ce3ee-459f-4aee-92aa-5024932c2a33`.
- Order: `0xb6e0cc42d0e2562b6682b8fe96153636d74aa8d926c655cdf7bdec0b56a85fff`.
- Fresh payer: `utest1xaf9pg4hrg5dr75dvq0kqcgduspdhn4tp7n7h04fjsgwhlv4uhuds9gq2zs3nfuqyhzh55tm45qptjgztrynrr0my0p9rx7hqgpvh5cy`.
- Fresh settlement receiver: `utest1qd3dqu65fzsff73e7y08vsn60gwl8rd5jnyjh5akpmz3x4e33hhj7kfhgnt287wkw5lwqqnl8psjt5gas79j0ua4gqmt7fahkgvchhaf`.
- Dedicated devnet relayer: `dFmJUGpAqERawUkauLZMQdRmXVBffPqTCgX6XrM4u8k`.
- Recipient: `HiGp8uCTupsv795g3iqK4Tex1K3hLdNryrZ6sukquRS3`, controlled by a separate local disposable key.

The fresh payer received **0.125 TAZ**, transaction `fa0f8eb329a2480e4cdf84436ad13209d0a6fdb9b2fa0fafc7183e31a8ac0507`, mined at height 4,508,693. Its owned Ironwood note reached ten confirmations at scanned tip 4,508,702. The deposit's source identity is not inferred from shielding. The original wallet and its quarantine remain untouched.

## Real shielded payment

The user approved this exact transaction, then the native helper submitted persisted bytes once at 15:35:55 UTC:

- Transaction ID: `ade0250ca587bcfaac6b7e0b3dbcbd479ffe11e97f544235a3f72931ecda7385`.
- Payment: **100,000 zatoshis = 0.001 TAZ**.
- Actual fee: **10,000 zatoshis = 0.0001 TAZ**; total payer debit **0.0011 TAZ**.
- Transaction expiry height: 4,508,745.
- Persisted raw-byte SHA-256: `97b46d45f4279ac5e3da43ca91d943d3efa826826332415864535696d7c3ceac`; length 9,166 bytes. Raw bytes and spending keys are not published.
- Receiver verification: exact fresh account/address, owned Ironwood note, exact amount and **13 confirmations** before delivery; minimum required ten. Local viewing-key scanning establishes receipt. A public shielded transaction ID alone does not reveal the receiving address or amount.

[Preparation review](phase7b-evidence/payment-prepared-ade0250ca587bcfaac6b7e0b3dbcbd479ffe11e97f544235a3f72931ecda7385.json), [native submission result](phase7b-evidence/broadcast-payment-1792164955562.json), [verified payment and unsigned Solana review](phase7b-evidence/solana-prepared-review.json).

## Real Solana delivery and finalization

The user separately approved exact devnet transfer digest `44aab0b76597178bfe88e6d84f3cde626700561429b1f6050d0ba4672ede5e7c`, blockhash `EE9PRoqM99ZhAEXZFQ9V4euQMUacqwJ9pQ5TWmpYCvs8`, last valid height 498,976,676, and fee cap 10,000 lamports. The service signed, persisted the signature and signed bytes, and invoked submission once.

Signature: `3RMoB1C93SfvnwzfdQxKg7jdw4VDP9qkKCKXbrPtDsiaw4AbM3KJz3VcRCvdDKV4irUhUrxZFmtbzNNkaW8xpH4y`.

[Solana devnet explorer](https://explorer.solana.com/tx/3RMoB1C93SfvnwzfdQxKg7jdw4VDP9qkKCKXbrPtDsiaw4AbM3KJz3VcRCvdDKV4irUhUrxZFmtbzNNkaW8xpH4y?cluster=devnet).

The finalized RPC receipt is at slot **511,759,207**, block time **1792165197** (16 October 2026, 15:39:57 UTC). The verifier matched the entire approved legacy message, System Program instruction, accounts, signature, exact fee and transaction-local balance changes:

- Recipient: 0 → **1,000,000 lamports**, a **0.001 SOL** gain.
- Relayer: 100,000,000 → **98,995,000 lamports**, a **1,005,000-lamport** debit.
- Fee: **5,000 lamports = 0.000005 SOL**.
- Durable state: **COMPLETED**, shared order **settled**.

Fresh aggregate balance queries agreed with the receipt's post-balances. Finalization and exact per-transaction effects, rather than simulation or aggregate balances alone, authorized completion.

[Submission result](phase7b-evidence/broadcast-solana-1792165198300.json), [initial finalized reconciliation](phase7b-evidence/reconcile-1792165306213.json), [restart/replay/effect evidence](phase7b-evidence/completed-verification.json).

## Restart, idempotency and recovery

A separate process reopened the SQLite journal and reconciled the same signature at finalized commitment. The state stayed COMPLETED/settled. Audit counts show **one signing claim and one broadcast claim**. Duplicate preparation and execution were rejected; execution rejection occurred before signer access. Completed-delivery refund recovery was vetoed. Verification loaded no key, installed a send veto, and made **zero broadcast calls**. It did not submit a second transfer to test idempotency.

Reproduce with `node --import tsx scripts/phase7b-verify-completed.ts`; it regenerates the public verification report. Use `npm run phase7b -- status` for persisted status or `npm run phase7b -- reconcile` to re-query the original signature. Do not repeat either broadcast or refresh the approved blockhash.

Failure/recovery scenarios remain covered by the labeled synthetic regression suite: failed simulation, unavailable RPC, expired blockhash/order, insufficient inventory/payment, duplicated payment/execution, lost submission response, restart, chain disagreement/reorganization and execution/refund exclusion. No live failure, refund or replacement was deliberately introduced.

## Preservation and trust limits

Earlier empty-wallet and original-wallet forensic observations remain historical evidence in [funding.txt](phase7b-evidence/funding.txt) and [original-wallet-review.json](phase7b-evidence/original-wallet-review.json). The original unresolved 0.002 TAZ attempt still lacks transaction/input/expiry evidence. It was not retried; no marker was cleared and no historical payment or recovery input authorized this settlement. [Preservation](phase7b-evidence/preservation.json) verifies all 537 inventoried original files unchanged.

This is fixed-price testnet demonstration inventory settlement, **not an exchange rate or a trustless bridge**. ZEC remains on Zcash; prefunded SOL is delivered separately. Zcash evidence trusts configured zec.rocks light infrastructure; Solana evidence trusts the genesis-checked public devnet RPC. Independent providers/nodes were unavailable for consensus corroboration. The operator can correlate both sides. Keys remain plaintext under one local OS account; physical signer isolation is unproven. Live refunds remain disabled. There is no remaining blocker for this bounded Phase 7B demonstration; Phase 7C/8 were not begun.
