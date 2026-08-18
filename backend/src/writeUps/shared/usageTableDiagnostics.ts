import type { Page } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { UsageParmRowLike } from './usageTable.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

const DIAGNOSTICS_DIR = path.join('data', 'diagnostics');

/**
 * CLAUDE_CODE_PROMPT_USAGE_TABLE_BUG.md, required change 1 — captured on
 * EVERY usage-table read, success and failure alike, per the explicit
 * instruction to gather real evidence BEFORE changing any selector or
 * predicate. Deliberately best-effort, same discipline as
 * aeroRepair/emptyReadCapture.ts and vendorCodeGridDiagnostics.ts — a
 * capture failure must never crash or alter the real flow it instruments.
 * Read-only: only ever calls page.screenshot()/locator reads, nothing that
 * fills/submits/clicks.
 *
 * B2 (logging migration) — this was previously unconditional (fired on
 * every single read, happy path included), which is real screenshot +
 * disk-write overhead on a hot path just to have evidence "just in case."
 * Now gated behind DIAGNOSTICS_CAPTURE=='true' (same exact-literal-string
 * convention as config.ts's readHeadlessFlag) — off by default, opt-in for
 * a session where usage-table evidence is actually being investigated.
 */
export async function captureUsageTableDiagnostics(
  page: Page,
  context: {
    partNumber: string;
    serialNumber: string;
    resolvedBy: string;
    rowSelectorDescription: string;
    matchedRowCount: number;
    tableHtml: string | null;
    tableInnerText: string | null;
    parsedRows: UsageParmRowLike[];
  },
): Promise<void> {
  if (process.env.DIAGNOSTICS_CAPTURE !== 'true') {
    return;
  }
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = `usage-table-${context.partNumber}-${timestamp}`;
    await fs.mkdir(DIAGNOSTICS_DIR, { recursive: true });
    const screenshotPath = path.join(DIAGNOSTICS_DIR, `${basename}.png`);
    const textPath = path.join(DIAGNOSTICS_DIR, `${basename}.txt`);

    await page.screenshot({ path: screenshotPath, fullPage: true });

    const report = [
      'Usage-table read — evidence capture (CLAUDE_CODE_PROMPT_USAGE_TABLE_BUG.md)',
      `Captured at: ${new Date().toISOString()}`,
      `URL: ${page.url()}`,
      `Part Number: ${context.partNumber}`,
      `Serial Number: ${context.serialNumber}`,
      `Wait predicate that resolved: ${context.resolvedBy}`,
      `Row selector (verbatim): ${context.rowSelectorDescription}`,
      `Count of elements matched by the row selector: ${context.matchedRowCount}`,
      '',
      '=== Parsed row array, exactly as handed to the notes composer ===',
      JSON.stringify(context.parsedRows, null, 2),
      '',
      '=== Verbatim innerText of the table element ===',
      context.tableInnerText ?? '(no table element found)',
      '',
      '=== Full HTML dump of the table element and its parent container ===',
      context.tableHtml ?? '(no table element found)',
    ].join('\n');

    await fs.writeFile(textPath, report, 'utf-8');
    log.warn(
      { partNumber: context.partNumber, serialNumber: context.serialNumber, screenshotPath, textPath },
      '[usage-table-diagnostics] evidence saved',
    );
  } catch (err) {
    log.warn(
      { errorMessage: err instanceof Error ? err.message : String(err) },
      '[usage-table-diagnostics] Failed to capture evidence (non-fatal, continuing)',
    );
  }
}
