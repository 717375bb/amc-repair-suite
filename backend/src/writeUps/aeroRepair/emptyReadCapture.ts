import type { Page } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

/**
 * Instrumentation-only, added specifically because a real "consistent
 * empty read" symptom (reported for 5013640's grid) could not be
 * reproduced across 18 live attempts in a dedicated diagnostic session —
 * DOM structure and read-before-populated timing were both directly ruled
 * out, but the real failure was never caught in the act. Rather than
 * assume "transient" and move on, every grid-read path that can produce
 * an empty/zero result treated as meaningful now captures hard evidence
 * (screenshot + raw page text) at the exact moment that happens, BEFORE
 * the caller acts on it — so the next real occurrence is diagnosable
 * directly, instead of requiring another after-the-fact reproduction
 * attempt (which the diagnostic session's own evidence suggests is
 * unlikely to succeed).
 *
 * Deliberately best-effort: a failure capturing evidence must never be
 * allowed to crash or alter the real flow this is instrumenting — caught
 * and logged, never rethrown. An empty read is rare in normal operation
 * (the whole reason this is worth capturing at all), so this adds no
 * meaningful noise or overhead to the common case.
 *
 * No retry/read behavior is changed by this file — purely observational.
 */
export async function captureEmptyReadEvidence(
  page: Page,
  label: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = `empty-read-${label}-${timestamp}`;
    const screenshotPath = path.join('data', `${basename}.png`);
    const textPath = path.join('data', `${basename}.txt`);

    await fs.mkdir('data', { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const bodyText = await page.locator('body').innerText();
    const report = [
      `Empty-read evidence capture: ${label}`,
      `Captured at: ${new Date().toISOString()}`,
      `URL: ${page.url()}`,
      `Context: ${JSON.stringify(context, null, 2)}`,
      '',
      '=== page.locator(\'body\').innerText() ===',
      bodyText,
    ].join('\n');
    await fs.writeFile(textPath, report, 'utf-8');

    log.warn({ label, screenshotPath, textPath }, '[empty-read-capture] evidence saved');
  } catch (err) {
    log.warn(
      { label, errorMessage: err instanceof Error ? err.message : String(err) },
      '[empty-read-capture] Failed to capture evidence (non-fatal, continuing)',
    );
  }
}

export interface VendorBidRowEvidence {
  index: number;
  text: string;
  html: string;
  hasRadio: boolean;
}

/**
 * CLAUDE_CODE_PROMPT_AERO_BUGS.md Defect 1, change 1 — every brake line that
 * reached the vendor-bid step failed (6/6), every wheel line succeeded
 * (5/5). REAL ROOT CAUSE CONFIRMED via a live production capture against
 * 90001201-2/DEC19-3132 (real timestamped diagnostic,
 * data/diagnostics/vendor-bid-timeout-2026-08-05T16-55-41-026Z.txt):
 * "Target repair link found in DOM at all: false" — the OLD raw-DOM
 * `a.textContent?.trim() === linkText` comparison matched ZERO elements,
 * even though grid/work-package-details/unassigned-tasks all resolved in
 * under a second (the page was genuinely, fully rendered). This is the same
 * whitespace-normalization class of bug already fixed elsewhere in this
 * project: Playwright's own accessible-name-based locator resolution (the
 * mechanism gridWait.ts's collectVendorBidRows now uses) normalizes
 * whitespace the same way `.innerText()` did when linkText was originally
 * captured; the hand-rolled raw `textContent` comparison did not, and for
 * this brake line's specific text it silently matched nothing.
 *
 * Takes the already-collected row evidence (from the CORRECT,
 * locator-based walk in gridWait.ts) rather than re-deriving it with a
 * second, separately-fallible raw-DOM query — so this capture can never
 * itself suffer the exact bug it exists to diagnose.
 *
 * Deliberately best-effort, same as captureEmptyReadEvidence — a capture
 * failure must never crash or alter the real flow it's instrumenting.
 */
export async function captureVendorBidDiagnostics(
  page: Page,
  linkText: string,
  rows: VendorBidRowEvidence[],
  targetLinkFound: boolean,
): Promise<void> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = `vendor-bid-timeout-${timestamp}`;
    const dir = path.join('data', 'diagnostics');
    await fs.mkdir(dir, { recursive: true });
    const screenshotPath = path.join(dir, `${basename}.png`);
    const textPath = path.join(dir, `${basename}.txt`);

    await page.screenshot({ path: screenshotPath, fullPage: true });

    const partSerialMatch = linkText.match(/\(PN: ([^,]+), SN: ([^)]+)\)/);
    const partNumber = partSerialMatch?.[1] ?? '(could not extract from linkText)';
    const serialNumber = partSerialMatch?.[2] ?? '(could not extract from linkText)';
    const description = linkText.replace(/^Repair /, '').replace(/\s*\(PN:.*$/, '');
    const radioRowCount = rows.filter((r) => r.hasRadio).length;

    const report = [
      'Vendor-bid wait timeout — structural diagnostics (Defect 1, change 1)',
      `Captured at: ${new Date().toISOString()}`,
      `URL: ${page.url()}`,
      `Part Number: ${partNumber}`,
      `Serial Number: ${serialNumber}`,
      `Description: ${description}`,
      `Line link text (verbatim): ${linkText}`,
      `Target repair link resolved via Playwright locator (getByRole exact): ${targetLinkFound}`,
      `Count of radio-bearing bid rows found: ${radioRowCount}`,
      `Total rows walked (main row through the line boundary): ${rows.length}`,
      '',
      '=== Row-by-row breakdown (main row first, then siblings in DOM order) ===',
      ...rows.flatMap((row) => [
        `--- Row ${row.index}${row.index === 0 ? ' (main row)' : ''} — hasRadio: ${row.hasRadio} ---`,
        `innerText: ${row.text}`,
        'outerHTML:',
        row.html,
        '',
      ]),
    ].join('\n');

    await fs.writeFile(textPath, report, 'utf-8');
    log.warn({ screenshotPath, textPath }, '[vendor-bid-diagnostics] evidence saved');
  } catch (err) {
    log.warn(
      { errorMessage: err instanceof Error ? err.message : String(err) },
      '[vendor-bid-diagnostics] Failed to capture evidence (non-fatal, continuing)',
    );
  }
}

