# VPS security boundary

## Trust split

The VPS is an online observer and orchestrator. It may hold a Zcash UFVK, public relayer/recipient addresses, pinned price-authority public keys, provider credentials, encrypted backups, and financial journals. A UFVK is not a spending key, but it reveals wallet activity and is sensitive.

The VPS must never hold Base or Solana private keys, Zcash spending keys/seeds, refund keys, signer passphrases, execution-authority private keys, or the backup decryption identity.

Two independent human-controlled security roles remain mandatory:

1. The operator/approval device reviews order, payment evidence, quote, recipient, amount, fees, limits, exact prepared/signed digests, expiry, and nonce; it issues the replay-resistant execution authorization.
2. A separate physical signing device validates the same bounded transaction and signs the Base or Solana transaction bytes. It does not accept a public network request from the VPS.

A single Windows PC running two processes or accounts does not demonstrate this separation. The Contabo VPS is not the second signer because it is online and controls orchestration. Production acceptance needs a separate computer or hardware-backed offline workflow plus recorded attestations.

## Management channel

Use SSH public-key authentication through a fixed source IP, WireGuard/Tailscale private network, or both. Disable password and root login. Use a dedicated unprivileged `zecone` deployment account with narrowly scoped sudo rights for Docker/system updates. Protect the operator's SSH key with a passphrase and hardware-backed key where available.

There is no public signing or operator API. Health is VPS-loopback only. Administration uses an interactive SSH session and `deploy/zecone-vps`; signed bundles move as files with explicit hashes. Do not use chat, email, public object storage, clipboard synchronization, or URLs containing order/payment data.

Execution authorizations already bind the domain, exact order, network, terms digest, prepared digest, signed digest, transaction ID, maximum debit, expiry, and a 256-bit nonce. The pinned Ed25519 authority key verifies them. Replacing any bytes requires a new authorization. Signer revocation and emergency pause are separate durable controls.

## Host hardening

- Install security updates and reboot deliberately during a paused window.
- Disable SSH passwords, root login, agent forwarding, X11 forwarding, and unused services.
- Restrict SSH by firewall and provider firewall. Keep health on `127.0.0.1`.
- Run ZecOne as its own Compose project and Unix user. Do not share Docker volumes with other apps.
- Treat Docker group membership as root-equivalent. Limit it to the deployment account.
- Mount configuration read-only; state/log directories are mode 0700. Review ownership after restore.
- Use Docker's `local` bounded log driver. Forward only redacted structured events if remote monitoring is added.
- Enable disk, inode, memory, CPU, restart, clock-skew, certificate-expiry, provider-latency, provider-disagreement, stale-price, stale-scan, paused-state, and uncertain-submission alerts.
- Keep the system clock synchronized. Quotes, approvals, blockhashes, confirmations, and leases depend on time.

## Financial state

The service starts paused and creates a unique deployment marker. A non-empty directory without that marker is refused, preventing accidental activation of copied historical journals. Base and Solana use separate submission databases. The operator lease provides monotonic fencing; only one writer may prepare/submit.

Signed bytes are persisted before broadcast. A lost response or lost guard becomes `uncertain`; no retry or replacement is constructed until exact-chain reconciliation. Completed or historical source commitments stay unique. Refunds remain disabled and mutually exclusive with execution.

Backups are encrypted to an offline age recipient. The VPS has no backup decryption key. Online SQLite backup prevents torn copies; offline restore tests verify database integrity. Backup access still exposes the UFVK, financial metadata, and cross-chain correlations after decryption, so restrict and audit it.

## Incident sequence

1. Run `deploy/zecone-vps pause INCIDENT_CODE` over the private SSH path.
2. Independently lock/revoke the offline signer and execution-authority credentials.
3. Preserve container logs and encrypted state backup without publishing identifiers.
4. Inspect every claimed, signed, broadcast, or uncertain transaction by its original exact identity.
5. Do not mark ambiguous state failed or release its reservation.
6. Rotate provider credentials and SSH access if exposure is suspected.
7. Restore only to a new empty state directory, verify integrity/permissions, and reconcile before any re-arming review.

The emergency pause cannot undo an already submitted transaction. Provider corroboration is not local consensus verification. The current Zcash design still lacks independent Merkle-inclusion/proof-of-work verification and remains NO-GO for real mainnet settlement until that boundary is accepted or replaced by authenticated local node evidence.

