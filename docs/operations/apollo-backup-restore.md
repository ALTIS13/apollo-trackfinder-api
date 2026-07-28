# Apollo PostgreSQL Backup and Restore Gate

This gate is local-only. It must pass before a production migration or any approved remote rollout. It does not start, mount, name, or modify a detached legacy PostgreSQL volume.

## Custody and Destination

1. Create the encrypted backup destination with owner-only permissions before the maintenance window. The destination is supplied as `APOLLO_BACKUP_DESTINATION`; it is not created by the backup script.
2. Place the age recipient under independent recipient custody. Set it only through `APOLLO_BACKUP_AGE_RECIPIENT`. Do not put an identity, recipient, password, database URL, or destination path in a release manifest, command argument, ticket, or report.
3. Supply the PostgreSQL password only through `PGPASSFILE`. The scripts accept separate host, port, database, and user values; they do not accept a database URL or password argument.
4. Keep encrypted backups for `7 daily`, `4 weekly`, and `6 monthly` retention points. Deleting an encrypted backup requires the same retention decision record.

## Backup

The stack and database pair must be one of these exact identities:

| Stack | Database |
| --- | --- |
| `apollo-platform` | `apollo_platform` |
| `apollo-tf` | `apollo_trackfinder` |
| `apollo-tf-integrations` | `apollo_tf_integrations` |

Set `APOLLO_BACKUP_PGHOST`, `APOLLO_BACKUP_PGPORT`, `APOLLO_BACKUP_PGDATABASE`, `APOLLO_BACKUP_PGUSER`, `APOLLO_BACKUP_STACK`, and an immutable `APOLLO_BACKUP_RELEASE_ID`. Then run `deploy/ops/backup-postgres.sh` without arguments.

The script runs custom-format `pg_dump` directly into `age -r`. It writes only an encrypted `.dump.age`, a SHA-256 `.sha256`, and redacted `.json` metadata. It creates temporary files within the destination, atomically renames final files, applies `0600`, removes partial output on failure, and reports only a stage name.

## Restore Evidence

Restores are allowed only into a disposable target named explicitly through `APOLLO_RESTORE_PGDATABASE`. Set `APOLLO_RESTORE_DISPOSABLE=1`, the separate target host, port, database, and user values, `PGPASSFILE`, the temporary age identity, backup evidence files, and the expected stack, database, and immutable release ID.

Run `deploy/ops/restore-postgres.sh` without arguments. It rejects a checksum mismatch, evidence whose stack/database/release ID does not match, a non-empty target, and a non-disposable target. It streams age decryption directly into `pg_restore` with no plaintext dump file.

Record the restore evidence ID, schema comparison, data-marker comparison, release ID, and reviewer approval before approving migrations. A migration is not approved merely because an encrypted backup exists.

## Retained-Volume Quarantine

Use `deploy/ops/classify-retained-volume.sh` only with an operator-supplied volume identifier. It reads Docker metadata and emits `DETACHED_UNKNOWN`, `ATTACHED_BLOCKED`, or `FRESH_RELEASE_VOLUME`; it never starts PostgreSQL. Unknown legacy data may advance only after an encrypted backup and restore against a cloned disposable volume under separate approval.

## Release Decision and Rollback

Queues are reconstructable. PostgreSQL and download files are not reconstructable, and both persistent classes require an explicit release decision. Before migration approval, decide whether each PostgreSQL cluster and download-file class is retained, migrated, restored, or deliberately replaced.

For rollback, stop the approved rollout path, preserve the failed-release evidence, and restore only into a freshly created disposable verification target first. Promote a restoration only after a separate approved decision; this gate does not authorize production writes or remote mutations.
