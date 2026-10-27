# ZecOne Wallet: visual specification

Status: **design only**. Nothing in this folder is imported by the app, served on a route, or connected to wallet data, keys, signing or spending APIs. `prototype.html` is static HTML and CSS with sample values; open it directly in a browser.

The wallet runtime (`app/wallet.tsx`, `app/connect/*`, `app/solana-connect/*`, `services/wallet/*`, the launcher) was not modified. This spec is the brief for integrating the look after the mainnet wallet work lands.

## Goals

1. The wallet and ZecOne Pay read as one product: same palette, type, chips and copy voice.
2. Privacy state is always legible: what stayed shielded and what touched a public chain.
3. The network is impossible to mistake: mainnet and testnet differ in shape, not only colour.
4. Money is read before it is moved: the total leaving the wallet is the last thing before confirm.

## Capability status

| Screen / element | Status |
| --- | --- |
| Local wallet launched by `Launch-ZecOne.cmd`, served on 127.0.0.1 | Exists (testnet build) |
| Shielded ZEC balance, send, receive, history | Exists on testnet; mainnet in development (Codex) |
| Network label | Exists as text; the chip treatment below is new design |
| Approved websites list | Exists; the management screen below is a redesign |
| Locked screen, idle lock, hide balances, recovery phrase screen | Design target. Confirm against the wallet implementation before building; do not ship UI for a capability the wallet does not have |
| Connected DApps manager with revoke, pending-request card | **Conceptual** (future browser extension) |

## Screens (see `prototype.html`)

1. **Locked**: logo, network chip, passphrase entry, one primary action "Unlock". Footer line: "Keys never leave this computer."
2. **Overview and ZEC balance**: label "Shielded balance", balance in Space Grotesk 46/1.0, unit in sage. Pending funds named under the balance ("0.0100 ZEC confirming"), never silently included. Primary actions Send (chartreuse) and Receive (outline). Recent activity panel.
3. **Send**: To (with Shielded chip), Amount (display 34), encrypted Memo, fee table ending in **Total leaving wallet**. Button: "Review and confirm".
4. **Receive**: tabs Shielded (default) / Transparent; QR on ivory; address in IBM Plex Mono 13.5, wrapping; "Copy address".
5. **History**: filter tabs; every row carries a chip: `Shielded` (gold) or `Payout on Base` (blue) when a ZecOne Pay payment produced a public payout.
6. **Network indicator**: Mainnet = solid chartreuse chip with dot. Testnet = gold dashed chip plus a persistent notice. Shown on every screen, including Locked.
7. **Settings**: security first (lock timing, hide balances, network, recovery phrase behind unlock, approved websites); destructive action "Lock wallet now" last.
8. **Connected DApps (conceptual)**: list of sites with scope text and Revoke, pending payment request card with Reject / Review.

## Tokens

Use the shared tokens from `app/globals.css` (documented in `design/zecone-design-system.md`). Wallet surfaces are the **dark** variant:

| Role | Value |
| --- | --- |
| Surface | `#102820` forest |
| Raised surface | `#18382c` |
| Line on dark | `rgba(246,245,237,.12)` |
| Text | `#f6f5ed` ivory; secondary `#a9b8af` |
| Primary action | `#d7f276` chartreuse fill, forest text |
| Zcash / shielded | `#e8b547` gold |
| Base / public | `#2a56c6` (chip text `#b9c9f5` on dark) |
| Danger on dark | `#f08a7a` |

Type: Space Grotesk for balances and titles, Manrope for UI text (minimum 13px, body 15 to 16px), IBM Plex Mono for addresses, hashes and amounts in lists.

## Integration notes (after Codex finishes)

- The current wallet CSS lives in `app/globals.css` under `.wallet-scope` and was left untouched. Recommended path: add a new `.wallet-scope[data-theme="zecone"]` block (or a separate `wallet.css`) that maps these tokens onto the existing wallet class names, then switch it on behind a flag. Do not edit wallet logic.
- Load the same bundled fonts (`app/fonts/*`) via the CSS variables `--font-heading`, `--font-body`, `--font-code` that `app/layout.tsx` already defines on `<html>`.
- Keep the wallet gateway's nonce-based CSP: the fonts are same-origin files, so no CSP change is needed.
- Respect `prefers-reduced-motion` (the only motion here is the testnet chip pulse).
