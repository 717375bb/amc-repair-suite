import 'dotenv/config';
import fs from 'node:fs';
import { createReadyMxiClient } from '../../mxiWriter/cliMxiClient.js';
import { openPartDetailsBySerial } from '../../mxiWriter/openInventoryBySerial.js';
import { readPartScrapNote } from '../../backShop/readPartScrapNote.js';
import { judgeScrapNote, noScrapNoteReason } from '../../backShop/scrapNoteJudgement.js';
import { evaluateBaseStation } from '../../writeUps/shared/approvedLocations.js';
import type { BackShopRow } from '../../backShop/backShopRows.js';
import type { BackShopFinding } from '../backShop/backShopJobManager.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import { watchStdinForCancellation } from './cancellationWatcher.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('scrap');

/**
 * Back-shop discovery runner — reads each listed part's note in MXI and
 * classifies it as a scrap candidate or not.
 *
 * READ-ONLY. It searches, opens the part record, reads one note cell, and
 * reports. It never fills a field, never submits a form, and never scraps
 * anything. The scrap itself is a separate, human-confirmed job on the
 * Scrap tab, which is what keeps an automated read from ever flowing
 * straight into an irreversible action.
 *
 * Two failure modes are kept strictly apart, because conflating them is how
 * this project's worst bugs have looked:
 *   - "read it, no scrap note" is an ANSWER about the part;
 *   - "could not read it" is a FAULT of ours, reported as 'unreadable' and
 *     never presented as a part with nothing to say.
 */

interface Envelope {
  type: 'phase' | 'finding' | 'fatal' | 'done';
  [key: string]: unknown;
}

function emit(envelope: Envelope): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

function parseArgs(): { env: MxiEnv; rowsPath: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const env = get('--env');
  if (env !== 'stage' && env !== 'production') throw new Error('--env must be exactly "stage" or "production".');
  const rowsPath = get('--rows-path');
  if (!rowsPath) throw new Error('--rows-path is required.');
  return { env, rowsPath };
}

async function main(): Promise<void> {
  const { env, rowsPath } = parseArgs();
  const rows = JSON.parse(fs.readFileSync(rowsPath, 'utf-8')) as BackShopRow[];
  const cancelSignal = watchStdinForCancellation();

  emit({ type: 'phase', phase: `checking 0 of ${rows.length} parts` });

  const client = await createReadyMxiClient(env);
  try {
    const page = await client.getAuthenticatedPage();

    for (const [index, row] of rows.entries()) {
      // Honoured BETWEEN parts. There is nothing to leave half-done inside
      // one part here (this job only reads), but stopping between them
      // keeps the reported findings consistent with what was checked.
      if (cancelSignal.aborted) {
        log.info({ remaining: rows.length - index }, 'back-shop discovery cancelled between parts');
        break;
      }

      emit({ type: 'phase', phase: `checking ${index + 1} of ${rows.length} parts` });

      const base = evaluateBaseStation(row.location);
      const finding: BackShopFinding = {
        partNumber: row.partNumber,
        serialNumber: row.serialNumber,
        partName: row.partName,
        cra: row.cra,
        location: row.location,
        sheetRow: row.sheetRow,
        outcome: 'unreadable',
        note: null,
        reason: null,
        baseApproved: base.approved,
        routedTo: base.approved ? base.routedTo : null,
      };

      const opened = await openPartDetailsBySerial(page, client.todoListUrl, row.serialNumber, row.partNumber);
      if (opened.status !== 'opened') {
        finding.reason = opened.error;
        emit({ type: 'finding', finding });
        continue;
      }

      const read = await readPartScrapNote(page);
      if (read.status === 'unreadable') {
        finding.reason = read.error;
        emit({ type: 'finding', finding });
        continue;
      }

      const judged = judgeScrapNote(read.note);
      finding.outcome = judged.recommendation;
      finding.note = read.note || null;
      finding.reason = judged.recommendation === 'scrap_recommended' ? null : noScrapNoteReason(read.note);
      emit({ type: 'finding', finding });
    }

    emit({ type: 'phase', phase: 'done' });
    emit({ type: 'done' });
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ err }, 'back-shop discovery runner failed');
  emit({ type: 'fatal', message });
  process.exit(1);
});
