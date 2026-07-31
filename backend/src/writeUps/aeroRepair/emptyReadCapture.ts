import type { Page } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

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

    console.warn(`[empty-read-capture] "${label}" — evidence saved: ${screenshotPath}, ${textPath}`);
  } catch (err) {
    console.warn(
      `[empty-read-capture] Failed to capture evidence for "${label}" (non-fatal, continuing): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}
