# Phase 8A — browser privacy boundaries

Continues audit commit `15ae8dc`. Scope is browser projections, local inspection, ephemeral selection and sanitized diagnostics. This is testnet hardening, not destination anonymity, a new privacy protocol, key migration or a change to financial authorization. Phase 8B–8D are not started.

## Changed boundaries

Routine unified checkout responses now use an explicit field allowlist. They omit shielded payment references/addresses, native account identifiers, internal financial order IDs, raw transaction evidence and operator error details. Display IDs are random per-session aliases; guessing or copying one is insufficient for inspection. Nested quote, fee and swap terms are projected field by field, so new backend fields cannot silently appear in these browser responses.

The backend `unifiedCheckouts` function is still a **restricted internal projection**. It retains stable IDs and references for adapters and historical evidence. HTTP handlers must apply `checkoutBrowserView` and scoped aliases before serialization. Financial tables, source payment IDs, ownership and uniqueness are not redacted or deleted inside restricted storage.

The older EVM dashboard and purchase/swap/Seaport list responses also remove payment references, refund destinations, private recovery rows and unbounded native quote objects. Zcash routine history is reduced to the wallet balance summary rather than returning source transaction references beside destination activity. Public destination references and ownership information remain visible. UI action/quote aliases resolve to their original backend references, and the existing session, exact quote ID, explicit approval, amount and execution checks still apply. This change grants no new signing authority.

The read-only historical viewer no longer serializes entire dashboard/list/dApp objects. It uses allowlists and per-session checkout aliases. The stored snapshot and all historical evidence remain unchanged; previously exported private data is not erased by changing a new API response.

Solana delivery history now requires an order/session history binding instead of listing every profile order. Existing history cannot be claimed simply by quoting the profile from a new browser. Phase 7C swap history retains its durable operator attachment mechanism and now also refuses an existing order without a matching attachment. Nested swap data no longer passes through an unbounded backend object.

These projections deliberately still include payment amount, confirmation progress, relevant expiry, recipient and public destination result when needed by the current checkout UI. They reduce direct identifier joins; they do not eliminate correlation through amounts or timing.

Public NFT token identifiers can reflect the existing signed-intent/order identifier scheme. Public destination/token references remain visible where needed; removing private database fields is not a claim of protocol-level unlinkability.

## Authentication and private inspection

Normal local Host/Origin checks, pairing, session expiration, connected-account checks where applicable, and CSRF checks remain enforced. Sensitive checkout routes reject query parameters. Display handles travel in POST bodies, not public URLs.

`POST /api/checkouts/inspect` requires `reveal: true` and `acceptPrivacy: true`, a current session, CSRF, an issued handle for that session and adapter, and a fresh backend ownership check. EVM checkout inspection checks the current quote session or purchase-request session. Solana delivery inspection checks its durable history binding. A session's handle alone cannot bypass that binding. It returns only the selected payment reference and a privacy warning, without the financial order ID, raw audit, wire or viewing authority.

The tracker visibly warns before the action: inspecting can link shielded funding and public destination data; the operator can already correlate them; do not share/export the view. Private results stay in component memory, clear on selection change, page refresh, session denial/expiry, or after one minute. They are not written to browser storage. Payment-address inspection remains explicit, testnet-only and payable-state restricted; its response omits internal IDs and includes the same warning. Paid/expired orders still cannot obtain another payable request.

The snapshot viewer is a special read-only capability: its pairing token grants access to one operator-selected local snapshot. It does **not** prove ownership of a spending key. Its explicit reference inspection rechecks membership in that fixed snapshot and the session-issued handle; it cannot select another file, profile, wallet or order by an arbitrary ID. It still denies payment creation, signing, approvals, retries, broadcasts and refunds.

After session loss, financial history is not silently assigned to a new browser. Phase 7C's existing explicit local `attach-history --allow-local-history-recovery` operator flow remains available; it rotates history handles without reauthorizing payment or execution. The older Phase 7B browser now fails closed for an existing unbound order; no automatic reattachment tool was added for it in this phase. Its completed operator records/evidence remain available and intact. This is an intentional access restriction, with an older-viewer recovery usability limitation, not evidence that the settlement was lost.

Other explicit transaction-review/approval endpoints continue to carry the identifiers required by their existing exact authorization protocol. Opaque checkout history handles do not replace that protocol. No financial approval or replay policy was changed.

## Browser selection lifetime

The tracker deletes the legacy `localStorage` selection key and never writes checkout selection there again. `sessionStorage` holds only a random display handle, random selection-scope token and expiration. No payment reference, receiving address, viewing key, raw transaction or financial order ID is stored.

Restoration requires a matching current authenticated scope, exact expiry, an unexpired deadline and membership in the current response. A new session, restart, revoked handle or missing checkout invalidates the old selection. An open page clears its checkout data and storage at the known session deadline; a 401/403 clears it immediately on response. A closed/suspended browser may retain bytes until it next runs, but those values cannot authorize backend access and are rejected on restoration. Tab memory and sessionStorage are not security boundaries against same-origin code or local browser-profile access.

