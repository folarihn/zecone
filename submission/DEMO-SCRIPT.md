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

## 3. Real mainnet evidence (55s)

Open `/explorer` (or the homepage "Verified mainnet transactions" section):

Historical cross-chain pilot:

1. **Shielded deposit** — `8f512d50…6b5f86c`, 0.00645937 ZEC (block 3,529,711).
2. **Base payout** — `0xc677e9fa…648a7`, 0.003284955372432969 ETH (block 53,065,894).
3. **Shielded wallet-control spend** — `0316e214…8af02f`, sent 0.001 ZEC + change (block 3,531,047).

Separate real execution test:

4. **Operator-approved Zcash transfer** — `0f0e9442…1def47`, sent 0.0001 ZEC,
   fee 10,000 zat, change 515,937 zat (block 3,533,388; finalized at the required 10 confirmations).

Click through to the block explorers. Emphasize: all four are real on-chain
transactions. The first three are historical cross-chain pilot evidence; the
fourth proves the guarded Zcash execution workflow. It is not another Base
payout and was not initiated by the hosted checkout.

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

If recording on the prepared operator machine, open the local reference DApp
(`http://127.0.0.1:4333`): connect a Base
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

**Total: ~3 minutes.** The through-line is honesty: real Zcash execution,
historical cross-chain evidence, a working simulated checkout, and live hosted
cross-chain settlement that remains under development.
