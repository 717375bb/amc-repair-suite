import 'dotenv/config';
import path from 'node:path';
import { insertInferenceRecords, insertRun, openDb } from '../../db/db.js';
import { applyInferenceRules } from '../../inference/applyInferenceRules.js';
import { AnthropicEsdProvider } from '../../inference/anthropicProvider.js';
import { classifyRowAction, type RowActionType } from '../../inference/classifyRowAction.js';
import { matchOrders } from '../../matching/matchOrders.js';
import { assembleNoteText } from '../../mxiWriter/esdFormatting.js';
import { exportExcel } from '../../output/exportExcel.js';
import type { InferenceRecord, RunSummary } from '../../types.js';
import { ingestEsdFinderFiles, type DuplicateOrderNumber } from '../esdFinder/ingestion.js';
import { watchStdinForCancellation } from './cancellationWatcher.js';
import { getSecretProvider } from '../../security/secretProvider.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('esd');

/**
 * Open Order ESD Finder — comparison job runner. Spawned by
 * esdFinderJobManager.ts (reusing jobManager.ts's spawnRunner — same
 * process-spawning discipline as the Order Write-Ups runners: no shell,
 * env inherited rather than touched, one JSON envelope per stdout line).
 *
 * Calls the EXISTING pipeline unchanged: ingestEsdFinderFiles (new
 * ingestion-only work), matchOrders, applyInferenceRules (real Haiku calls
 * via AnthropicEsdProvider), exportExcel. No reimplementation of matching,
 * inference, or scoring logic — this file is wiring, not a second pipeline.
 *
 * Single bulk operation, not a per-line stream like the write-up runners
 * (there is no meaningful "line N of M" here — applyInferenceRules
 * processes the whole matched set as one call) — emits a couple of phase
 * envelopes for UI feedback, then one final 'done' envelope carrying the
 * complete result, or one 'fatal' envelope on failure.
 */

interface EsdCompareEnvelope {
  type: 'phase' | 'done' | 'fatal';
  phase?: string;
  message?: string;
  result?: EsdCompareResult;
}

/**
 * InferenceRecord plus the display-only fields State B's UI needs that
 * aren't part of the audit-table shape itself:
 *   - `actionType` (CLAUDE_CODE_PROMPT, ESD writer changes A4) — replaces
 *     the old plain `actionable` boolean with the 3-way classification
 *     from classifyRowAction.ts: 'esd_write' (flag === 'ok', same
 *     condition approveAndWrite.ts and every other write-eligible query in
 *     this project already used) / 'note_only_reissue' (no usable ESD, but
 *     real vendor commentary — write the note and reissue, never the ESD
 *     field) / 'skipped_no_commentary'. `actionable` is kept too, derived
 *     from actionType, for any consumer that only needs the boolean.
 *   - `notesToReceiverPreview`, via the existing assembleNoteText() rather
 *     than reimplementing its formatting rules — passes the pushed ESD
 *     (record.inferredEsd) only on the esd_write branch, per A1/A4, so the
 *     preview always matches what a real write would actually produce.
 *   - `partNumber`/`serialNumber` — InferenceRecord itself doesn't carry
 *     these (applyInferenceRules.ts's BaseFields never needed them for
 *     inference), but the spec's review table requires showing them. Zipped
 *     in by index from the matched orders that produced each record, not
 *     re-derived — applyInferenceRules() processes matchedOrders in a
 *     single, unfiltered `for` loop and pushes exactly one record per
 *     order in the same order, so records[i] always corresponds to
 *     matched[i]. Prefers the vendor row's own value, falling back to the
 *     CRA row's, same preference order applyInferenceRules.ts itself uses
 *     for vendorName.
 * All are display-only — the DB insert below still stores the plain
 * InferenceRecord[], unchanged.
 */
export interface EsdCompareResultRow extends InferenceRecord {
  actionType: RowActionType;
  actionable: boolean;
  notesToReceiverPreview: string | null;
  partNumber: string | null;
  serialNumber: string | null;
}

export interface EsdCompareResult {
  dbRunId: number;
  records: EsdCompareResultRow[];
  duplicates: DuplicateOrderNumber[];
  outputFilePath: string;
  summary: RunSummary;
}

function emit(envelope: EsdCompareEnvelope): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

interface FileRef {
  filePath: string;
  fileName: string;
}

