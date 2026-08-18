import type { Page } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

const DIAGNOSTICS_DIR = path.join('data', 'diagnostics');
const MAX_GRID_TEXT_LENGTH = 5000;

/**
 * Evidence capture on a vendor-code grid-wait timeout, per
 * CLAUDE_CODE_PROMPT_GRID_WAIT_FIX.md item 1 — converts an opaque 30s hang
 * into hard evidence: row count, the first ~10 rows' visible text, full
 * grid text (truncated), whether a modal/dialog/overlay is present, a
 * screenshot, and an HTML dump of the page. Deliberately best-effort, same
 * discipline as aeroRepair/emptyReadCapture.ts — a failure capturing
 * evidence must never crash or mask the real timeout error.
 *
 * Read-only: only ever calls page.screenshot()/page.content()/locator
 * reads, nothing that fills/submits/clicks. Structurally incapable of
 * crossing into a write, per the standing read/write-boundary lesson from
 * the earlier diagnostic incident.
 */
export async function captureVendorCodeGridDiagnostics(page: Page, vendorCode: string): Promise<{ screenshotPath: string; htmlPath: string } | null> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = `grid-wait-${vendorCode}-${timestamp}`;
    const screenshotPath = path.join(DIAGNOSTICS_DIR, `${basename}.png`);
    const htmlPath = path.join(DIAGNOSTICS_DIR, `${basename}.html`);

    await fs.mkdir(DIAGNOSTICS_DIR, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const html = await page.content();
    await fs.writeFile(htmlPath, html, 'utf-8');

    const details = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr'));
      const firstRowsText = rows.slice(0, 10).map((tr) => (tr.textContent ?? '').replace(/\s+/g, ' ').trim());
      // Best-effort "is something overlaying the page" signal: a fixed/
      // high-z-index element, or a jQuery-UI-style dialog class, present
      // and visible. Not a confirmed selector for any specific real
      // dialog — a coarse structural signal only, to be refined once real
      // evidence shows what (if anything) is actually there.
      const possibleOverlay = Array.from(document.querySelectorAll('.ui-dialog, [role="dialog"], [role="alertdialog"]')).find(
        (el) => (el as HTMLElement).offsetParent !== null,
      );
      return {
        totalRowCount: rows.length,
        firstRowsText,
        possibleOverlayFound: !!possibleOverlay,
        possibleOverlayText: possibleOverlay ? (possibleOverlay.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) : null,
        bodyTextLength: (document.body?.innerText ?? '').length,
      };
    });

    const bodyText = await page.locator('body').innerText();
    const truncatedBodyText = bodyText.length > MAX_GRID_TEXT_LENGTH ? bodyText.slice(0, MAX_GRID_TEXT_LENGTH) + '\n...[truncated]' : bodyText;

    const report = [
      `Vendor-code grid-wait timeout evidence capture`,
      `Vendor code: ${vendorCode}`,
      `Captured at: ${new Date().toISOString()}`,
      `URL: ${page.url()}`,
      `Total <tr> row count: ${details.totalRowCount}`,
      `Possible overlay/dialog present: ${details.possibleOverlayFound}${details.possibleOverlayText ? ` — "${details.possibleOverlayText}"` : ''}`,
      `Body text length: ${details.bodyTextLength}`,
      '',
      '=== First ~10 rows (raw text) ===',
      ...details.firstRowsText.map((t, i) => `[${i}] ${t}`),
      '',
      '=== Full body text (truncated) ===',
      truncatedBodyText,
    ].join('\n');
    const textPath = path.join(DIAGNOSTICS_DIR, `${basename}.txt`);
    await fs.writeFile(textPath, report, 'utf-8');

    log.warn({ vendorCode, screenshotPath, htmlPath, textPath, report }, '[grid-wait-diagnostics] evidence saved');
    return { screenshotPath, htmlPath };
  } catch (err) {
    log.warn(
      { vendorCode, errorMessage: err instanceof Error ? err.message : String(err) },
      '[grid-wait-diagnostics] Failed to capture evidence (non-fatal, continuing)',
    );
    return null;
  }
}
