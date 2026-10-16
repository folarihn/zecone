# Phase 7B transaction evidence — PARTIAL

## Funding and preparation follow-up, 16 October 2026

The fresh payer received **0.125 TAZ** (12,500,000 zatoshis) in transaction `fa0f8eb329a2480e4cdf84436ad13209d0a6fdb9b2fa0fafc7183e31a8ac0507`, mined at height 4,508,693. Its owned Ironwood note reached ten confirmations at scanned tip 4,508,702. The funding source's identity is not inferred from shielding; the recipient viewing key establishes ownership of the incoming note. The original wallet and its quarantine remain untouched.

A new payer-to-settlement payment is now prepared and durably saved, **not broadcast**: 100,000 zatoshis plus an actual 10,000-zatoshi fee (total 0.0011 TAZ); expiry height 4,508,745; transaction ID `ade0250ca587bcfaac6b7e0b3dbcbd479ffe11e97f544235a3f72931ecda7385`. The [exact preparation review](phase7b-evidence/payment-prepared-ade0250ca587bcfaac6b7e0b3dbcbd479ffe11e97f544235a3f72931ecda7385.json) records the raw-byte hash and length without publishing transaction bytes or keys. Explicit approval of this exact payment has been requested. Solana execution needs a separate later approval after the settlement receiver verifies ten confirmations. No refund is enabled.

The funding blocker below describes the earlier checkpoint. It is now resolved for the fresh payer; broadcast approval is the current gate. A completed real cross-chain settlement is still not claimed.

## Initial checkpoint

16 October 2026. No fresh shielded Zcash payment was prepared or broadcast, and no Solana delivery was signed or broadcast in this phase. There is no payment transaction ID, delivery signature or finalized recipient delta to report. Synthetic notes/signatures are not live evidence.

Fresh [profile capture](phase7b-evidence/profile.json):

- Profile: `3e89c1b8-74ef-4802-af61-5789460b2d42`.
- Payment request: `e35ce3ee-459f-4aee-92aa-5024932c2a33`.
- Order: `0xb6e0cc42d0e2562b6682b8fe96153636d74aa8d926c655cdf7bdec0b56a85fff`.
- Fresh payer: `utest1xaf9pg4hrg5dr75dvq0kqcgduspdhn4tp7n7h04fjsgwhlv4uhuds9gq2zs3nfuqyhzh55tm45qptjgztrynrr0my0p9rx7hqgpvh5cy`.
- Fresh settlement receiver: `utest1qd3dqu65fzsff73e7y08vsn60gwl8rd5jnyjh5akpmz3x4e33hhj7kfhgnt287wkw5lwqqnl8psjt5gas79j0ua4gqmt7fahkgvchhaf`.
- Devnet relayer: `dFmJUGpAqERawUkauLZMQdRmXVBffPqTCgX6XrM4u8k`; actual read showed 100,000,000 lamports (0.1 SOL) at provisioning.
- Recipient: `HiGp8uCTupsv795g3iqK4Tex1K3hLdNryrZ6sukquRS3`, controlled by a separate local disposable key.
- Planned delivery: 1,000,000 lamports (0.001 devnet SOL).
- Demo payment: 100,000 zatoshis (0.001 TAZ), ten confirmations required. Actual payer fee is unknown until construction; its cap is 10,000 zatoshis.

The user requested funding from the quarantined original wallet. The [new read-only review](phase7b-evidence/original-wallet-review.json) recovered no saved transaction reference and its new recipient scan was unavailable. The original 0.002 TAZ attempt remains unresolved. Its cached note total is not a fresh spendable balance. No original-wallet spend, marker deletion, synchronization or Phase 5.2 input reuse followed.

The [fresh payer funding scan](phase7b-evidence/funding.txt) reached tip/scanned height 4,508,649 and found **zero confirmed unspent zatoshis**. This is a real watch-only observation, not a fixture. The unavailable original-recipient scan does not mean no transfer occurred; its status remains unresolved.

Next live gate: approximately 0.002 TAZ in the fresh payer from an independently funded source, or separately evidenced recovery of the original wallet first. Ten confirmations, fresh fee checks and separate exact broadcast approvals remain required. An expired quote cannot authorize automatic replacement.

The local rehearsal uses synthetic chain data: verified payment → authorization → preparation/simulation → exact approval → one submission attempt → finalized exact effects → completed → duplicate rejected → restart-safe reconciliation. Existing Phase 7A simulation remains historical evidence and is not reused as new payment authorization. No real cross-chain settlement is claimed.