function parseArgs(): { vendorFiles: FileRef[]; craFile: FileRef } {
  const args = process.argv.slice(2);
  const vendorFilesIdx = args.indexOf('--vendor-files');
  const craFileIdx = args.indexOf('--cra-file');
  const rawVendorFiles = vendorFilesIdx >= 0 ? args[vendorFilesIdx + 1] : undefined;
  const rawCraFile = craFileIdx >= 0 ? args[craFileIdx + 1] : undefined;

  if (!rawVendorFiles) throw new Error('--vendor-files is required (JSON array of {filePath, fileName})');
  if (!rawCraFile) throw new Error('--cra-file is required (JSON object {filePath, fileName})');

  const vendorFiles = JSON.parse(rawVendorFiles) as FileRef[];
  const craFile = JSON.parse(rawCraFile) as FileRef;
  if (!Array.isArray(vendorFiles) || vendorFiles.length === 0) {
    throw new Error('--vendor-files must be a non-empty JSON array.');
  }
  return { vendorFiles, craFile };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const { vendorFiles, craFile } = parseArgs();

  // CLAUDE_CODE_PROMPT (#6-hardening, secrets-seam) — this runner never
  // touches MXI, so it never goes through cliMxiClient.ts's embedded
  // init() call — needs its own.
  const secretProvider = getSecretProvider();
  await secretProvider.init();
  const apiKey = secretProvider.get('ANTHROPIC_API_KEY');

  // CLAUDE_CODE_PROMPT (cancel button) — this runner never opens an MXI
  // browser (pure file parsing + AI inference + Excel export), so there's
  // no orphaned-session risk to guard against — checked between phases
  // purely to skip real, avoidable cost (most importantly the real
  // Anthropic API calls in 'inferring') once a cancel has been requested,
  // not to protect a shared resource. See cancellationWatcher.ts's
  // docstring for the general mechanism this shares with the other 3
  // runners.
  const cancelSignal = watchStdinForCancellation();

  emit({ type: 'phase', phase: 'ingesting' });
  const { vendorRows, craRows, duplicates } = await ingestEsdFinderFiles(vendorFiles, craFile);
  if (cancelSignal.aborted) return;

  emit({ type: 'phase', phase: 'matching' });
  const matched = matchOrders(vendorRows, craRows);
  if (cancelSignal.aborted) return;

  emit({ type: 'phase', phase: 'inferring' });
  const provider = new AnthropicEsdProvider(apiKey);
  const { records, summary } = await applyInferenceRules(matched, provider);
  if (cancelSignal.aborted) return;

  const db = openDb(path.join('data', 'audit.db'));
  const dbRunId = insertRun(db, {
    startedAt,
    vendorOorFile: vendorFiles.map((f) => f.fileName).join(', '),
    craOorFile: craFile.fileName,
    rowCount: records.length,
  });
  insertInferenceRecords(db, dbRunId, records);
  db.close();

  emit({ type: 'phase', phase: 'exporting' });
  const timestamp = startedAt.replace(/[:.]/g, '-');
  const outputFilePath = path.join('data', `esd-finder-output-${timestamp}.xlsx`);
  await exportExcel(records, outputFilePath);

  // CLAUDE_CODE_PROMPT (ESD writer changes, A3/A4) — per-row audit log of
  // which push mode fired and the classification/action decision, so both
  // transforms are auditable without re-deriving them from raw DB rows.
  const resultRows: EsdCompareResultRow[] = records.map((record, i) => {
    const order = matched[i];
    const actionType = classifyRowAction(record);
    // CORRECTED 2026-08-20 — the note states the vendor's own assumed ESD
    // (extractedBaseDate, pre-buffer), not inferredEsd (the buffered
    // promised-by date that goes into the ESD field). Must stay identical
    // to what esdWriteRunner.ts actually writes, or this preview lies.
    const assumedEsdForNote = actionType === 'esd_write' ? record.extractedBaseDate : null;

    log.info(
      {
        orderNumber: record.orderNumber,
        classification: record.classification,
        extractedBaseDate: record.extractedBaseDate,
        bufferDaysApplied: record.bufferDaysApplied,
        pushedEsd: record.inferredEsd,
        flag: record.flag,
        actionType,
      },
      'esd row classified',
    );

    return {
      ...record,
      actionType,
      actionable: actionType !== 'skipped_no_commentary',
      // Only a real, actionable branch gets a preview — a skipped row's
      // note (if any, e.g. a placeholder like "PENDING") is never going to
      // actually be written, so showing a preview for it would be
      // misleading, not just informational.
      notesToReceiverPreview:
        actionType === 'skipped_no_commentary' ? null : assembleNoteText(record.vendorNotes, assumedEsdForNote),
      partNumber: order.vendor?.partNumber ?? order.cra?.partNumber ?? null,
      serialNumber: order.vendor?.serialNumber ?? order.cra?.serialNumber ?? null,
    };
  });

  emit({
    type: 'done',
    result: { dbRunId, records: resultRows, duplicates, outputFilePath, summary },
  });
}

main().catch((err) => {
  emit({ type: 'fatal', message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
