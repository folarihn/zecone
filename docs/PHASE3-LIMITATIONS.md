# Phase 3 limitations

- Only the configured independent fixed-price marketplace and collection are supported. This is not general OpenSea, arbitrary calldata, arbitrary routing, or production dApp compatibility.
- `zecone_payWithZec` and `zecone_getPurchaseStatus` are explicit ZecOne extensions. Ordinary injected EIP-1193 wallets can use the same marketplace's normal ETH purchase path; they do not acquire shielded-ZEC support automatically.
- The user retains an EOA. No production ERC-4337 bundler or paymaster is used: a separate prefunded provider executes a bounded recipient-directed purchase. The recipient needs no ETH for the ZEC-funded path.
- Quotes expire after at most one hour. A listing must have enough time left for confirmation. Availability can change while Zcash confirms; the provider does not escrow the NFT when issuing a quote.
- Rate is simulated: 1 TAZ = 0.02 test ETH. Fixed gas reserve is 0.0001 test ETH. No real swap, redemption, or fair-market pricing is represented.
- Refunds require operator review of the saved shielded destination and recovery record. No automatic refund or general retry endpoint exists. Ambiguous broadcasts and crashed native sends are reconciled by their original IDs/hashes; never delete state to force retry.
- Current ownership is checked again during reconciliation. If the user later transfers the NFT, the prototype conservatively surfaces ownership uncertainty; it does not distinguish a later user sale from failed delivery without operator review.
- A local process with this Windows account's filesystem privileges is trusted. The separation of signing helper and provider is architectural, not hardware isolation.
- The supplied marketplace artwork is browser-rendered demonstration art; the ERC-721 collection has no production metadata hosting.
- Synthetic tests are failure-injection evidence only. They do not prove a live shielded payment. See PHASE3-RESULTS for the separate live status.
