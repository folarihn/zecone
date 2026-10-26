# ZecOne — Mainnet evidence

All values below are real, verified on-chain facts from the ZecOne mainnet
pilot. Nothing is simulated or fabricated.

---

## 1. Shielded Zcash deposit (source of the payout)

| Field | Value |
|---|---|
| Transaction | `8f512d50e1ee36eb222537bdba8b8f762f39256e28259a422913392d86b5f86c` |
| Amount | 645,937 zatoshis (0.00645937 ZEC) |
| Pool / index | Ironwood / output 0 |
| Mined height | 3,529,711 |
| Status | Unspent at deposit; later spent by the payout source commitment |
| Explorer | https://zcashblockexplorer.com/transactions/8f512d50e1ee36eb222537bdba8b8f762f39256e28259a422913392d86b5f86c |

## 2. Base ETH payout (settlement)

| Field | Value |
|---|---|
| Transaction | `0xc677e9fa956015732c79bfda0991369245bae9394b6f0b9e13425a8e247648a7` |
| Amount | 0.003284955372432969 ETH (3,284,955,372,432,969 wei) |
| Block | 53,065,894 |
| Status | **Finalized** (Base settlement complete) |
| Explorer | https://basescan.org/tx/0xc677e9fa956015732c79bfda0991369245bae9394b6f0b9e13425a8e247648a7 |

## 3. Shielded Zcash withdrawal (spending-wallet demonstration)

| Field | Value |
|---|---|
| Transaction | `0316e2140f5a3440c2755e3f92c748a5f215d509d690d52b4858bfcc9a8af02f` |
| Sent | 100,000 zatoshis (0.001 ZEC) |
| Network fee (ZIP-317) | 10,000 zatoshis |
| Shielded change | 535,937 zatoshis (returned to wallet) |
| Mined height | 3,531,047 |
| Confirmations at finality | 29 (threshold 20) — **FINALIZED** |
| Explorer | https://zcashblockexplorer.com/transactions/0316e2140f5a3440c2755e3f92c748a5f215d509d690d52b4858bfcc9a8af02f |

### Withdrawal finality evidence

- Two independent lightwalletd providers (`zec.rocks` and `us.zec.stardust.rest`)
  agree on height and block hash at every step.
- The source note's nullifier is recorded spent in the wallet.
- The change note (535,937 zat) is present and spendable.
- The durable journal advanced `PREPARED → SIGNED → SUBMITTED → CONFIRMED →
  FINALIZED` with a 20-confirmation threshold.

## Honest distinction: real vs. simulated

| Transaction | Real or simulated |
|---|---|
| Shielded deposit | **Real** (mainnet) |
| Base payout | **Real** (mainnet, finalized) |
| Shielded withdrawal | **Real** (mainnet, finalized) |
| Checkout/DApp demo orders | **Simulated** (replays the recorded evidence; clearly labeled; no new funds) |

## Working configuration

- Base commit at time of demonstration: `df6409b` (working tree includes the
  mainnet spend-crate changes; no unrelated settlement work is bundled into any
  commit).
- Zcash mainnet lightwalletd: `https://zec.rocks:443` (primary),
  `https://us.zec.stardust.rest:443` (peer).
- Base mainnet RPC: `https://mainnet.base.org` (coinbase),
  `https://base.drpc.org` (drpc).
- Wallet birthday height: 3,528,700.
- Zcash account fingerprint: `c89c7cda1189ef6eaac30df339e43b74142e49dfd1340bad213c10e356eac6b9`.
- Base submitter: **paused**. Relayer nonce preserved. No keys are exposed here.
