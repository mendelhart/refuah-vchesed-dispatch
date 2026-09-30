# Admin full-backup download

The side-menu Admin > Full backup download produces a consistent PostgreSQL custom-format archive containing the database and DB-backed file bytes, encrypted using a passphrase entered by the admin. It is not the nightly GitHub backup format.

Save the `.rvc` file outside Render and keep the passphrase in a password manager. Retain Render's FIELD_ENCRYPTION_KEY and any FIELD_ENCRYPTION_OLD_KEYS separately; database backups cannot make those configuration keys recoverable.

Restore into a fresh database, not the live one:

1. Supply the passphrase securely as the BACKUP_PASSPHRASE environment variable. Do not put it in command history.
2. Run `node scripts/decrypt-full-backup.mjs downloaded.rvc output.dump`.
3. Run `pg_restore --no-owner --no-privileges -d TARGET_DATABASE output.dump`.
4. Configure the original field-encryption keys and run file-consistency checks before relying on the restored system.
5. Delete the unencrypted temporary dump after verification.

The API uses a 120-second timeout and a 128 MB dump limit. Larger databases need the offline backup route. The 7-day reminder records a completed response, not proof the browser saved the file or that it restores. An automated test restores a download into a fresh temporary database and verifies trips, binary blobs and audit records. A production offsite restore with the original field-encryption keys is still required.
