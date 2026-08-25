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
    /**
     * Bypasses the DIAGNOSTICS_CAPTURE gate. Set on a FAILED read only.
     * The 2026-08-25 "the table is there, definitely" report was slow to
     * diagnose precisely because captures were gated off and the eight
     * failures left no evidence behind at all. Failures are rare and are
     * exactly the case worth the disk, so they now always capture; routine
     * successful reads stay opt-in as before.
     */
    force?: boolean;
  },
): Promise<void> {
  if (!context.force && process.env.DIAGNOSTICS_CAPTURE !== 'true') {
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
      // When the table element is MISSING, the two sections above say only
      // "(no table element found)" and the capture explains nothing — which
      // is exactly the hole hit on 2026-08-25, when eight lines reported an
      // absent table on a page the user could see it on. A missing table is
      // precisely the case that needs the surrounding page, so dump it.
      ...(context.tableHtml === null ? await describeMissingTable(page) : []),
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

/**
 * Evidence for the case the capture was blindest to: the usage table
 * element is not on the page at all. Answers, in order, the questions that
 * actually distinguish the possible causes:
 *   - is a "Current Usage" heading present but its table missing (a page
 *     that renders the section empty for this record), or is the heading
 *     absent too (we are on the wrong page or the wrong record entirely)?
 *   - which inventory record is this page actually showing? A page-wide
 *     click on a serial-number link can land on a DIFFERENT record than the
 *     row that was checked, and the page's own PN/SN is the only way to
 *     tell that apart from a genuinely usage-less part.
 *   - what tables DO exist, by id, so a renamed element is obvious at a
 *     glance rather than requiring another round trip.
 */
async function describeMissingTable(page: Page): Promise<string[]> {
  try {
    const probe = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? '';
      const headingIdx = bodyText.indexOf('Current Usage');
      const tableIds = Array.from(document.querySelectorAll('table'))
        .map((t) => t.id || '(no id)')
        .slice(0, 60);
      // The section around the heading, if the page has one at all.
      let currentUsageSection: string | null = null;
      for (const el of Array.from(document.querySelectorAll('td, div, table'))) {
        const text = (el as HTMLElement).innerText ?? '';
        if (text.trimStart().startsWith('Current Usage') && text.length < 4000) {
          currentUsageSection = (el as HTMLElement).outerHTML.slice(0, 4000);
          break;
        }
      }
      return {
        hasCurrentUsageHeading: headingIdx >= 0,
        aroundHeading: headingIdx >= 0 ? bodyText.slice(headingIdx, headingIdx + 600) : null,
        currentUsageSection,
        tableIds,
        bodyText: bodyText.slice(0, 6000),
      };
    });

    return [
      '',
      '=== WHY WAS THE TABLE MISSING? (auto-captured — see describeMissingTable) ===',
      `"Current Usage" heading present on the page: ${probe.hasCurrentUsageHeading}`,
      '',
      '--- page text starting at the "Current Usage" heading ---',
      probe.aroundHeading ?? '(heading not present anywhere on this page)',
      '',
      '--- outerHTML of the element containing that heading ---',
      probe.currentUsageSection ?? '(no such element)',
      '',
      `--- every <table> id on the page (${probe.tableIds.length} shown) ---`,
      probe.tableIds.join(', '),
      '',
      '--- first 6000 chars of the page text (which record is this really?) ---',
      probe.bodyText,
    ];
  } catch (err) {
    return ['', `=== missing-table probe failed: ${err instanceof Error ? err.message : String(err)} ===`];
  }
}
