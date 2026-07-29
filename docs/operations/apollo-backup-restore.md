# Apollo PostgreSQL Backup and Restore Gate

This gate is local-only. It must pass before a production migration or any approved remote rollout. It does not start, mount, name, or modify a detached legacy PostgreSQL volume.

## Supported Runtime

Run the operator scripts on native Linux with a POSIX-compatible `/bin/sh`,
`age` 1.2.1-compatible encryption, and GNU-compatible `mktemp`, `sha256sum`,
`stat`, `chmod`, `ln`, and `mv` behavior. `mktemp` must support a
destination-local template and `sha256sum` must emit and verify the GNU
checksum format consumed by the gate. This is not a generic BSD/macOS
portability claim.

Use the exact client/server major matrix:

| Stack                    | Database                 | `pg_dump` and server major |
| ------------------------ | ------------------------ | -------------------------- |
| `apollo-platform`        | `apollo_platform`        | PostgreSQL 16              |
| `apollo-tf`              | `apollo_trackfinder`     | PostgreSQL 16              |
| `apollo-tf-integrations` | `apollo_tf_integrations` | PostgreSQL 17              |

The scripts check the exact `pg_dump` major and `SHOW server_version_num`
before backup work. Cross-major evidence is rejected. Current separate local
disposable proof IDs are `pg16-disposable-proof-001` and
`pg17-integrations-disposable-proof-001`, both from source
`0f1e89ede85a07e6ac08a208328a08df29c1fcde`. Fresh opt-in proofs passed
`1 passed / 71 skipped` for PostgreSQL 16 in `32.203s` and
`1 passed / 71 skipped` for PostgreSQL 17 in `17.174s`, including exact zero
owned-resource cleanup. Production backup/restore evidence is `NOT_RECORDED`;
neither local ID approves a production migration or data write.

The paired checked-in placeholder validation failed closed with exactly
`19 image_provenance`, `18 placeholder_image_digest`, `1 release_artifact`,
and `1 release_environment_value`, with `0 environment_contract` and no other
category. No workflow, registry publication, retained-volume access, or remote
mutation occurred while recording this local evidence.

## Custody and Destination

1. Create the encrypted backup destination with owner-only permissions before the maintenance window. The destination is supplied as `APOLLO_BACKUP_DESTINATION`; it is not created by the backup script.
2. Place the age recipient under independent recipient custody and set it through `APOLLO_BACKUP_AGE_RECIPIENT`. Credentials, PostgreSQL passwords, database URLs, and age identities never enter argv. The public age recipient is passed to `age -r`, and destination-derived paths are passed to local child utilities, so those non-secret values are visible in local process metadata. Do not put any of them in a release manifest, ticket, log, or report.
3. Supply the PostgreSQL password only through `PGPASSFILE`. The scripts accept separate host, port, database, and user values; they do not accept a database URL or password argument.
4. Keep encrypted backups for `7 daily`, `4 weekly`, and `6 monthly` retention points. Deleting an encrypted backup requires the same retention decision record.

## Backup

The stack and database pair must be one of these exact identities:

| Stack                    | Database                 |
| ------------------------ | ------------------------ |
| `apollo-platform`        | `apollo_platform`        |
| `apollo-tf`              | `apollo_trackfinder`     |
| `apollo-tf-integrations` | `apollo_tf_integrations` |

Set `APOLLO_BACKUP_PGHOST`, `APOLLO_BACKUP_PGPORT`, `APOLLO_BACKUP_PGDATABASE`, `APOLLO_BACKUP_PGUSER`, `APOLLO_BACKUP_STACK`, and an immutable `APOLLO_BACKUP_RELEASE_ID`. Then run `deploy/ops/backup-postgres.sh` without arguments.

The script first atomically creates a destination-local release-ID claim. Any
existing active, complete, quarantined, concurrent, or stale claim fails closed
and remains for operator review. A claim is never reused after completion.

The script runs custom-format `pg_dump` directly into `age -r`. It writes only
an encrypted `.dump.age`, a SHA-256 `.sha256`, and redacted `.json` metadata.
Final paths are published with no-overwrite hard links under the owned claim.
The invocation records owned inodes and removes a final path on failure only
when it is still the same inode; it never deletes or overwrites another
invocation's evidence. Failed owned claims become `quarantined`, successful
claims become `complete`, files use `0600`, and error output contains only the
failed stage.

## Restore Evidence

Restores are allowed only into a disposable target named explicitly through `APOLLO_RESTORE_PGDATABASE`. Set `APOLLO_RESTORE_DISPOSABLE=1`, the separate target host, port, database, and user values, `PGPASSFILE`, the temporary age identity, backup evidence files, and the expected stack, database, and immutable release ID.

Run `deploy/ops/restore-postgres.sh` without arguments. It rejects a checksum mismatch, evidence whose stack/database/release ID does not match, a non-empty target, and a non-disposable target. It streams age decryption directly into `pg_restore` with no plaintext dump file.

Record the restore evidence ID, schema comparison, data-marker comparison, release ID, and reviewer approval before approving migrations. A migration is not approved merely because an encrypted backup exists.

The production evidence ID must be redacted and owner-reviewable. Never place
the backup destination, age identity, recipient, `PGPASSFILE`, database
address, database URL, or any credential in the evidence record.

## Retained-Volume Quarantine

Use `deploy/ops/classify-retained-volume.sh` only with an operator-supplied
volume identifier. It reads Docker metadata and emits only
`DETACHED_UNKNOWN` or `ATTACHED_BLOCKED`; it never starts PostgreSQL.
Metadata-only inspection cannot prove that a detached volume is empty or
fresh, and no static label is accepted as such proof. Unknown legacy data may
advance only after an encrypted backup and restore against a cloned disposable
volume under separate approval.

The currently discovered legacy class is `DETACHED_UNKNOWN`. Its private name
is not tracked. It remains unnamed, unmounted, unstarted, unmodified, and
outside both production manifests.

## Release Decision and Rollback

Queues are reconstructable. PostgreSQL and download files are not reconstructable, and both persistent classes require an explicit release decision. Before migration approval, decide whether each PostgreSQL cluster and download-file class is retained, migrated, restored, or deliberately replaced.

For rollback, stop the approved rollout path, preserve the failed-release evidence, and restore only into a freshly created disposable verification target first. Promote a restoration only after a separate approved decision; this gate does not authorize production writes or remote mutations.
