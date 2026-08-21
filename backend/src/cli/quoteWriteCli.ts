import 'dotenv/config';
import path from 'node:path';
import { getEffectiveQuoteDispositions, openDb, quoteExtractionAlreadyWritten } from '../db/db.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { isWritable, type QuoteDisposition } from '../quoteWriter/quoteDisposition.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('quote');

/**
 * Vendor Quote Writer — write CLI.
 *
 * Exists specifically so the FIRST real write against a given environment
 * can be done deliberately, one order at a time, watched from a terminal —
 * this project's standing discipline for any new kind of production action
 * (see CLAUDE.md's read-only-smoke-test-first note).
 *
 * Usage:
 *   npm run quote:write -- <quoteRunId> list
 *   npm run quote:write -- <quoteRunId> write <orderNumber1,orderNumber2> [--env stage] [--confirm]
 *
 * `list` writes nothing — it prints what IS and ISN'T writable and why.
 * `write` requires --confirm before it touches anything, so a mistyped
 * command can never itself perform a real write.
 *
 * Defaults to production (same as every other CLI here); pass --env stage
 * to target stage instead.
 */

interface Row {
  id: number;
  order_number: string | null;
  vendor_name: string | null;
  serial_number: string | null;
  unit_price: number | null;
  resolved_esd: string | null;
  document_kind: string;
  source_entry_id: string;
}

function describeBlockers(row: Row, disposition: QuoteDisposition, alreadyWritten: boolean): string[] {
  const blockers: string[] = [];
  if (!isWritable(disposition)) blockers.push(`disposition=${disposition}`);
  if (row.document_kind !== 'quote') blockers.push(`not a quote (${row.document_kind})`);
  if (alreadyWritten) blockers.push('already written successfully');
  if (!row.order_number) blockers.push('no order number');
  if (row.unit_price === null) blockers.push('no price');
  if (!row.serial_number) blockers.push('no serial number');
  if (!row.resolved_esd) blockers.push('no ESD');
  return blockers;
}

async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const confirm = rest.includes('--confirm');
  const args = rest.filter((a) => a !== '--confirm');

  const runId = Number(args[0]);
  const action = args[1];
  if (!Number.isInteger(runId) || runId <= 0 || (action !== 'list' && action !== 'write')) {
    log.error(
      'Usage: npm run quote:write -- <quoteRunId> list | <quoteRunId> write <orderNumbers> [--env stage] [--confirm]',
    );
    process.exitCode = 1;
    return;
  }

  const db = openDb(path.join('data', 'audit.db'));
  const rows = db
    .prepare(
      `SELECT id, order_number, vendor_name, serial_number, unit_price, resolved_esd, document_kind, source_entry_id
       FROM quote_extractions WHERE run_id = ? ORDER BY id`,
    )
    .all(runId) as Row[];

  if (rows.length === 0) {
    log.error({ runId }, 'No quote extractions found for that run id.');
    db.close();
    process.exitCode = 1;
    return;
  }

  const dispositions = getEffectiveQuoteDispositions(db, runId);

  console.log(`\nQuote run ${runId} — target env: ${env.toUpperCase()}\n`);
  const writable: Row[] = [];
  for (const row of rows) {
    const disposition = (dispositions.get(row.id)?.disposition ?? 'pending') as QuoteDisposition;
    const blockers = describeBlockers(row, disposition, quoteExtractionAlreadyWritten(db, row.id));
    if (blockers.length === 0) writable.push(row);
    const label = (row.order_number ?? `#${row.id}`).padEnd(10);
    const price = row.unit_price === null ? '—' : row.unit_price.toFixed(2);
    console.log(
      `  [${blockers.length === 0 ? 'WRITABLE' : 'blocked '}] ${label} ${price.padStart(12)}  ESD ${row.resolved_esd ?? '—'}` +
        `${blockers.length ? `   << ${blockers.join('; ')}` : ''}`,
    );
  }
  console.log(`\n${writable.length} of ${rows.length} row(s) writable.\n`);

  if (action === 'list') {
    db.close();
    return;
  }

  const requested = (args[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (requested.length === 0) {
    log.error('write requires a comma-separated list of order numbers.');
    db.close();
    process.exitCode = 1;
    return;
  }

  const selected = writable.filter((r) => requested.includes(r.order_number ?? ''));
  const unmatched = requested.filter((o) => !selected.some((r) => r.order_number === o));
  if (unmatched.length > 0) {
    log.error(
      { unmatched },
      'Some requested order(s) are not writable under this run (see the list above) — refusing the whole request.',
    );
    db.close();
    process.exitCode = 1;
    return;
  }

  console.log(`Would write ${selected.length} order(s) to ${env.toUpperCase()}:`);
  for (const r of selected) {
    console.log(`   ${r.order_number}  ${r.unit_price!.toFixed(2)}  ESD ${r.resolved_esd}  (${r.vendor_name ?? '—'})`);
  }

  if (!confirm) {
    console.log(`\nNothing written. Re-run with --confirm to actually perform this write.\n`);
    db.close();
    return;
  }

  db.close();

  // Delegates to the exact same runner the UI uses — no second write path
  // to drift out of sync with the guards documented there.
  const { spawn } = await import('node:child_process');
  const child = spawn(
    process.execPath,
    [
      path.join('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/api/jobRunners/quoteWriteRunner.ts',
      '--env',
      env,
      '--db-run-id',
      String(runId),
      '--extraction-ids',
      JSON.stringify(selected.map((r) => r.id)),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );

  child.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'order-result') {
          console.log(
            `  ${e.status.toUpperCase().padEnd(8)} ${e.orderNumber}` +
              `${e.markedRead ? ' (email marked read)' : ''}` +
              `${e.errorMessage ? ` — ${e.errorMessage}` : ''}`,
          );
        } else if (e.type === 'done') {
          console.log(`\nDone: ${e.written} written, ${e.skipped} skipped, ${e.failed} failed.\n`);
        } else if (e.type === 'fatal') {
          console.error(`FATAL: ${e.message}`);
        }
      } catch {
        // non-envelope output — ignore
      }
    }
  });

  await new Promise<void>((resolve) => child.on('close', () => resolve()));
}

main().catch((err) => {
  log.error({ error: err instanceof Error ? err.message : String(err) }, 'quote write CLI failed');
  process.exitCode = 1;
});
