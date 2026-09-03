import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { openPartDetailsBySerial } from '../mxiWriter/openInventoryBySerial.js';
import { findSyncedBackShopListing, fileModifiedAt } from '../backShop/backShopListingLocation.js';
import { parseBackShopListing } from '../backShop/backShopListingParser.js';
import { judgeFreshness, splitByEligibility } from '../backShop/backShopRows.js';
import { readPartScrapNote } from '../backShop/readPartScrapNote.js';
import { judgeScrapNote, noScrapNoteReason } from '../backShop/scrapNoteJudgement.js';
import { evaluateBaseStation } from '../writeUps/shared/approvedLocations.js';

/**
 * `npm run diag:backshop -- [--limit N] [--env production]`
 *
 * Runs the real discovery pass over the daily back-shop listing and prints
 * what it decided about each part, WITHOUT scrapping anything.
 *
 * Deliberately runs the SHIPPED code (openPartDetailsBySerial ->
 * readPartScrapNote -> judgeScrapNote) rather than a probe-local copy, so
 * what is validated here is what will actually run. Earlier versions dumped
 * raw DOM instead, which is how the note was found to live on the PART
 * record rather than the inventory record, and how two page-wide "scrap"
 * false positives (the inventory action bar, the part Scrap Rate field)
 * were caught before they could pre-select the whole list; that job is done.
 *
 * Read-only: searches, opens, reads. Nothing is filled or submitted.
 */

function usage(): never {
  console.error('Usage: npm run diag:backshop -- [--limit N] [--env production]');
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { env, rest } = parseEnvFlag(argv);
  const limitIdx = rest.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(rest[limitIdx + 1]) : 5;
  if (!Number.isFinite(limit) || limit < 1) usage();

  const located = findSyncedBackShopListing();
  if (!located) {
    console.error('Could not find BackShopListing.xlsm in any synced OneDrive root.');
    process.exit(1);
  }
  console.log(`sheet:  ${located.filePath}`);
  console.log(`synced: ${fileModifiedAt(located.filePath)?.toISOString() ?? 'unknown'}`);

  const { sheetDate, rows } = await parseBackShopListing(located.filePath);
  const fresh = judgeFreshness(sheetDate);
  if (fresh.warning) console.log(`WARNING: ${fresh.warning}`);
  const { open, alreadyHandled } = splitByEligibility(rows);
  const sample = open.slice(0, limit);
  console.log(
    `${rows.length} rows - ${open.length} open, ${alreadyHandled.length} already handled by the sheet. ` +
      `Probing the first ${sample.length}.\n`,
  );

  const client = await createReadyMxiClient(env);
  const findings: unknown[] = [];
  let recommended = 0;
  let noNote = 0;
  let negated = 0;
  let unreadable = 0;

  try {
    const page = await client.getAuthenticatedPage();

    for (const row of sample) {
      const base = evaluateBaseStation(row.location);
      const routing = base.approved ? `-> ${base.routedTo}` : '-> NOT APPROVED';
      console.log(`--- ${row.partNumber} / ${row.serialNumber}  (${row.location ?? '?'} ${routing}, ${row.cra ?? '?'})`);

      const opened = await openPartDetailsBySerial(page, client.todoListUrl, row.serialNumber, row.partNumber);
      if (opened.status !== 'opened') {
        unreadable += 1;
        console.log(`    ${opened.status}: ${opened.error}\n`);
        findings.push({ ...row, outcome: opened.status, detail: opened.error });
        continue;
      }

      const read = await readPartScrapNote(page);
      if (read.status === 'unreadable') {
        unreadable += 1;
        console.log(`    unreadable: ${read.error}\n`);
        findings.push({ ...row, outcome: 'unreadable', detail: read.error });
        continue;
      }

      const judged = judgeScrapNote(read.note);
      if (judged.recommendation === 'scrap_recommended') {
        recommended += 1;
        console.log(`    SCRAP RECOMMENDED: ${JSON.stringify(judged.evidence)}`);
      } else {
        if (judged.recommendation === 'scrap_negated') negated += 1;
        else noNote += 1;
        console.log(`    no scrap note - ${noScrapNoteReason(read.note)}`);
      }
      if (!base.approved) console.log(`    NOTE: ${base.reason}`);
      console.log('');

      findings.push({
        ...row,
        outcome: judged.recommendation,
        evidence: judged.evidence,
        rawNote: read.note,
        baseApproved: base.approved,
        routedTo: base.approved ? base.routedTo : null,
      });
    }

    console.log(`${recommended} scrap-recommended, ${negated} whose note forbids scrapping, ${noNote} with no scrap note, ${unreadable} unreadable.`);

    const dir = path.join('data', 'diagnostics');
    await fs.mkdir(dir, { recursive: true });
    const out = path.join(dir, `backshop-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await fs.writeFile(out, JSON.stringify(findings, null, 2), 'utf-8');
    console.log(`Saved: ${out}`);
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
