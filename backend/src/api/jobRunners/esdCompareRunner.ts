import 'dotenv/config';
import path from 'node:path';
import { insertInferenceRecords, insertRun, openDb } from '../../db/db.js';
import { applyInferenceRules } from '../../inference/applyInferenceRules.js';
import { AnthropicEsdProvider } from '../../inference/anthropicProvider.js';
import { matchOrders } from '../../matching/matchOrders.js';
import { assembleNoteText } from '../../mxiWriter/esdFormatting.js';
import { exportExcel } from '../../output/exportExcel.js';
import type { InferenceRecord, RunSummary } from '../../types.js';
import { ingestEsdFinderFiles, type DuplicateOrderNumber } from '../esdFinder/ingestion.js';
import { watchStdinForCancellation } from './cancellationWatcher.js';
import { getSecretProvider } from '../../security/secretProvider.js';

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
 *   - `actionable` (flag === 'ok' — the same condition approveAndWrite.ts
 *     and every other write-eligible query in this project already uses)
 *   - `notesToReceiverPreview`, via the existing assembleNoteText() rather
 *     than reimplementing its formatting rules
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

  const resultRows: EsdCompareResultRow[] = records.map((record, i) => {
    const order = matched[i];
    return {
      ...record,
      actionable: record.flag === 'ok',
      notesToReceiverPreview: record.flag === 'ok' ? assembleNoteText(record.vendorNotes) : null,
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
