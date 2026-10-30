# Stage 4B watch-only backup plan

Production backup status: **BLOCKED ON OPERATOR INPUT**. The encryption,
integrity and restore implementation passed with disposable data. No production
identity, wallet backup or off-host upload was created.

## Existing guarantees

`mainnet:watch-backup` accepts only a stopped, mainnet watch-only profile outside
the repository and historical `.secrets`/`.state` paths. It checks the manifest,
UFVK digest, file allowlist, file sizes and SQLite `PRAGMA integrity_check`.
It encrypts the archive to an age X25519 public recipient before writing, uses
exclusive mode `0600`, records a ciphertext SHA-256, and refuses overwrite.
Restore decrypts into a new temporary directory, verifies every file digest and
the SQLite database, then atomically renames the result. Wrong identities,
corruption, incomplete archives, testnet metadata, symlinks and existing output
directories fail closed.

The age private identity must remain on a separate operator device. Only the
public `age1...` recipient belongs on the VPS. A public recipient is not a
secret, but it must still be pinned and change-controlled to prevent backups
being encrypted to an attacker's key.

## Lowest-cost operator setup

1. On the offline recovery device, generate an age identity using the installed
   `age-keygen`. Store the identity in the operator's encrypted credential
   backup. Copy only the printed public recipient to a root-owned file on the
   VPS, mode `0640`, readable by the ZecOne backup job.
2. Choose an off-host destination controlled by the operator: an existing
   versioned object-storage bucket or a second encrypted machine. The VPS local
   disk and provider snapshot are not off-host backups.
3. Run `npm run mainnet:watch-backup -- backup` to a staging file on the
   dedicated ZecOne filesystem. Upload only the `.age` ciphertext and its
   SHA-256. Never upload the plaintext watch directory or age identity.
4. Confirm the remote object's byte length and SHA-256 before pruning any local
   ciphertext. Retain 7 daily, 4 weekly and 12 monthly successful backups.
   Enable provider versioning or object lock where available. A failed run must
   never delete the last successful generation.
5. Run a monthly restore drill on the offline device into a new disposable
   directory. Verify metadata and SQLite integrity, then securely remove the
   disposable restored copy.
6. Route job failure to an operator-controlled alert destination through a
   systemd `OnFailure=` unit or the existing monitoring service. Alert only on
   status, age and opaque job ID; exclude UFVKs, addresses, transaction IDs,
   paths containing secrets and archive contents.

Example backup creation after operator configuration:

```bash
umask 077
npm run --silent mainnet:watch-backup -- backup \
  --profile /var/lib/zecone/watch \
  --recipient-file /etc/zecone/backup-recipient.txt \
  --out /var/lib/zecone/backups/watch-$(date -u +%Y%m%dT%H%M%SZ).age \
  --confirm CREATE_WATCH_BACKUP
sha256sum /var/lib/zecone/backups/watch-*.age
```

Example offline restore drill:

```bash
npm run --silent mainnet:watch-backup -- restore \
  --backup /offline/incoming/watch-YYYYMMDDTHHMMSSZ.age \
  --identity-file /offline/keys/zecone-watch-backup.agekey \
  --out /offline/restore-drill/watch \
  --confirm RESTORE_WATCH_PROFILE
npm run --silent mainnet:watch-backup -- verify \
  --profile /offline/restore-drill/watch
```

The production job cannot be enabled until the operator supplies the pinned
public recipient, off-host destination, retention/lifecycle confirmation and
alert route. Upload tooling depends on that destination and must be reviewed
before credentials are installed. No generic uploader is enabled by default.
