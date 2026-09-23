/**
 * CLI: npm run keys:rotate -w apps/api [-- --dry-run]
 * Re-encrypts stored secrets and files onto FIELD_ENCRYPTION_KEY. See
 * docs/KEY_ROTATION.md. On hosts without a shell, set
 * FIELD_ENCRYPTION_ROTATE_ON_BOOT=true for one deploy instead.
 */
import { rotateFieldKeys } from '../lib/key-rotation.js';
import { closeDb } from './client.js';

const dryRun = process.argv.includes('--dry-run');
rotateFieldKeys({ dryRun })
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    return closeDb().then(() => process.exit(r.fields.unreadable + r.files.unreadable > 0 ? 2 : 0));
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
