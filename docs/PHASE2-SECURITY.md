# Phase 2 connector security review

## Boundaries

This is a single-user, local testnet wallet. The gateway listens only on `127.0.0.1:3210`. Private APIs require the existing HttpOnly session, exact local Host/Origin, CSRF token and prior local EOA ownership verification. The connector document is the only public navigation path. The external dApp never receives the local session cookie or CSRF token. The local approval document identifies the opener using browser-supplied `MessageEvent.origin` and `source`; the dApp cannot set either value in the browser. Each channel binds to one random UUID, exact origin and authenticated session. Message replies use that exact origin as `targetOrigin`.

The security claim is limited to ordinary browser origin boundaries and the local gateway. The same OS account can read wallet files and databases; a compromised browser, local malware, malicious local process, malicious dApp, RPC provider or operator can still cause harm within the boundaries described below. Do not expose or tunnel the local port.

## Authorization rules

- Address disclosure requires a pending `eth_requestAccounts` dialog. `eth_accounts` returns an address only for an exact persisted origin grant; otherwise it returns an empty list.
- Each signature and transaction requires a fresh approval bound to the stored exact review and expiry. Unsupported methods do not fall back to generic signing.
- The account is the local user EOA; the relayer is separate. The helper checks address, chain, nonce and exact transaction payload and persists signed bytes before broadcast. The dApp only receives the signed result explicitly allowed by its RPC method.
- Only Base Sepolia is accepted. DApp-supplied nonce, gas, fees, access lists and chain overrides are rejected. Value and execution-fee caps apply. Raw transaction submission and `eth_sign` are unsupported.
- Only fixed action calldata can enter the ZEC-funded execution contract. The contract binds EIP-712 domain to its address and chain, checks signature/expiry/recipient/price/value/budget/call and prevents replay by digest and order ID.
- A payment is not settlement until ten-confirmation Zcash scan coverage verifies sufficient value. A Base action is not complete until canonical Base receipt, confirmation threshold, event and consumed digest are checked.
- The EVM provider exposes no Zcash balance, viewing/spending key, shielded recipient, account UUID, receipt table, or ZEC transaction history. No analytics or external logging service is configured. Local UI and settlement operator can still correlate activity.

## Threat cases and handling

| Threat                              | Handling / remaining risk                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin spoof or lookalike host      | Exact canonical HTTPS/loopback origin validation; source/origin/channel checked in popup; origin shown in every approval. Homoglyph/lookalike domains remain a user-recognition risk.                                                             |
| Cross-site API call / CSRF          | Host/Origin/fetch metadata, SameSite session and CSRF remain required; external connector messages do not relax API checks.                                                                                                                       |
| Replayed or mutated request         | Unique request UUID plus fingerprint of channel/origin/method/params; approval hash binds the immutable review; state transitions use compare-and-set; SQLite persists state.                                                                     |
| Duplicate transaction after timeout | Signed bytes are persisted before broadcast; hash is recorded and reconciled. Unknown outcomes stay in review. Never create replacement automatically.                                                                                            |
| Malicious transaction or signature  | Exact origin and payload shown; simulation and estimate are visible; known approval selectors are decoded and flagged; unknown calls receive warning. Simulation can be stale, selectors can mislead, and the user can approve malicious actions. |
| Wrong chain, nonce or account       | Base Sepolia-only gate; account/from match; signer rechecks chain and pending nonce immediately before signing. A concurrent wallet app may change nonce after display; helper rejects the stale approval.                                        |
| Local RPC lies or is unavailable    | TLS RPC and chain checks; simulation/receipts still depend on RPC. Failed or ambiguous outcomes are not declared successful.                                                                                                                      |
| Zcash-to-EVM correlation            | Shielded payment details are absent from EVM RPC; local settlement service necessarily sees the payment/order/action mapping; Base activity and user address remain public.                                                                       |
| Failed sponsored execution          | Fixed contract/journal records a failure or recovery state. No automatic refund is claimed; refunds require separate operator review and a confirmed destination.                                                                                 |
| Browser opener isolation            | `/connect` opts into `Cross-Origin-Opener-Policy: unsafe-none` to preserve `window.opener`; its CSP forbids framing and its API remains authenticated. An integrating dApp with stricter COOP may sever the popup relationship.                   |

No formal audit or production key isolation is claimed. The connector is a research/testnet prototype; review [Phase 2 limitations](PHASE2-LIMITATIONS.md) before use.
