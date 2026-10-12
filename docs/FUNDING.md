# Funding checkpoint — testnets only

The wallets are generated and credentials stay locally in gitignored `.secrets`. **Funding and the Phase 0 live payment-to-mint test completed on 2026-10-12. No additional funding is needed for that completed run.** The instructions below are retained for reproduction; inspect [RESULTS.md](RESULTS.md) before sending more funds. Faucet claims were not submitted automatically.

## Base Sepolia

User-controlled NFT owner (no ETH needed to sign the intent or receive the sponsored mint):

```text
0x1865Dd77bFcb632571d3c93144D5634F0D93c714
```

Separate settlement relayer: fund with approximately **0.02 Base Sepolia ETH** for deployment and test minting. This is a conservative test budget, not a fixed gas quote; smaller faucet grants may suffice.

```text
0xf9dE6070331A3B68233c3b2062BceB7105162Cd2
```

Use the official [Coinbase Developer Platform faucet](https://portal.cdp.coinbase.com/products/faucet). Sign in if required, select **Base Sepolia**, token **ETH**, and paste the relayer address. Coinbase [documents support for external developer wallets and Base Sepolia](https://www.coinbase.com/developer-platform/products/faucet). Faucet limits and account checks are controlled by Coinbase. No CDP API credential is required for our public-RPC implementation. Do not select Ethereum Sepolia: its ETH is on a different chain.

## Zcash standard Testnet

Fund the **payer** wallet with approximately **0.1 test ZEC (TAZ)**. The demo payment is 0.01 test ZEC plus the library-calculated ZIP-317 transaction fee. Both addresses below belong to the same payer account; fund either supported shielded format.

Sapling shielded address:

```text
ztestsapling1uezal3serdplgyq2lsjlnulwj4yqd3pxagecp2dm9x3x5xn5c4wenkqyep0nc7rhvj3rzef205a
```

Unified shielded address (Sapling + Orchard):

```text
utest1tfwnjvtsxwr5jxeaea6sy05q3gnyh887wsx9hcd77tahuymnml35he5hdu2w7eeqrfpnjg200wph33480ztfp0en4slyudwayks0jnphl94wz6nwg2mdh6chwsdk8y0wkd3x4h2vf8qs0rjar4c3dlf06jfxhhme32dptvhe3c7z860m
```

The [official Zcash Testnet guide](https://zcash.readthedocs.io/en/latest/rtd_pages/testnet_guide.html) links [ZecPages faucet](https://faucet.zecpages.com) and the project's support Discord. The linked faucet could not be reached during browser research; check the latest read-only probe in `evidence/network.json` rather than assuming it is working.

A community alternative is [Jino Labs' faucet](https://zcashfaucet.jinolabs.xyz), whose [maintained source and operator instructions](https://github.com/jinolabs-xyz/zcash-faucet) describe shielded payouts and browser proof-of-work. This is a third-party operator, **not an official Zcash-operated faucet**. Select standard Zcash Testnet/TAZ if offered a network choice, paste the shielded payer address, complete the browser challenge and retain the returned txid. Crosslink/cTAZ is a different test network and is not supported by this slice. Endpoint availability does not prove that a payout will succeed.

If no faucet works, use the support link in the official testnet guide to request TAZ to this public address. Never provide a seed, spending key or wallet file to a faucet. Wait for 10 confirmations and rescan before spending received test funds.

## Local custody and next step

| Purpose | Credential location | Funding |
| --- | --- | --- |
| User NFT owner | `.secrets/user/base-sepolia.json` | None required for this mint |
| Base relayer | `.secrets/relayer/base-sepolia.json` | Base Sepolia ETH |
| Zcash payer | `.secrets/user/zcash/seed.bin` and wallet DB | Standard Testnet TAZ |
| Zcash merchant | `.secrets/merchant/zcash/seed.bin` and wallet DB | Receives the later order payment |

The service never loads the Base user's key. It is used by the separate local user-signing utility. Windows ACLs restrict `.secrets` to your Windows account and SYSTEM. This is local development custody: the same OS user can still access every file. There is no remote custody or seed upload.

All public addresses and Zcash account IDs are in [PUBLIC_WALLETS.json](PUBLIC_WALLETS.json). The actual order payment destination is generated after contract deployment and intent signing; the funding addresses above first fund the payer and relayer. Follow [RUNBOOK.md](RUNBOOK.md) only after asking to resume live tests.
