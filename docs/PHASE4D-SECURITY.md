# Phase 4D security boundary

This remains an unaudited local testnet wallet with a trusted prefunded operator. Mainnet inspection does not enable mainnet execution.

## External page and extension

The MV3 manifest injects only on exact OpenSea HTTPS origins, top-level frames, with no background, storage, native messaging, externally-connectable or localhost host permissions. Provider JavaScript runs in the website's MAIN world and is inherently untrusted. It contains no secrets and has no privileged extension-to-signer credential. The extension only makes the existing popup protocol discoverable; it cannot itself authorize a signature.

The local popup checks browser-supplied opener/source/origin, channel and request IDs, uses a locally paired session and CSRF-protected API, and shows explicit approval. Neither webpage JSON nor extension branding can set the trusted requesting origin. The provider checks the reverse popup source/origin/channel and pending request correlation. The backend persists origin permissions/session bindings, review hashes and expiry. Revocation/session expiry rejects outstanding requests; browser disconnection is surfaced. Existing signer rechecks testnet domains and account/transaction limits.

Same-page malicious code can replace a provider or fake results within its own page; freezing the exported facade is not protection against a compromised page. It still cannot cross the browser origin boundary to approve a local signer request. Compromised wallet-origin JavaScript, browser, same-user OS process or gateway remains outside this prototype's protection. Keys are local plaintext testnet files, not hardware-isolated.

External websites get only explicitly approved EVM information/signatures. The method allowlist excludes Zcash keys/viewing keys/balances/history, database access, relayer credentials, raw signed transaction submission and key export. Private local HTTP APIs remain Host/Origin/fetch-metadata/session/CSRF protected. No CORS exception or public binding was introduced. OpenSea's real connection has not been established, so only the local security tests support these implementation claims.

## Read-only mainnet boundary

`services/opensea` uses `createPublicClient`, never a wallet client, settlement key, Base executor, payment allocator or reservation store. It reuses pure Seaport structs/hashing only. Its two authenticated HTTP operations discover and inspect; unknown actions, including `/api/opensea/pay`, return 404. Recipient/provider are configured from the existing public manifest, not browser input. Preview has `executable:false` and `paymentAddress:null`. Its review hash is not a user signature or execution authorization. Existing testnet chains, immutable wrapper and zero-conduit policy are unchanged.

API responses are untrusted. Exact official paths/origin, no redirects, timeout, streaming byte/depth bounds, strict uint/address/hash normalization and generic/redacted transport errors protect the boundary. API keys stay server-side and are not in response projections. Expiration, authentication failures, local spacing and server retry/reset headers stop retries. Raster metadata is proxied only from exact permitted HTTPS CDN hosts, bounded to 750 KB with MIME/magic checks; no arbitrary URL, SVG, script or HTML fetching/rendering.

Validation verifies protocol runtime/domain and controller, signed order components, authoritative hash/counter/status, seller authorization/ownership/approval and exact fixed native consideration. Included fee recipients/amounts must match collection API policy; required fees cannot be omitted. That policy is an authenticated API assertion, not an independently verified onchain fee registry. Exact recipient-directed calldata is reconstructed and compared to the proposed API call. Only a four-byte attribution suffix is accepted; no arbitrary appended calldata. Dynamic/partial/restricted/criteria/bulk routes are rejected.

Simulation and estimate use a single canonical block and override only the public provider's ETH balance. This is hypothetical purchasing capacity, not real funds or ownership. Contracts receiving consideration are reported and the exact call must simulate successfully, but this does not audit those contracts or guarantee future execution. Short expiry and canonical-block recheck bound staleness; concurrent fills/reorgs/outages remain possible. No signer receives the simulation bytes.

## Privacy, recovery and preservation

OpenSea receives collection/NFT/order queries and public fulfiller/recipient addresses. RPC sees addresses and the simulated public transaction. Image CDN sees server requests. These services and the local operator can correlate activity; shielding does not anonymize OpenSea browsing or NFT ownership. No Zcash secret, viewing data, balance or receiving address is transmitted to them.

Manual refund/recovery policy is unchanged. A preview creates no payment liability; historical paid orders retain their audit/replay/reservation protections. No claim of automatic refunds or atomic exchange is made. Prior evidence/pins and transaction/broadcast snapshots were compared with the checkpoint. Only an independently verified dead-process lock was archived; native send records were preserved.
