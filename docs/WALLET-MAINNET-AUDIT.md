# Browser wallet mainnet audit

## Finding

`Launch-ZecOne.cmd` starts `scripts/launch-wallet.ps1`, which starts the local
gateway on `127.0.0.1:3210` and creates a one-use local pairing token. The
gateway previously constructed only the legacy `Engine`. That engine invokes
the Rust testnet wallet at `.secrets/user/zcash`; its summary and payment paths
are testnet-specific, and its send path requires `--allow-testnet-broadcast`.
The historical snapshot path independently rejects every marker other than
`zcash-testnet`. Mainnet receiver, watcher, authenticated evidence and spending
services were separate and had no browser read adapter. The `TESTNET ONLY`
label therefore described a real backend boundary, not just presentation.

## Implemented boundary

The paired local gateway now loads `config/wallet-networks.production.json`.
Mainnet calls one new seed-free Rust command, `browser-view`, against the
existing `D:/zecone-mainnet/zcash-spend-wallet` database. Before returning any
data, Rust requires the exact `zcash-mainnet` marker, one stored account, the
pinned UFVK fingerprint, an exact ZIP-316 mainnet Unified Address, and proof
that its shielded receiver belongs to the stored viewing identity.

The response is restricted to the receiving address and receiver types,
account fingerprint, balance, scan heights and transaction deltas. The command
does not accept a keystore, passphrase, seed, signing approval, proposal,
broadcast control or provider submission option. The browser response asserts
`secretMaterialLoaded: false`, `sign: false` and `broadcast: false`; the Node
adapter rejects any response that changes those invariants.

Testnet continues to use its existing isolated database and execution routes.
Network selection changes only the Zcash read projection. Mainnet refresh does
not call the legacy testnet refresh/worker, and Mainnet Send is visibly disabled.
The public web build does not load the private adapter: the adapter exists only
in the paired loopback gateway when the launcher supplies the explicit local
configuration.

## Current verified state

The production wallet projection passed against the existing wallet:

- Network: `zcash-mainnet`; ZIP-316 Unified Address; Orchard receiver only.
- Tip/scanned: `3,531,075` / `3,531,075`.
- Total/spendable: `535,937` / `535,937` zatoshis.
- History: the `645,937`-zatoshi deposit at height `3,529,711`, followed by a
  `-110,000`-zatoshi wallet delta at height `3,531,047`.
- Browser signing and broadcasting: disabled.

This is a cached, internally consistent wallet database view. It does not claim
that a browser refresh performed a fresh two-provider network synchronization.
Fresh authenticated synchronization remains an operator-side mainnet service.

## Remaining execution boundary

Mainnet receiving, balance, sync status and history are available. Browser
mainnet transaction construction, exact SIGN review, encrypted signing,
separate BROADCAST review and submission remain unavailable until that complete
browser-to-backend approval flow is integrated and independently tested. No
existing operator approval gate was changed or bypassed.
