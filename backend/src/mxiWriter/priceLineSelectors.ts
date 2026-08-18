import type { Page } from 'playwright';

/**
 * Invoice Price Writer — new selectors, built from two real
 * `npx playwright codegen` recordings against production MXI
 * (`backend/discovery-invoice-write-recording.ts`,
 * `backend/discovery-invoice-recording.ts`), cross-checked against each
 * other to separate real required steps from exploratory recording noise
 * (confirmed directly with the user, not assumed):
 * - Recording #1's `Alt+9` before filling the price, and both recordings'
 *   several extra clicks on the price field before the real `.fill()`, are
 *   recording noise — recording #2 (the more complete one) fills directly
 *   with plain `.fill()`, no keyboard tricks, matching this project's own
 *   proven-safe pattern for masked fields (see updateEsdField's docstring
 *   for the original corruption incident that established `.fill()` as the
 *   right approach over simulated keystrokes).
 * - The "Cancel" link click and the trailing Password-field click after
 *   the final "OK" button in recording #2 are confirmed-with-the-user as
 *   incidental/exploratory, not real required steps.
 *
 * Reuses findOrderByNumber / updateEsdField / confirmEsdLineEdit /
 * reissueOrder from selectors.ts unchanged — this file only adds what
 * those don't already do: the Unit Price / Price Type fields, the serial
 * number cross-check, and the mid-flow re-authorization dialog.
 */

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Confirmed live (read-only diagnostic against a real production order,
 * P000BB8K): the line description on the Edit Lines page reads e.g.
 * "Repair VALVE SHUT-OFF CARGO (PN: VP0615E00, SN: L106604297) [...]" — the
 * exact "(PN: X, SN: Y)" pattern writeUps/shared/partOwnDetails.ts already
 * parses elsewhere in this codebase. Reads from Edit Lines' own body text
 * — no extra navigation needed, this is called right after
 * findOrderByNumber() has already landed there.
 */
export async function readLineSerialNumber(page: Page): Promise<string | null> {
  const bodyText = await page.locator('body').innerText();
  const match = bodyText.match(/\(PN:\s*[^,]+,\s*SN:\s*([^)]+)\)/);
  return match ? match[1].trim() : null;
}

/**
 * Reads the current Unit Price value. Prefix-matched + .first(), same
 * robustness convention as selectors.ts's aPromiseBy_ field (real line
 * index varies; this project's own established limitation is "only the
 * first matching line," not hardcoding index 1).
 */
export async function readUnitPrice(page: Page): Promise<string | null> {
  const field = page.locator('input[id^="idUnitPrice_"]').first();
  const value = await field.inputValue();
  return value.trim().length > 0 ? value : null;
}

/**
 * Confirmed from a real recording: plain .fill() on the Unit Price field
 * works directly, no clear-then-type sequence needed (unlike the
 * click->Backspace->type sequence that corrupted the ESD field early in
 * this project — .fill() is what fixed that, and recording #2 confirms the
 * same direct-fill approach works here too).
 */
export async function updateUnitPrice(page: Page, newPrice: string): Promise<void> {
  const field = page.locator('input[id^="idUnitPrice_"]').first();
  await field.fill(newPrice);
}

/** Confirmed always 'QUOTE' for this flow, per explicit user direction — not per-row logic. */
export async function updatePriceType(page: Page, priceType: string = 'QUOTE'): Promise<void> {
  const field = page.locator('select[id^="idPriceType_"]').first();
  await field.selectOption(priceType);
}

/**
 * Real, detectable page state (confirmed live: RO Details shows an
 * explicit "Authorization Status: ..." field) — not a guessed business
 * rule for when authorization is/isn't needed. A pure read, no click.
 */
export async function isReauthorizationNeeded(page: Page): Promise<boolean> {
  return (await page.getByRole('link', { name: 'Request Authorization' }).count()) > 0;
}

/**
 * The mid-flow credential re-entry dialog, confirmed from a real
 * recording (discovery-invoice-recording.ts): username is auto-filled (no
 * action needed), only the Password field
 * (getByRole('textbox', { name: 'Password:' })) needs filling. Uses the
 * same per-user MXI credential already threaded into this process's env
 * by mxiCredentialEnvOverrides() — never a new credential-entry UI.
 */
export async function performReauthorization(page: Page, password: string): Promise<void> {
  await page.getByRole('link', { name: 'Request Authorization' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);
  await page.getByRole('textbox', { name: 'Password:' }).fill(password);
  await pace(page);
  await page.getByRole('button', { name: 'OK' }).click();
  await pace(page);
}

/**
 * How many distinct order lines Edit Lines shows for this order — used to
 * detect the multi-line case (skip + flag rather than guess which line to
 * touch, per this project's existing "only first matching line" limitation
 * elsewhere). Counts Unit Price inputs, since exactly one exists per line.
 */
export async function countOrderLines(page: Page): Promise<number> {
  return page.locator('input[id^="idUnitPrice_"]').count();
}
