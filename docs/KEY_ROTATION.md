# Encryption key rotation

Driver licence numbers, licence images and authenticator secrets are encrypted
at rest with AES-256-GCM. This page is how to change the key without losing
anything.

## How values are tagged

- New field values look like `v2.<keyId>.<nonce>.<tag>.<ciphertext>`.
- New files start with a small header (`RVCK`, key id) before nonce, tag and ciphertext.
- Values written before key ids existed (`v1.` fields, header-less files) are
  still read: they are tried against the current key, then every retired key.

## Settings

| Variable | Meaning |
|---|---|
| `FIELD_ENCRYPTION_KEY` | Current key, base64 of 32 bytes. Everything new is written with it. |
| `FIELD_ENCRYPTION_KEY_ID` | Name of the current key. Default `k1`. |
| `FIELD_ENCRYPTION_OLD_KEYS` | Retired keys, decrypt-only: `k1:BASE64,k0:BASE64`. |
| `FIELD_ENCRYPTION_ROTATE_ON_BOOT` | `true` runs the re-encrypt pass once in the background at startup. |

## Rotating (nothing is destroyed at any step)

1. Generate a new key: `openssl rand -base64 32`.
2. Set `FIELD_ENCRYPTION_OLD_KEYS=k1:<current key>` (append if there are already retired keys).
3. Set `FIELD_ENCRYPTION_KEY=<new key>` and `FIELD_ENCRYPTION_KEY_ID=k2`.
4. Re-encrypt old data onto k2:
   - with a shell: `npm run keys:rotate -w apps/api -- --dry-run`, then without `--dry-run`;
   - on Render free (no shell): set `FIELD_ENCRYPTION_ROTATE_ON_BOOT=true`, deploy,
     and look in the log for `field key rotation pass finished`.
5. Only when the report shows `remaining: 0` and `unreadable: 0`, remove the
   old key from `FIELD_ENCRYPTION_OLD_KEYS` and set `FIELD_ENCRYPTION_ROTATE_ON_BOOT=false`.

Keep a copy of every retired key with the database backups it belongs to: a
backup taken before the rotation needs the old key to be read.

## What the pass guarantees

- A value already on the current key is not touched, so repeated runs are safe.
- A value is rewritten only after the new ciphertext decrypts back to the same plaintext.
- A file is rewritten only after its re-encrypted bytes decrypt to content matching the stored sha256.
- Anything no configured key can open is counted as `unreadable` and left exactly as it was.
