#!/usr/bin/env tsx
/**
 * CLI.
 *
 *   tsx src/index.ts --source ./fixtures/export --database-url postgres://… [--dry-run]
 *                    [--report-dir ./reports]
 *
 * Exit codes:
 *   0  clean — nothing blocking, and (unless --dry-run) the transaction committed
 *   1  one or more ERRORS in the reconciliation. The migration is not trustworthy;
 *      fix the source records the report names and run again. This is the gate.
 *   2  the tool itself failed (unreadable source, database unreachable, a bug)
 *
 * Note the asymmetry between exit 1 and exit 2: exit 1 means the tool worked
 * correctly and is telling you the DATA is not ready. That is a successful run
 * of a migration gate, and the report is the deliverable.
 */
import { resolve } from 'node:path';

import { readLegacyExport } from './read.js';
import { buildPlan } from './transform/index.js';
import { load, type LoadResult } from './load.js';
import { buildReport, renderConsoleSummary, writeReport } from './report.js';

interface Args {
  source: string;
  databaseUrl: string | null;
  dryRun: boolean;
  reportDir: string;
  help: boolean;
}

const USAGE = `
Base44 → PostgreSQL migration for RVC Dispatch.

  --source <dir>          Directory of Base44 JSON/NDJSON exports (required)
  --database-url <url>    Postgres connection string. Omit to run transforms and
                          produce the report without touching a database.
  --dry-run               Execute every insert inside a transaction, exercising all
                          constraints, then roll back. Nothing is committed.
  --report-dir <dir>      Where to write the report (default: ./reports)
  --help                  This message

Exits non-zero when the reconciliation contains errors, so it can gate a real run.
`.trim();

function parseArgs(argv: string[]): Args {
  const args: Args = {
    source: '',
    databaseUrl: process.env['DATABASE_URL'] ?? null,
    dryRun: false,
    reportDir: 'reports',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`${a} requires a value`);
      }
      i += 1;
      return v;
    };
    switch (a) {
      case '--source':
        args.source = next();
        break;
      case '--database-url':
        args.databaseUrl = next();
        break;
      case '--report-dir':
        args.reportDir = next();
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }

  return args;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.source === '') {
    console.error(`--source is required.\n\n${USAGE}`);
    return 2;
  }

  const sourceDir = resolve(args.source);
  const reportDir = resolve(args.reportDir);

  console.log(`Reading Base44 export from ${sourceDir}`);
  const read = readLegacyExport(sourceDir);

  const found = Object.entries(read.sourceCounts)
    .filter(([, n]) => n > 0)
    .map(([e, n]) => `${e} ${n}`)
    .join(', ');
  console.log(found === '' ? '  (no records found)' : `  ${found}`);

  console.log('Transforming…');
  const plan = buildPlan(read.export);

  let loadResult: LoadResult | null = null;
  if (args.databaseUrl !== null) {
    console.log(
      args.dryRun
        ? 'Loading into Postgres (dry run — will roll back)…'
        : 'Loading into Postgres…',
    );
    try {
      loadResult = await load(plan, { databaseUrl: args.databaseUrl, dryRun: args.dryRun });
    } catch (err) {
      console.error(`\nLoad failed; the transaction was rolled back and NOTHING was committed.`);
      console.error(`  ${(err as Error).message}`);
      // Still write the report: knowing what the transform produced is exactly
      // what you need in order to work out why the load failed.
      const failed = buildReport({ read, plan, load: null, sourceDir, dryRun: args.dryRun });
      const paths = writeReport(failed, reportDir);
      console.error(`\nReport written to ${paths.markdownPath}`);
      return 2;
    }
  } else {
    console.log('No --database-url given; producing the report without loading.');
  }

  const report = buildReport({ read, plan, load: loadResult, sourceDir, dryRun: args.dryRun });
  const paths = writeReport(report, reportDir);

  console.log('');
  console.log(renderConsoleSummary(report));
  console.log('');
  console.log(`Report: ${paths.markdownPath}`);
  console.log(`        ${paths.jsonPath}`);

  const unaccounted = report.reconciliation.filter((e) => e.unaccounted !== 0);
  if (unaccounted.length > 0) {
    console.error('');
    console.error(
      `BUG: ${unaccounted.map((e) => e.entity).join(', ')} do not reconcile — source rows are ` +
        `neither imported, merged nor skipped. This is a defect in the migration tool.`,
    );
    return 2;
  }

  if (report.summary.errors > 0) {
    console.error('');
    console.error(
      `${report.summary.errors} error${report.summary.errors === 1 ? '' : 's'} in the ` +
        `reconciliation. ${loadResult?.committed === true ? 'The data WAS committed — review urgently.' : 'Nothing was committed.'} ` +
        `Fix the records named in the report and run again.`,
    );
    return 1;
  }

  if (args.dryRun) {
    console.log('\nDry run clean. Re-run without --dry-run to commit.');
  } else if (loadResult?.committed === true) {
    console.log('\nCommitted.');
  }

  return 0;
}

const isEntry =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith('/src/index.ts'));

if (isEntry) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 2;
    });
}
