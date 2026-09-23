/**
 * CLI: npm run files:check -w apps/api
 * Read-only: lists file rows whose bytes are missing, corrupt or undecryptable,
 * and (db driver) stored bytes with no row. Exit 2 if anything is wrong.
 */
import { checkFileConsistency } from '../services/files.service.js';
import { closeDb } from './client.js';

checkFileConsistency()
  .then(async (r) => {
    console.log(JSON.stringify(r, null, 2));
    await closeDb();
    process.exit(r.missingObjects.length + r.corrupt.length + r.orphanObjects.length > 0 ? 2 : 0);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
