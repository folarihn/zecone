# ZecOne — Shielded ZEC → Base ETH payments

**Privacy-oriented cross-chain payments, built for real mainnet.**

A customer pays with **shielded Zcash**. A trusted, prefunded relayer pays the
corresponding **ETH on Base** to a merchant. Verification is cryptographically
grounded, the payout is publicly visible, and the operator correlates the two
legs — ZecOne is an honest trusted-relayer system, not a trustless bridge.

---

## One-line pitch

> Spend shielded ZEC; recipients get ETH on Base — with verified confirmations,
> replay protection, and explicit operator approval gates.

## The problem

Zcash gives users strong on-chain privacy, but the shielded-coin ecosystem has
few ways to spend into widely-used ecosystems. Merchants overwhelmingly want
settlement in major assets (ETH on Base). ZecOne bridges that gap: customers
keep shielded privacy on the Zcash leg, while merchants receive a normal,
public ETH payout they can actually use.

## How it works

```
Customer ──(shielded ZEC)──▶ ZecOne verification ──▶ Prefunded Base relayer ──▶ Merchant (ETH)
```

0. A merchant onboards by signing an EIP-4361 message with its Base payout
   wallet; ZecOne issues a scoped API key only after verifying the signature.
1. The merchant's server creates a payment request (amount in USD) with
   `@zecone/sdk`; the payout always goes to the verified Base address.
2. ZecOne returns a shielded Zcash payment destination and an exact quote
   (ZEC amount → ETH payout, with expiry).
3. The customer pays the exact amount to the shielded destination.
4. ZecOne attributes the payment by **exact source transaction id** (never by
   amount/timestamp guessing), verifies confirmations across two independent
   lightwalletd providers, and checks quote validity + relayer liquidity.
5. After explicit operator **SIGN** and **BROADCAST** approvals, the relayer
   pays ETH to the merchant's Base address.
6. ZecOne verifies the Base receipt and finality, then emits a signed
   payment-completion webhook. The merchant unlocks the order server-side.

Customers pay on a **hosted checkout** (`/pay/:id`), an **embedded React
component** (`@zecone/sdk/react`), an **iframe** (`/embed/:id`) or a
**payment link** with QR code from the merchant dashboard.

## Supported networks

| Leg | Network | Status |
|---|---|---|
| Payment | Zcash **mainnet** (shielded: Ironwood/Orchard/Sapling) | ✅ live-verified |
| Payout | Base **mainnet** (chain id 8453) | ✅ live-verified |
| Payout | Base **Sepolia** (chain id 84532) | test/dev |

## Real mainnet evidence

- **Shielded deposit**: `8f512d50e1ee36eb222537bdba8b8f762f39256e28259a422913392d86b5f86c`
  — 645,937 zat (0.00645937 ZEC), block 3,529,711.
- **Base payout**: `0xc677e9fa956015732c79bfda0991369245bae9394b6f0b9e13425a8e247648a7`
  — 0.003284955372432969 ETH, block 53,065,894 (finalized).
- **Shielded withdrawal**: `0316e2140f5a3440c2755e3f92c748a5f215d509d690d52b4858bfcc9a8af02f`
  — sent 100,000 zat, fee 10,000 zat, change 535,937 zat, block 3,531,047 (finalized, 20+ conf).

See [`EVIDENCE.md`](./EVIDENCE.md) for full finality details and explorer links.

## Repository layout

```
app/                     Next.js website (homepage, checkout, docs, explorer, dashboard, security)
services/payments/        Merchant payment API (node:http + node:sqlite)
services/zcash-mainnet-spend/  Shielded Zcash spending wallet (Rust)
services/zcash-watch/     Watch-only scanner (Rust)
services/settlement/      Base relayer, settlement journal, quote/approval gates
sdk/                     @zecone/sdk (server client, webhooks, browser checkout, React component)
examples/access-pass/    Reference example DApp
submission/              Hackathon submission materials
```

## Quick start (local demo)

```powershell
npm ci
npm run sdk:build              # build the SDK
npm run payments:start         # merchant API on http://127.0.0.1:4321 (demo mode)
npm run dev                    # website on http://localhost:3000
npm run dapp:start             # example DApp on http://127.0.0.1:4333
```

Three separated modes:

| Mode | What happens | Address shown | Payout |
|---|---|---|---|
| **Demo** (default) | Simulated checkout; a server-side observer replays the recorded mainnet pilot transactions, labelled `recorded-mainnet-replay` / `simulated: true` | None — a labelled example interface | None |
| **Monitor** (operator-authorized) | Real deposits observed read-only via the authenticated watcher; attribution, 20 confirmations, reorg handling, chain evidence | Real receiving address | None — stops at `ZEC_CONFIRMED` |
| **Live settlement** | Disabled in this build | — | Operator SIGN/BROADCAST gates only |

No browser action can complete a payment. Full guide: [`INTEGRATION.md`](./INTEGRATION.md).

## Developer integration

```ts
import { ZecOne } from "@zecone/sdk";

const zecone = new ZecOne({ apiKey: process.env.ZECONE_API_KEY! }); // server only

const payment = await zecone.payments.create({
  amountUsd: "1.00",
  metadata: { orderId: "demo-001" },
  idempotencyKey: "demo-001",
});
// browser: <ZecOneCheckout paymentId={payment.id} checkoutToken={payment.checkoutToken} … />
```

See [`app/docs`](../app/docs/page.tsx) and the SDK source for the full API.

## Security model

- **Merchant authentication**: EIP-4361 wallet-ownership proof (single-use,
  server-composed message), hashed scoped API keys, wallet-verified sessions.
- **Payment attribution**: exclusive receiving-address allocation plus exact
  source transaction id, never amount/timestamp guessing. One checkout can be
  awaiting payment at a time (enforced; documented limitation).
- **Replay protection**: single-use approvals, idempotency keys, signed
  webhooks with timestamp + replay rejection.
- **Confirmation thresholds**: 20 confirmations on Zcash, provider agreement
  across two independent lightwalletd operators.
- **Operator gates**: separate SIGN and BROADCAST approvals; real payout is
  disabled by default; emergency pause overrides everything.
- **Wallet isolation**: spending keys and the relayer signing interface are
  never reachable from the public API.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`LIMITATIONS.md`](./LIMITATIONS.md).

## Current limitations

- No automated ZEC→ETH conversion; the relayer is manually prefunded.
- Trusted relayer; not trustless; operator can correlate the two legs.
- Public beta not yet enabled; live payout disabled by default.
- Per-order diversified address derivation is not yet wired; one checkout can
  await payment at a time (`checkout_busy` otherwise).
- The merchant API is not yet connected to the live watcher; in this build
  payments complete only through the labelled demo replay.

## Roadmap

1. Per-order diversified shielded addresses (per-payment attribution at scale).
2. Automated relayer liquidity replenishment.
3. A second independent verifier for the Base payout leg.
4. Public beta with operator-armed live payout.
