# ZecOne — 3-minute demo script

**Goal:** show that shielded Zcash can settle into a normal ETH payout on Base,
with real mainnet evidence and an integratable developer surface.

---

## 1. The problem (20s)

> "Zcash gives users strong on-chain privacy. But if you want to *spend* that
> value into the rest of the ecosystem, there's a gap: merchants want ETH on a
> chain like Base. ZecOne closes that gap — customers pay with shielded ZEC,
> merchants receive ETH on Base."

## 2. How it works (30s)

Show the architecture diagram (in `/security`):

```
Customer → shielded Zcash → ZecOne verification → prefunded Base relayer → Merchant (ETH)
```

One sentence on each: the Zcash leg is shielded and private; the Base leg is
public; the operator (trusted relayer) correlates the two.

## 3. Real mainnet evidence (45s)

Open `/explorer` (or the homepage "Verified mainnet transactions" section):

1. **Shielded deposit** — `8f512d50…6b5f86c`, 0.00645937 ZEC (block 3,529,711).
2. **Base payout** — `0xc677e9fa…648a7`, 0.003284955372432969 ETH (block 53,065,894).
3. **Shielded withdrawal** — `0316e214…8af02f`, sent 0.001 ZEC + change (block 3,531,047).

Click through to the block explorers. Emphasize: these are real on-chain
transactions, not simulated.

## 4. ZecOne Checkout (30s)

On the homepage widget pick $5 and "Continue to demo checkout" (or open
`/checkout` and buy an item). Point out:

- The **exact ZEC amount**, the quote window and the **Simulated** badge.
- The dashed **"Example payment interface — simulated"** box: a demo checkout
  never shows a payable address or QR code. (Real addresses appear only in the
  operator-authorized monitor mode.)
- No completion button: after a few seconds the server-side observer replays
  the recorded mainnet transactions and the checkout walks through each step
  to "Payment complete" with a Basescan link.

## 5. SDK integration (30s)

Open `/docs`. Show the five-line create-payment snippet. Emphasize:

- Amounts are strings — no floating-point money math.
- The API key lives server-side; it is never in the browser.

Then open the reference DApp (`http://127.0.0.1:4333`): connect a Base
wallet → sign ZecOne's ownership message (no transaction) → Buy with ZEC →
embedded checkout → content unlocks. Emphasize that it unlocks only after the
DApp's server verified the signed `payment.completed` webhook and re-read the
payment — never because the browser says so.

## 6. Payment tracking & receipt (20s)

Show `/dashboard`: sign in with a Base wallet, the one-time API key, create a
payment link (QR), the payments list updating live, and webhook settings with
"Send a test event". Note the lifecycle in `/docs` and the signed webhooks.

## 7. Privacy boundaries & future (30s)

Open `/security`. Be explicit:

- Shielded Zcash = private on-chain.
- Base payout = public.
- Operator can correlate the two legs.
- **Not** a trustless bridge; no complete anonymity.

Close with the roadmap (per-order diversified addresses, automated liquidity,
public beta).

---

**Total: ~3 minutes.** The through-line is honesty: real mainnet evidence, a
working demo that is clearly labeled, and privacy claims that are technically
accurate.