## Retention and diagnostic export

1. **Ephemeral authentication and diagnostics.** Expired pairing/session rows are pruned on authentication operations. In-memory display aliases are bounded to 100 sessions and 1,000 aliases per session and expire with the session; restart drops them. Diagnostics use a closed vocabulary and are bounded to the newest 100 events within 24 hours, pruned on insert and export. No idle background job is required; unused process memory disappears at shutdown. No raw exception, RPC URL, request body, wallet address, payment ID or secret is logged by the new diagnostic mechanism.
2. **Restricted operator evidence.** Wallet/watch data, correlation records, history attachment records, raw transaction evidence needed for recovery, and sensitive screenshots remain under local operator control. Existing private files are not rewritten or deleted. New browser captures use `.state/phase8a/browser`; new private journal fingerprints and replay copies use `.state/phase8a`. Review retention manually after the demonstration, subject to preservation and recovery needs; no deletion of historical files is authorized by this phase. Old inactive history bindings are retained as restricted access/audit metadata; expired sessions cannot use them. There is no claim of automatic erasure of all old exports or backups.
3. **Immutable financial/replay evidence.** Payment IDs and ownership, orders, signing/broadcast claims, signed bytes, signatures, authorization/recovery history and finalized receipts are preserved. Neither diagnostic retention nor session cleanup deletes these records or resets a completed settlement. Do not purge them to reduce log size or make an order reusable.

Authenticated diagnostic exports are available at `GET /api/privacy/diagnostics` on the wallet/snapshot adapter, and `/api/solana-swap/diagnostics` or `/api/solana-settlement/diagnostics` on their respective adapters. The schema contains only a version, retention label and counts for fixed categories. It omits event timestamps, endpoints, session/order/profile IDs, addresses, raw errors and arbitrary metadata. Passing an error object to the diagnostic buffer cannot copy it into the result. These are sanitized operational counts, not a financial-journal export or a promise to sanitize arbitrary uploaded files.

The older finite-code Phase 7C diagnostic table remains restricted and keeps its existing write-time retention; it is not exported as raw rows. Host/runtime logs and third-party systems are separate surfaces. Do not send historical evidence, screenshots, arbitrary exception dumps or credential-bearing endpoints to public bug reports.

## Who can see what

- **Zcash public observers:** a shielded transaction's existence and public consensus data remain visible. Shielded recipients/amounts are protected within the shielded pool, but transparent activity and metadata can expose information. This does not guarantee anonymity from timing analysis.
- **Zcash lightwallet infrastructure:** client IP/timing and query patterns; depending on queries, transaction and wallet-related metadata. A watch-only backend has viewing authority that can identify its own receipts. No spending key is sent to lightwallet infrastructure by these privacy changes.
- **Trusted ZecOne operator:** source receiving requests, verified payments, amount/timing and destination orders remain correlated in restricted storage. Browser redaction does not hide this from the operator. Settlement uses prefunded destination inventory and demonstration pricing, not a trustless bridge.
- **EVM and Solana RPC providers:** client IP/timing, queried public accounts/programs, unsigned simulations and submitted destination transactions. Zcash payment IDs are not destination RPC/DEX parameters. This phase adds no provider or network fanout and does not establish independent-provider finality.
- **Destination blockchains:** public relayer, recipient, transaction, amounts, token ownership and account relationships. Address reuse and public destination links permit correlation. Shielded ZEC funding does not make Ethereum or Solana activity anonymous.
- **Connected websites/extensions:** wallet discovery can fingerprint ZecOne availability; approved public accounts and interactions are visible under existing origin permissions. This phase does not redesign extension discovery or arbitrary dApp transaction review.
- **Local machine/browser-profile access:** a person/process with equivalent OS privileges may inspect historical plaintext development keys, private SQLite data, screenshots, browser state or memory. Gitignore, UI masking and opaque handles do not defeat that access. New credential encryption, inactivity locking, stronger device boundaries and a full local ACL audit are later work; historical credentials were not migrated.

## Validation and preservation

See [Phase 8A validation](PHASE8A-VALIDATION.md) and `docs/phase8a-evidence/`. Tests use disposable fixtures and synthetic canaries; none is reported as a real payment or live swap. Destination leakage tests exercise actual SDK unsigned construction/simulation arguments and fixed public pool account queries against fake providers, including decoded bytes, not only UI text. Existing swap/recovery/concurrency/lost-response tests remain required.

Use `node scripts/phase8-preserve.mjs` with the existing private baseline to produce only a new Phase 8A aggregate report. For a new checkout of this repository, initialize a private baseline with `--initialize` before validation; initialization is not a substitute for comparison with the original protected inventories. Never run an older preservation command that overwrites historical reports. The checker reads original financial journals read-only and hashes protected files without publishing paths, secrets or individual credential fingerprints.

No new Zcash payment, live key unlock, signing, broadcast, refund activation, historical wallet migration or Phase 8B/C/D implementation is part of Phase 8A.