/**
 * CLAUDE_CODE_PROMPT_AERO_BUGS.md Defect 2, change 5 — the current
 * "unassigned task present" branch has never been verified against a real
 * true positive, and it is about to be wired to a real WRITE action
 * (assigning the task to the work package). Mirrors captureEmptyReadEvidence
 * but for the positive case: screenshot + full body HTML dump (not just
 * innerText, since the real row/checkbox structure is still unconfirmed) +
 * verbatim innerText. Read-only — called before any assignment click.
 */
export async function captureUnassignedTaskPositiveDetection(
  page: Page,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = `unassigned-task-positive-${timestamp}`;
    const dir = path.join('data', 'diagnostics');
    await fs.mkdir(dir, { recursive: true });
    const screenshotPath = path.join(dir, `${basename}.png`);
    const textPath = path.join(dir, `${basename}.txt`);
    const htmlPath = path.join(dir, `${basename}.html`);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const bodyText = await page.locator('body').innerText();
    const bodyHtml = await page.locator('body').innerHTML();
    await fs.writeFile(htmlPath, bodyHtml, 'utf-8');

    const report = [
      'Unassigned-task POSITIVE detection — evidence capture (Defect 2, change 5)',
      `Captured at: ${new Date().toISOString()}`,
      `URL: ${page.url()}`,
      `Context: ${JSON.stringify(context, null, 2)}`,
      '',
      "=== page.locator('body').innerText() ===",
      bodyText,
    ].join('\n');
    await fs.writeFile(textPath, report, 'utf-8');

    log.warn({ screenshotPath, textPath, htmlPath }, '[unassigned-task-positive-detection] evidence saved');
  } catch (err) {
    log.warn(
      { errorMessage: err instanceof Error ? err.message : String(err) },
      '[unassigned-task-positive-detection] Failed to capture evidence (non-fatal, continuing)',
    );
  }
}
